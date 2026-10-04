"""
Measure prints photographed on the burlap backdrop and write w/h (cm) into
their markdown frontmatter.

The camera, lens and backdrop are fixed for the whole print shoot, so one
pixels-per-cm scale applies to every photo. Calibrate it once from a print
whose sheet you have measured by hand:

    scripts/venv/bin/python scripts/measure_prints.py --calibrate print-038 50 65

That prints a px/cm value. Then measure everything (dry run first):

    scripts/venv/bin/python scripts/measure_prints.py --px-per-cm 14.2 --debug /tmp/measure
    scripts/venv/bin/python scripts/measure_prints.py --px-per-cm 14.2 --write

For each work it detects
  - the sheet: the large bright, low-saturation quad on the brown burlap
  - the image: the printed area inside the sheet (ink differs from the paper)
and writes w/h for the one chosen with --measure (default: image).
"""

import argparse
import glob
import os
import re
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKS = os.path.join(ROOT, "src", "content", "works")

# Detection runs on a downscaled copy; results are scaled back to full res.
WORK_WIDTH = 1500


def read_frontmatter(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.S)
    if not m:
        return text, None
    return text, m


def frontmatter_value(fm, key):
    m = re.search(rf"^{key}:\s*(.*)$", fm, re.M)
    if not m:
        return None
    v = m.group(1).strip().strip("'\"")
    return None if v in ("", "null", "~") else v


def image_for(md_path):
    _, m = read_frontmatter(md_path)
    if not m:
        return None
    fm = m.group(1)
    img = frontmatter_value(fm, "image")
    if not img:
        # fall back to first entry of `images:`
        lst = re.search(r"^images:\s*\n\s*-\s*(.+)$", fm, re.M)
        img = lst.group(1).strip().strip("'\"") if lst else None
    if not img:
        return None
    return os.path.join(ROOT, img.lstrip("/"))


def order_corners(pts):
    """Top-left, top-right, bottom-right, bottom-left."""
    pts = np.asarray(pts, np.float32).reshape(-1, 2)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)


def quad_size(q):
    """Width/height of an ordered quad, averaging opposite sides."""
    side = lambda a, b: float(np.linalg.norm(q[a] - q[b]))
    return (side(0, 1) + side(3, 2)) / 2, (side(0, 3) + side(1, 2)) / 2


