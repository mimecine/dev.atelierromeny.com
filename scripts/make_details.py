"""
Make a "detail" image for each work: the artwork alone, cut out of its photo,
straightened, without frame or mat. Saved as src/media/works/<slug>-detail.webp
and added as the last of the work's `images` (the last image in the work page's strip).

Source photo: the work's `cleanest` photo if set (even if hidden), else its chosen thumbnail (thumbnail: n over its images, not counting
the detail), else its first image, else old_image. (A work whose only image is its
detail uses old_image.)

Outline of the artwork:
  - prints (on the burlap backdrop): the paper sheet, found like measure_prints.py
  - paintings: rembg (isnet-general-use) separates the artwork from the wall /
    backdrop; thin things (chair legs, easels) are removed, the largest shape is
    fitted with a 4-corner outline
Then the outline is warped to a flat rectangle at full resolution, and the frame
(paintings) or mat (prints, the printed area as measure_prints.py finds it) is
trimmed off.

Review first, write afterwards:

    scripts/make-details --review /tmp/details 127-la-serviette-bleue print-003
    scripts/make-details --review /tmp/details --all     # contact sheets of everything
    scripts/make-details --write --all                   # detail images, added to `images`

Works that already have a `detail` are skipped unless named or --force is given.
Doubtful results are listed (CHECK) and not written unless --include-flagged.
"""

import argparse
import glob
import os
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import measure_prints as mp  # noqa: E402  (find_sheet, find_image, no_margin, order_corners, quad_size)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKS = os.path.join(ROOT, "src", "content", "works")
MEDIA = os.path.join(ROOT, "src", "media", "works")
WORK_SIZE = 1200  # detection resolution (long side)
MAX_OUT = 3000
FRAME_MAX = 0.18  # a frame is at most this share of the artwork's width/height

_session = None


def rembg_mask(img_bgr):
    global _session
    from PIL import Image
    from rembg import new_session, remove

    if _session is None:
        _session = new_session("isnet-general-use")
    rgb = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    return np.array(remove(rgb, session=_session, only_mask=True))


# ---------------------------------------------------------------- frontmatter


def frontmatter(md):
    text = open(md, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.S)
    return (m.group(1) if m else ""), text


def scalar(fm, key):
    m = re.search(rf"^{key}:[ \t]*(.*)$", fm, re.M)
    if not m:
        return None
    v = m.group(1).strip().strip("'\"")
    return None if v in ("", "null", "~") else v


def listing(fm, key):
    m = re.search(rf"^{key}:\n((?:[ \t]+-[^\n]*\n?)+)", fm, re.M)
    if not m:
        return []
    return [x.strip().strip("'\"") for x in re.findall(r"^[ \t]+-[ \t]*(.*)$", m.group(1), re.M)]


def source_image(fm):
    # `cleanest` (set with the table view's Cleanest checkbox) wins, even if hidden.
    clean = scalar(fm, "cleanest")
    if clean and not is_detail(clean) and os.path.exists(os.path.join(ROOT, clean.lstrip("/"))):
        return clean
    # The detail (last of `images`) is never a source. Works that only had an old photo
    # have just their detail: make it from the old photo, not from itself.
    images = [p for p in listing(fm, "images") if not is_detail(p)]
    if not images:
        old = scalar(fm, "old_image")
        return old
    n = scalar(fm, "thumbnail")
    i = int(n) - 1 if n and n.isdigit() and 1 <= int(n) <= len(images) else 0
    return images[i]


def is_detail(path):
    return path.endswith("-detail.webp")


def has_detail(fm):
    return any(is_detail(p) for p in listing(fm, "images"))


def is_print(fm, src):
    return "/print-" in src or (scalar(fm, "categories") or "").lower() in ("works on paper", "print")


def set_detail(md, value):
    """Make `value` the last of the work's `images` (replacing an earlier detail)."""
    fm, text = frontmatter(md)
    paths = [p for p in listing(fm, "images") if not is_detail(p)] + [value]
    block = "images:\n" + "\n".join(f"  - '{p}'" for p in paths)
    m = re.search(r"^images:[ \t]*\n(?:[ \t]+-.*(?:\n|$))*", fm, re.M)
    if m:
        fm2 = fm[: m.start()] + block + ("\n" if m.group(0).endswith("\n") else "") + fm[m.end():]
    else:
        fm2 = fm + "\n" + block
    open(md, "w", encoding="utf-8").write(text.replace(fm, fm2, 1))


# ---------------------------------------------------------------- outline


def plain_backdrop(small):
    """Close-ups shot against a plain, light backdrop: the photo's border is uniform."""
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = small.shape[:2]
    b = int(0.04 * min(h, w))
    border = np.ones((h, w), bool)
    border[b:-b, b:-b] = False
    px = lab[border]
    med = np.median(px, axis=0)
    if np.percentile(np.linalg.norm(px - med, axis=1), 50) < 18 and med[0] > 150:
        return med
    return None


def backdrop_mask(small, backdrop):
    """Everything that differs clearly from the backdrop colour."""
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    return ((np.linalg.norm(lab - backdrop, axis=2) > 30) * 255).astype(np.uint8)


