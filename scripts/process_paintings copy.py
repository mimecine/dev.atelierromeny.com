import cv2
import numpy as np
import os
from glob import glob

# Input and output directories
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
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = max(int(widthA), int(widthB))
    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = max(int(heightA), int(heightB))
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped

def auto_rotate(image):
    h, w = image.shape[:2]
    if h > w:
        # If height > width, rotate to landscape
        image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    return image

def process_image(img_path, out_path):
    image = cv2.imread(img_path)
    orig = image.copy()
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(gray, 50, 200)
    cnts, _ = cv2.findContours(edged.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)
    screenCnt = None
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            screenCnt = approx.reshape(4, 2)
            break
    if screenCnt is not None:
        warped = four_point_transform(orig, screenCnt)
        # warped = auto_rotate(warped)
        cv2.imwrite(out_path, warped)
        print(f"Processed: {os.path.basename(img_path)}")
    else:
        # If no rectangle found, just save the original
        cv2.imwrite(out_path, orig)
        print(f"No painting detected, saved original: {os.path.basename(img_path)}")

def main():
    images = glob(os.path.join(IN_DIR, '*'))
    for img_path in images:
        fname = os.path.basename(img_path)
        out_path = os.path.join(OUT_DIR, fname)
        process_image(img_path, out_path)

if __name__ == "__main__":
    main()
