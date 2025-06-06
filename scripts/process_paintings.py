
import cv2
import numpy as np
import os
import sys
from glob import glob

# Default input and output directories
IN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/img'))
OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/_processed'))
os.makedirs(OUT_DIR, exist_ok=True)

def order_points(pts):
    # Order points: top-left, top-right, bottom-right, bottom-left
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def four_point_transform(image, pts):
    # Deskew only: map detected rectangle to the same rectangle in the original image
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    # Use the bounding box of the detected rectangle as the destination
    x, y, w, h = cv2.boundingRect(rect)
    dst = np.array([
        [x, y],
        [x + w - 1, y],
        [x + w - 1, y + h - 1],
        [x, y + h - 1]
    ], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    # Warp to the original image size, so the deskewed painting is in place
    warped = cv2.warpPerspective(image, M, (image.shape[1], image.shape[0]))
    return warped


def process_image(img_path, out_path):
    image = cv2.imread(img_path)
    if image is None:
        print(f"[ERROR] Could not read image: {img_path}")
        return
    try:
        orig = image.copy()
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        edged = cv2.Canny(gray, 50, 200)
        cnts, _ = cv2.findContours(edged.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # Find all 4-point contours and select the largest one (rectangle, any aspect ratio)
        best_cnt = None
        best_area = 0
        for c in cnts:
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) == 4:
                pts = approx.reshape(4, 2)
                area = cv2.contourArea(pts)
                if area > best_area:
                    best_area = area
                    best_cnt = pts
        if best_cnt is not None:
            warped = four_point_transform(orig, best_cnt)
            cv2.imwrite(out_path, warped)
            print(f"Processed: {os.path.basename(img_path)} (largest rectangle)")
        else:
            # If no rectangle found, just save the original
            cv2.imwrite(out_path, orig)
            print(f"No painting detected, saved original: {os.path.basename(img_path)}")
    except Exception as e:
        print(f"[ERROR] Exception processing {img_path}: {e}")


def main():
    # If arguments are given, use them as files to process
    if len(sys.argv) > 1:
        images = sys.argv[1:]
    else:
        images = glob(os.path.join(IN_DIR, '*'))
    for img_path in images:
        if not os.path.isfile(img_path):
            print(f"[WARN] Not a file: {img_path}")
            continue
        fname = os.path.basename(img_path)
        out_path = os.path.join(OUT_DIR, fname)
        process_image(img_path, out_path)

if __name__ == "__main__":
    main()