def quad_from_mask(mask):
    """Largest solid shape in a 0/255 mask, fitted with 4 corners. Returns (quad, clean, area share)."""
    h, w = mask.shape
    k = max(5, int(0.012 * max(w, h)) | 1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    # Opening with a large kernel removes chair legs, easels and other thin parts
    k2 = max(9, int(0.03 * max(w, h)) | 1)
    solid = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((k2, k2), np.uint8))
    contours, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, False, 0
    c = max(contours, key=cv2.contourArea)
    hull = cv2.convexHull(c)
    hull_area = cv2.contourArea(hull)
    share = hull_area / (w * h)
    # A 4-corner fit only counts if it covers the shape well (no corner cut off)
    for eps in (0.01, 0.02, 0.03, 0.05, 0.08):
        quad = cv2.approxPolyDP(hull, eps * cv2.arcLength(hull, True), True)
        if len(quad) == 4 and cv2.isContourConvex(quad):
            q = mp.order_corners(quad)
            if overlap(q, hull, (h, w)) > 0.95:
                return q, True, share
    return mp.order_corners(cv2.boxPoints(cv2.minAreaRect(hull))), False, share


def overlap(quad, hull, shape):
    """Intersection over union of two polygons, rasterised."""
    a = np.zeros(shape, np.uint8)
    b = np.zeros(shape, np.uint8)
    cv2.fillPoly(a, [quad.astype(np.int32)], 1)
    cv2.fillPoly(b, [hull.reshape(-1, 2).astype(np.int32)], 1)
    union = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / union if union else 0


def warp(img, quad):
    w, h = mp.quad_size(quad)
    w, h = int(round(w)), int(round(h))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad, dst), (w, h), flags=cv2.INTER_CUBIC)


# ---------------------------------------------------------------- frame / mat


