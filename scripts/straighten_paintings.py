#!/usr/bin/env python3
"""
straighten_paintings.py

Batch-processes photos of paintings/framed art: removes the background,
finds the (skewed/rotated) frame edges, and perspective-warps the result
into a clean flat rectangle.

Fully local — no API calls, no per-image cost. Uses:
  - rembg (U^2-Net) for background segmentation
  - OpenCV for contour/corner detection + perspective warp

Install:
    pip install rembg opencv-python-headless pillow numpy onnxruntime

Usage:
    python straighten_paintings.py --input ./photos --output ./straightened
    python straighten_paintings.py --input ./photos --output ./straightened --inset 3
    python straighten_paintings.py --input ./photos --output ./straightened --model isnet-general-use

Notes:
  - First run downloads the model weights once (~176MB for u2net), then
    it's cached locally and works offline.
  - Images where a clean 4-point frame can't be found automatically fall
    back to a rotated-bounding-box crop, and are ALSO listed in
    review_needed.txt in the output folder so you can eyeball just those
    instead of all 500.
  - --inset lets you crop inward by N% after warping, useful if you want
    to trim the frame itself and keep only the canvas.
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

VALID_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".tif", ".tiff"}


def order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype="float32")


def find_quad(mask: np.ndarray):
    """Try to reduce the largest mask contour to a clean 4-point polygon.
    Returns (points, method) where method is '4pt' or 'minAreaRect', or
    (None, None) if no usable contour was found at all.
    """
    _, thresh = cv2.threshold(mask, 128, 255, cv2.THRESH_BINARY)
    # close small gaps/holes so the outline is one clean blob
    kernel = np.ones((7, 7), np.uint8)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, None

    c = max(contours, key=cv2.contourArea)
    if cv2.contourArea(c) < 0.05 * mask.shape[0] * mask.shape[1]:
        # segmentation likely failed / found something tiny — bail out
        return None, None

    peri = cv2.arcLength(c, True)
    for frac in np.linspace(0.005, 0.06, 60):
        approx = cv2.approxPolyDP(c, frac * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx.reshape(4, 2).astype("float32"), "4pt"

    # fallback: rotated bounding box (handles simple rotation, not skew)
    rect = cv2.minAreaRect(c)
    box = cv2.boxPoints(rect)
    return box.astype("float32"), "minAreaRect"


def warp_from_quad(img: np.ndarray, pts: np.ndarray) -> np.ndarray:
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    width, height = max(width, 1), max(height, 1)

    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype="float32",
    )
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, M, (width, height))


def apply_inset(img: np.ndarray, pct: float) -> np.ndarray:
    if pct <= 0:
        return img
    h, w = img.shape[:2]
    dx, dy = int(w * pct / 100), int(h * pct / 100)
    return img[dy : h - dy, dx : w - dx]


def process_one(rembg_session, path: Path, out_dir: Path, inset: float):
    from rembg import remove

    img_pil = Image.open(path).convert("RGB")
    img_bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

    rgba = remove(np.array(img_pil), session=rembg_session)
    mask = rgba[:, :, 3]

    pts, method = find_quad(mask)
    if pts is None:
        return False, "no_contour"

    warped = warp_from_quad(img_bgr, pts)
    warped = apply_inset(warped, inset)

    out_path = out_dir / (path.stem + ".jpg")
    cv2.imwrite(str(out_path), warped, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return True, method


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="Folder of source photos")
    ap.add_argument("--output", required=True, help="Folder to write straightened images to")
    ap.add_argument("--inset", type=float, default=0, help="Percent to crop inward after warping (trims the frame)")
    ap.add_argument(
        "--model",
        default="u2net",
        help="rembg model: u2net (default, general-purpose) or isnet-general-use (newer, often sharper edges)",
    )
    args = ap.parse_args()

    from rembg import new_session

    in_dir = Path(args.input)
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in in_dir.iterdir() if p.suffix.lower() in VALID_EXTS)
    if not files:
        sys.exit(f"No images found in {in_dir}")

    print(f"Loading segmentation model ({args.model})...")
    session = new_session(args.model)

    review_needed = []
    fallback_used = []

    for i, path in enumerate(files, 1):
        try:
            ok, method = process_one(session, path, out_dir, args.inset)
        except Exception as e:
            ok, method = False, f"error: {e}"

        if not ok:
            review_needed.append(f"{path.name}: FAILED ({method})")
        elif method == "minAreaRect":
            fallback_used.append(f"{path.name}: used rotated-box fallback, corners may be less precise")

        print(f"[{i}/{len(files)}] {path.name} -> {method}")

    if review_needed or fallback_used:
        with open(out_dir / "review_needed.txt", "w") as f:
            f.write("Images that failed entirely:\n")
            f.write("\n".join(review_needed) or "(none)")
            f.write("\n\nImages that used the lower-precision fallback:\n")
            f.write("\n".join(fallback_used) or "(none)")
        print(f"\n{len(review_needed)} failed, {len(fallback_used)} used fallback — see review_needed.txt")

    print(f"\nDone. {len(files) - len(review_needed)}/{len(files)} images written to {out_dir}")


if __name__ == "__main__":
    main()
