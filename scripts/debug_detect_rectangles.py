import cv2
import numpy as np
import os
import sys
from glob import glob

IN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/img'))
OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/_debugrects'))
os.makedirs(OUT_DIR, exist_ok=True)

def draw_rectangles(image, rectangles, selected_idx=None):
    overlay = image.copy()
    for i, rect in enumerate(rectangles):
        color = (0, 255, 0)  # green for all
        thickness = 2
        if i == selected_idx:
            color = (0, 0, 255)  # red for selected
            thickness = 4
        pts = rect.reshape((-1, 1, 2)).astype(int)
        cv2.polylines(overlay, [pts], isClosed=True, color=color, thickness=thickness)
    return overlay

def process_image(img_path, out_path):
    image = cv2.imread(img_path)
    if image is None:
        print(f"[ERROR] Could not read image: {img_path}")
        return
    orig = image.copy()
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(gray, 50, 200)
    cnts, _ = cv2.findContours(edged.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rectangles = []
    areas = []
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            rectangles.append(approx.reshape(4, 2))
            areas.append(cv2.contourArea(approx))
    selected_idx = np.argmax(areas) if areas else None
    overlay = draw_rectangles(orig, rectangles, selected_idx)
    cv2.imwrite(out_path, overlay)
    print(f"Debug overlay saved: {os.path.basename(out_path)}")

def main():
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