def frame_depths(flat):
    """How deep (px) the frame reaches in from each side of a straightened
    painting: (top, right, bottom, left), 0 = no frame.

    A frame's inner edge is a straight line running the whole length of a side,
    so along it nearly every pixel changes colour from one line to the next;
    lines through the painting itself change only here and there. For each side
    the candidate lines are collected; frames are the same width all round, so
    the sides agree on a common depth."""
    h, w = flat.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(flat, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)

    def lines(side):
        if side in ("top", "bottom"):
            seq = lab if side == "top" else lab[::-1]
            return seq[:, int(0.1 * w):int(0.9 * w)], int(FRAME_MAX * h)
        seq = lab.transpose(1, 0, 2) if side == "left" else lab.transpose(1, 0, 2)[::-1]
        return seq[:, int(0.1 * h):int(0.9 * h)], int(FRAME_MAX * w)

    candidates = []
    for side in ("top", "right", "bottom", "left"):
        seq, depth_max = lines(side)
        step = 2
        change = np.linalg.norm(seq[step:depth_max + step] - seq[:depth_max], axis=2)  # (depth, along)
        consistency = (change > 14).mean(axis=1)
        consistency = np.convolve(consistency, np.ones(3) / 3, mode="same")
        peaks = [
            d + step
            for d in range(1, len(consistency) - 1)
            if consistency[d] >= 0.42 and consistency[d] >= consistency[d - 1] and consistency[d] >= consistency[d + 1]
        ]
        # merge peaks closer than ~0.6% (one edge spans a few lines)
        merged = []
        for d in peaks:
            if merged and d - merged[-1] < max(4, 0.006 * min(w, h)):
                merged[-1] = d
            else:
                merged.append(d)
        candidates.append([d for d in merged if d > 0.01 * min(w, h)])

    deepest = sorted(c[-1] for c in candidates if c)
    if len(deepest) < 3:  # a frame shows on (at least) three sides
        return [0, 0, 0, 0]
    target = deepest[len(deepest) // 2]
    tol = max(8, 0.35 * target)
    out = []
    for c in candidates:
        near = [d for d in c if abs(d - target) <= tol]
        out.append(max(near) if near else int(target))
    return out


def trim_painting(flat):
    t, r, b, l = frame_depths(flat)
    pad = int(0.004 * min(flat.shape[:2]))  # a hair more, to lose the frame's inner shadow
    h, w = flat.shape[:2]
    if max(t, r, b, l) == 0:
        return flat, (0, 0, 0, 0)
    t, r, b, l = [d + pad if d else 0 for d in (t, r, b, l)]
    return flat[t:h - b, l:w - r], (t, r, b, l)


def trim_print(flat):
    if mp.no_margin(flat):
        return flat, None
    box, edges, fill = mp.find_image(flat)
    if box is None or fill < mp.FILL_MIN:
        return flat, None
    x, y, bw, bh = box
    return flat[y:y + bh, x:x + bw], box


# ---------------------------------------------------------------- per work


def process(md, src_path, printy):
    """Returns (detail image, review image, list of CHECK reasons)."""
    img = cv2.imread(src_path)
    if img is None:
        from PIL import Image

        img = cv2.cvtColor(np.array(Image.open(src_path).convert("RGB")), cv2.COLOR_RGB2BGR)
    H, W = img.shape[:2]
    scale = WORK_SIZE / max(H, W)
    small = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
    checks = []

    quad, clean = None, False
    if printy:
        found = mp.find_sheet(small)
        if found:
            quad, clean = found
    if quad is None:
        backdrop = plain_backdrop(small)
        if backdrop is not None:
            mask = backdrop_mask(small, backdrop)
        else:
            mask = (rembg_mask(small) > 128).astype(np.uint8) * 255
        quad, clean, share = quad_from_mask(mask)
        if quad is None:
            return None, small, ["no artwork found"]
        if share < 0.01:
            checks.append(f"artwork tiny ({share:.1%} of photo)")
    if not clean:
        checks.append("outline not a clean 4-corner shape")

    flat = warp(img, quad / scale)
    fw, fh = flat.shape[1], flat.shape[0]
    if min(fw, fh) < 150:
        checks.append(f"result small ({fw}x{fh})")
    ratio = max(fw, fh) / max(1, min(fw, fh))
    if ratio > 3:
        checks.append(f"odd proportions ({ratio:.1f}:1)")

    if printy:
        detail, box = trim_print(flat)
    else:
        detail, depths = trim_painting(flat)
    if min(detail.shape[:2]) < 100:
        checks.append("trimmed to almost nothing")
        detail = flat

    s = MAX_OUT / max(detail.shape[:2])
    if s < 1:
        detail = cv2.resize(detail, (int(detail.shape[1] * s), int(detail.shape[0] * s)), interpolation=cv2.INTER_AREA)

    # review: photo with the outline, the straightened artwork, the detail
    vis = small.copy()
    cv2.polylines(vis, [quad.astype(np.int32)], True, (0, 0, 255) if checks else (0, 200, 0), 3)
    tiles = [vis, flat, detail]
    th = 300
    row = [cv2.resize(t, (max(1, int(t.shape[1] * th / t.shape[0])), th)) for t in tiles]
    review = np.hstack([np.pad(r, ((0, 0), (0, 6), (0, 0)), constant_values=255) for r in row])
    return detail, review, checks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("works", nargs="*", help="work slugs (file names without .md)")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--review", help="folder for review images (contact sheets)")
    ap.add_argument("--write", action="store_true", help="save detail images and add them as the last of `images`")
    ap.add_argument("--force", action="store_true", help="redo works that already have a detail")
    ap.add_argument("--include-flagged", action="store_true")
    args = ap.parse_args()

    if args.all:
        mds = sorted(glob.glob(os.path.join(WORKS, "*.md")))
    else:
        mds = [os.path.join(WORKS, f"{w}.md") for w in args.works]
    if not mds:
        ap.error("name some works or use --all")
    if args.review:
        os.makedirs(args.review, exist_ok=True)

    flagged, done, skipped = [], 0, 0
    sheet, sheets = [], 0
    for md in mds:
        slug = os.path.basename(md)[:-3]
        fm, _ = frontmatter(md)
        if has_detail(fm) and not (args.force or not args.all):
            skipped += 1
            continue
        src = source_image(fm)
        if not src:
            continue
        src_path = os.path.join(ROOT, src.lstrip("/"))
        if not os.path.exists(src_path):
            print(f"{slug}: source missing ({src})")
            continue
        try:
            detail, review, checks = process(md, src_path, is_print(fm, src))
        except Exception as e:  # keep going through the batch
            detail, review, checks = None, None, [f"error: {e}"]
        status = "CHECK " + "; ".join(checks) if checks else "ok"
        print(f"{slug}: {status}", flush=True)
        if checks:
            flagged.append((slug, checks))
        if args.review and review is not None:
            label = review.copy()
            cv2.putText(label, f"{slug}  {status}"[:110], (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 3)
            cv2.putText(label, f"{slug}  {status}"[:110], (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
            sheet.append(label)
            if len(sheet) == 12:
                sheets += 1
                write_sheet(sheet, os.path.join(args.review, f"sheet-{sheets:03d}.jpg"))
                sheet = []
        if args.write and detail is not None and (not checks or args.include_flagged):
            name = f"{slug}-detail.webp"
            cv2.imwrite(os.path.join(MEDIA, name), detail, [cv2.IMWRITE_WEBP_QUALITY, 90])
            set_detail(md, f"/src/media/works/{name}")
            done += 1
    if args.review and sheet:
        sheets += 1
        write_sheet(sheet, os.path.join(args.review, f"sheet-{sheets:03d}.jpg"))
    print(f"\n{done} written, {len(flagged)} flagged, {skipped} skipped (already have a detail)")
    for slug, checks in flagged:
        print(f"  CHECK {slug}: {'; '.join(checks)}")


def write_sheet(rows, path):
    w = max(r.shape[1] for r in rows)
    padded = [np.pad(r, ((0, 6), (0, w - r.shape[1]), (0, 0)), constant_values=255) for r in rows]
    cv2.imwrite(path, np.vstack(padded), [cv2.IMWRITE_JPEG_QUALITY, 80])


if __name__ == "__main__":
    main()