def find_sheet(img):
    """Return the sheet's four corners (working-resolution px), or None."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    s, v = hsv[..., 1], hsv[..., 2]
    # Burlap colour, sampled from a band along the photo's edges
    b = int(0.05 * img.shape[0])
    border = np.ones(img.shape[:2], bool)
    border[b:-b, b:-b] = False
    bg_s, bg_v = np.median(s[border]), np.median(v[border])
    # Paper (white or cream) is lighter and less saturated than the burlap.
    # The burlap's white flecks are small and get removed by the opening.
    score = (v - bg_v) - (s - bg_s)
    mask = (score > 45).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((11, 11), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    # Paper split up by a big dark print: merge the large pieces
    biggest = max(cv2.contourArea(c) for c in contours)
    pts = np.vstack([c for c in contours if cv2.contourArea(c) > 0.1 * biggest])
    hull = cv2.convexHull(pts)
    quad = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
    if len(quad) != 4:
        quad = cv2.boxPoints(cv2.minAreaRect(hull))
    return order_corners(quad)


def find_image(sheet):
    """Bounding box (x, y, w, h) of the printed area in the rectified sheet."""
    h, w = sheet.shape[:2]
    m = int(0.03 * min(w, h))  # ignore the sheet edge: shadows, fingers, deckle
    inner = np.zeros((h, w), np.uint8)
    inner[m:h - m, m:w - m] = 255

    lab = cv2.cvtColor(sheet, cv2.COLOR_BGR2LAB).astype(np.float32)
    paper = np.median(lab[inner > 0], axis=0)
    dist = np.linalg.norm(lab - paper, axis=2)
    ink = ((dist > 28) & (inner > 0)).astype(np.uint8) * 255
    # Drop pencil signatures/edition numbers, then merge the printed area
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    # Pale etchings and watercolours break up into several patches: take the
    # union of every patch that isn't a speck. Patches running into the margin
    # are paper shading, unless that's all there is (image printed to the edge).
    def inside(c):
        x, y, cw, ch = cv2.boundingRect(c)
        return x > m and y > m and x + cw < w - m and y + ch < h - m

    keep = [c for c in contours if cv2.contourArea(c) > 0.001 * w * h]
    keep = [c for c in keep if inside(c)] or [max(contours, key=cv2.contourArea)]
    if not keep or sum(cv2.contourArea(c) for c in keep) < 0.01 * w * h:
        return None
    return cv2.boundingRect(np.vstack(keep))


def measure(path, debug_dir=None):
    full = cv2.imread(path)
    if full is None:
        raise RuntimeError(f"cannot read {path}")
    scale = full.shape[1] / WORK_WIDTH
    img = cv2.resize(full, (WORK_WIDTH, round(full.shape[0] / scale)), interpolation=cv2.INTER_AREA)

    quad = find_sheet(img)
    if quad is None:
        return None
    sw, sh = quad_size(quad)
    # Warp the sheet upright so the image box is axis-aligned and keystone-free
    dst = np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], np.float32)
    M = cv2.getPerspectiveTransform(quad, dst)
    sheet = cv2.warpPerspective(img, M, (round(sw), round(sh)))
    box = find_image(sheet)

    result = {"sheet": (sw * scale, sh * scale), "image": None, "shape": full.shape[:2]}
    if box:
        result["image"] = (box[2] * scale, box[3] * scale)

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        out = img.copy()
        cv2.polylines(out, [quad.astype(np.int32)], True, (0, 255, 0), 3)
        if box:
            x, y, bw, bh = box
            corners = np.array([[[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]]], np.float32)
            back = cv2.perspectiveTransform(corners, np.linalg.inv(M))
            cv2.polylines(out, [back.astype(np.int32)], True, (0, 0, 255), 3)
        name = os.path.splitext(os.path.basename(path))[0]
        cv2.imwrite(os.path.join(debug_dir, f"{name}.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return result


def set_dims(md_path, w, h):
    text, m = read_frontmatter(md_path)
    fm = m.group(1)
    for key, val in (("w", w), ("h", h)):
        line = f"{key}: {val:g}"
        if re.search(rf"^{key}:.*$", fm, re.M):
            fm = re.sub(rf"^{key}:.*$", line, fm, count=1, flags=re.M)
        else:
            fm += "\n" + line
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"---\n{fm}\n---\n" + text[m.end():])


def round_to(x, step):
    return round(x / step) * step


def resolve(names):
    if not names:
        return sorted(glob.glob(os.path.join(WORKS, "print-*.md")))
    out = []
    for n in names:
        if os.path.exists(n):
            out.append(n)
        else:
            out.append(os.path.join(WORKS, n if n.endswith(".md") else n + ".md"))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("works", nargs="*", help="work slugs or .md paths (default: all print-*.md)")
    ap.add_argument("--calibrate", nargs=3, metavar=("WORK", "W_CM", "H_CM"),
                    help="derive px/cm from a work whose sheet size you measured")
    ap.add_argument("--px-per-cm", type=float, help="scale from --calibrate")
    ap.add_argument("--measure", choices=["image", "sheet"], default="image",
                    help="which rectangle goes into w/h (default: image)")
    ap.add_argument("--round", type=float, default=0.5, help="round cm to this step (default 0.5)")
    ap.add_argument("--write", action="store_true", help="update the markdown files (default: dry run)")
    ap.add_argument("--force", action="store_true", help="overwrite existing w/h values")
    ap.add_argument("--debug", metavar="DIR", help="write overlay images (green=sheet, red=image)")
    args = ap.parse_args()

    if args.calibrate:
        work, wcm, hcm = args.calibrate
        md = resolve([work])[0]
        r = measure(image_for(md), args.debug)
        if not r:
            sys.exit(f"no sheet found in {work}")
        sw, sh = r["sheet"]
        pw, ph = sw / float(wcm), sh / float(hcm)
        print(f"sheet {sw:.0f} x {sh:.0f} px -> {pw:.2f} / {ph:.2f} px/cm (w / h)")
        if abs(pw - ph) / max(pw, ph) > 0.04:
            print("warning: w and h disagree by >4% (W/H swapped, or the photo has perspective)")
        print(f"--px-per-cm {(pw + ph) / 2:.2f}")
        return

    if not args.px_per_cm:
        ap.error("--px-per-cm is required (get it with --calibrate)")

    ref_shape = None
    for md in resolve(args.works):
        slug = os.path.splitext(os.path.basename(md))[0]
        img_path = image_for(md)
        if not img_path or not os.path.exists(img_path):
            print(f"{slug:<16} skip: no image")
            continue
        _, m = read_frontmatter(md)
        has = frontmatter_value(m.group(1), "w") or frontmatter_value(m.group(1), "h")

        r = measure(img_path, args.debug)
        if not r:
            print(f"{slug:<16} skip: no sheet detected")
            continue
        ref_shape = ref_shape or r["shape"]
        flag = "  (!) different photo size, scale may not apply" if r["shape"] != ref_shape else ""

        cm = lambda wh: tuple(round_to(v / args.px_per_cm, args.round) for v in wh)
        sheet = cm(r["sheet"])
        image = cm(r["image"]) if r["image"] else None
        img_s = f"{image[0]:g} x {image[1]:g}" if image else "?"
        print(f"{slug:<16} sheet {sheet[0]:g} x {sheet[1]:g}   image {img_s} cm{flag}")

        chosen = image if args.measure == "image" else sheet
        if not args.write:
            continue
        if not chosen:
            print(f"{'':<16} not written: no {args.measure} detected")
        elif has and not args.force:
            print(f"{'':<16} not written: has w/h (use --force)")
        else:
            set_dims(md, *chosen)


if __name__ == "__main__":
    main()
