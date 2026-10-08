"""
Second pass of the detail crops, from the large photos (the 5000px WebPs), keeping a
margin round each artwork instead of trimming to its edge, so the straightening is gentle
and any small error in the outline isn't visible, and the result is big enough to refine
with the corner-crop tool (/admin/crop/ or the table view's Detail column).

Same outline finding as make_details.py (prints: the paper sheet; paintings: rembg or the
plain backdrop). The outline is straightened and the margin is the photo's own surroundings
(frame, wall, backdrop), `--margin` percent of the long side on every side.
Nothing in the repo is touched: the results go to an output folder.

    scripts/py make_details_margin.py ~/Downloads/Edlef_Romeny_Paintings_Laure_09_2026_webp \\
        --out ~/Downloads/Edlef_details_margin/paintings --review ~/Downloads/Edlef_details_margin/review
    scripts/py make_details_margin.py ~/Downloads/Edlef_Romeny_Prints_Laure_09_2026_webp --prints --out …

Files that already have a result are skipped unless --force. Doubtful outlines are listed (CHECK)
and still written (suffix -check) so the corner tool can fix them.
"""

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_details as md  # noqa: E402
import measure_prints as mp  # noqa: E402


def outline(img, printy):
    """(quad in full-resolution pixels, checks, small image for review)"""
    H, W = img.shape[:2]
    scale = md.WORK_SIZE / max(H, W)
    small = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
    checks, quad, clean = [], None, False
    if printy:
        found = mp.find_sheet(small)
        if found:
            quad, clean = found
    if quad is None:
        backdrop = md.plain_backdrop(small)
        mask = md.backdrop_mask(small, backdrop) if backdrop is not None else (md.rembg_mask(small) > 128).astype(np.uint8) * 255
        quad, clean, share = md.quad_from_mask(mask)
        if quad is None:
            return None, ["no artwork found"], small, scale
        if share < 0.01:
            checks.append(f"artwork tiny ({share:.1%} of photo)")
    if not clean:
        checks.append("outline not a clean 4-corner shape")
    return quad / scale, checks, small, scale


def warp_margin(img, quad, margin, max_edge):
    w, h = mp.quad_size(quad)
    w, h = float(w), float(h)
    k = min(1.0, max_edge / (max(w, h) * (1 + 2 * margin)))
    w, h = w * k, h * k
    m = margin * max(w, h)
    ow, oh = int(round(w + 2 * m)), int(round(h + 2 * m))
    dst = np.array([[m, m], [m + w, m], [m + w, m + h], [m, m + h]], np.float32)
    mat = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    return cv2.warpPerspective(img, mat, (ow, oh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--out", required=True)
    ap.add_argument("--review", help="folder for contact sheets")
    ap.add_argument("--prints", action="store_true", help="the photos are prints on the burlap backdrop")
    ap.add_argument("--margin", type=float, default=5.0, help="percent of the long side kept on every side (default 5)")
    ap.add_argument("--max-edge", type=int, default=5000)
    ap.add_argument("--only", help="only files whose name contains this")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if args.review:
        os.makedirs(args.review, exist_ok=True)
    files = sorted(f for f in os.listdir(args.folder) if f.lower().endswith((".webp", ".jpg", ".jpeg", ".png", ".tif", ".tiff")))
    if args.only:
        files = [f for f in files if args.only in f]
    flagged, done, sheet, sheets = [], 0, [], 0
    for f in files:
        stem = os.path.splitext(f)[0]
        printy = args.prints or stem.startswith("print-")
        target = os.path.join(args.out, f"{stem}-margin.webp")
        checked = os.path.join(args.out, f"{stem}-margin-check.webp")
        if not args.force and (os.path.exists(target) or os.path.exists(checked)):
            continue
        img = cv2.imread(os.path.join(args.folder, f))
        if img is None:
            print(f"{f}: can't read")
            continue
        try:
            quad, checks, small, scale = outline(img, printy)
        except Exception as e:
            quad, checks, small, scale = None, [f"error: {e}"], None, 1
        if quad is None:
            print(f"{f}: CHECK {'; '.join(checks)}", flush=True)
            flagged.append((f, checks))
            continue
        out = warp_margin(img, quad, args.margin / 100, args.max_edge)
        cv2.imwrite(checked if checks else target, out, [cv2.IMWRITE_WEBP_QUALITY, 90])
        done += 1
        print(f"{f}: {'CHECK ' + '; '.join(checks) if checks else 'ok'}  {out.shape[1]}x{out.shape[0]}", flush=True)
        if checks:
            flagged.append((f, checks))
        if args.review:
            vis = small.copy()
            cv2.polylines(vis, [(quad * scale).astype(np.int32)], True, (0, 0, 255) if checks else (0, 200, 0), 3)
            th = 300
            row = [cv2.resize(t, (max(1, int(t.shape[1] * th / t.shape[0])), th)) for t in (vis, out)]
            tile = np.hstack([np.pad(r, ((0, 0), (0, 6), (0, 0)), constant_values=255) for r in row])
            cv2.putText(tile, f[:60], (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 3)
            cv2.putText(tile, f[:60], (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
            sheet.append(tile)
            if len(sheet) == 12:
                sheets += 1
                md.write_sheet(sheet, os.path.join(args.review, f"{os.path.basename(args.out)}-sheet-{sheets:03d}.jpg"))
                sheet = []
    if args.review and sheet:
        sheets += 1
        md.write_sheet(sheet, os.path.join(args.review, f"{os.path.basename(args.out)}-sheet-{sheets:03d}.jpg"))
    print(f"\n{done} written, {len(flagged)} flagged")


if __name__ == "__main__":
    main()
