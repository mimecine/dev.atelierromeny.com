"""
Turn phone shots of old photo prints (lying on the linen backdrop) into clean pictures
for the Photos section: find the print, straighten it, keep a margin of linen around
it as a mat, turn it the right way up, and save a WebP (at most 3000px).

Rotation can't be read from the pixels, so it comes from a small table you fill in by
looking at the review sheet: ROTATE in scripts/pictures-rotate.json, degrees clockwise
per file name (0, 90, 180, 270).

    scripts/venv/bin/python scripts/make_pictures.py --review /tmp/pics src/media/photos/*.jpg
    scripts/venv/bin/python scripts/make_pictures.py --write --out src/media/photos src/media/photos/*.jpg

Options: --margin 0.06 (mat, as a share of the print's shorter side).
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_details as md  # noqa: E402  (rembg_mask, quad_from_mask, order_corners)
import measure_prints as mp  # noqa: E402  (quad_size)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROTATIONS = os.path.join(ROOT, "scripts", "pictures-rotate.json")
# Per-file detection overrides, e.g. {"PXL_…": {"method": "backdrop", "threshold": 40}}
FIXES = os.path.join(ROOT, "scripts", "pictures-fix.json")
WORK = 1200
MAX_OUT = 3000


def load(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def find_print(img, method="rembg", threshold=30):
    """Corners of the photo print (full-resolution px), and whether the outline is clean.
    method: "rembg" (AI cut-out), "backdrop" (differs from the linen colour), or "both"
    (union of the two, for prints with pale areas close to the linen)."""
    s = WORK / max(img.shape[:2])
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    masks = []
    if method in ("rembg", "both"):
        masks.append((md.rembg_mask(small) > 128).astype(np.uint8) * 255)
    if method in ("backdrop", "both"):
        lab = cv2.cvtColor(cv2.GaussianBlur(small, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
        h, w = small.shape[:2]
        b = int(0.04 * min(h, w))
        border = np.ones((h, w), bool)
        border[b:-b, b:-b] = False
        linen = np.median(lab[border], axis=0)
        masks.append(((np.linalg.norm(lab - linen, axis=2) > threshold) * 255).astype(np.uint8))
    mask = masks[0] if len(masks) == 1 else cv2.bitwise_or(*masks)
    quad, clean, share = md.quad_from_mask(mask)
    if quad is None:
        return None, False
    if not clean:
        # prints are rectangles: the smallest rotated box around the shape is a good fit
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(contours, key=cv2.contourArea)
        quad = mp.order_corners(cv2.boxPoints(cv2.minAreaRect(c)))
    return quad / s, clean


def with_margin(quad, margin):
    """The quad grown outwards by `margin` × its shorter side (a perspective-correct
    margin is overkill for prints lying flat)."""
    w, h = mp.quad_size(quad)
    pad = margin * min(w, h)
    center = quad.mean(axis=0)
    out = []
    for p in quad:
        v = p - center
        # move each corner out along both of its edges' normals: scale the diagonal
        n = np.linalg.norm(v)
        out.append(center + v * (n + pad * 1.4142) / n)
    return np.array(out, np.float32)


def warp(img, quad):
    w, h = mp.quad_size(quad)
    w, h = int(round(w)), int(round(h))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad, dst), (w, h),
                               flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def rotate(img, degrees):
    return {
        0: img,
        90: cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE),
        180: cv2.rotate(img, cv2.ROTATE_180),
        270: cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE),
    }[degrees % 360]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--review", help="folder for a numbered contact sheet")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--out", default=os.path.join(ROOT, "src", "media", "photos"))
    ap.add_argument("--margin", type=float, default=0.06)
    args = ap.parse_args()

    rotations = json.load(open(ROTATIONS)) if os.path.exists(ROTATIONS) else {}
    fixes = json.load(open(FIXES)) if os.path.exists(FIXES) else {}
    tiles, flagged = [], []
    for i, path in enumerate(sorted(args.files), 1):
        name = os.path.splitext(os.path.basename(path))[0]
        img = load(path)
        quad, clean = find_print(img, **fixes.get(name, {}))
        if quad is None:
            print(f"{i:2d} {name}: CHECK no print found")
            flagged.append(name)
            continue
        out = rotate(warp(img, with_margin(quad, args.margin)), rotations.get(name, 0))
        s = MAX_OUT / max(out.shape[:2])
        if s < 1:
            out = cv2.resize(out, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        status = "ok" if clean else "ok (box fit)"
        print(f"{i:2d} {name}: {status} {out.shape[1]}x{out.shape[0]} rot {rotations.get(name, 0)}")
        if args.review:
            t = cv2.resize(out, (int(out.shape[1] * 260 / out.shape[0]), 260))
            cv2.putText(t, str(i), (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 4)
            cv2.putText(t, str(i), (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 200), 2)
            tiles.append(t)
        if args.write:
            slug = name.lower().replace(".mp", "").replace("_", "-")
            cv2.imwrite(os.path.join(args.out, f"{slug}.webp"), out, [cv2.IMWRITE_WEBP_QUALITY, 88])
    if args.review and tiles:
        os.makedirs(args.review, exist_ok=True)
        rows, row, width = [], [], 0
        for t in tiles:
            if width + t.shape[1] > 2400 and row:
                rows.append(row)
                row, width = [], 0
            row.append(t)
            width += t.shape[1] + 6
        rows.append(row)
        W = max(sum(t.shape[1] + 6 for t in r) for r in rows)
        sheet = np.vstack([np.hstack([np.pad(t, ((3, 3), (3, 3), (0, 0)), constant_values=230) for t in r] + [np.full((266, W - sum(t.shape[1] + 6 for t in r), 3), 230, np.uint8)]) for r in rows])
        cv2.imwrite(os.path.join(args.review, "pictures.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if flagged:
        print("flagged:", " ".join(flagged))


if __name__ == "__main__":
    main()
