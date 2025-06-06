import cv2
import numpy as np
import os
import sys
from glob import glob

IN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/img'))
OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/media/_debugrects'))
os.makedirs(OUT_DIR, exist_ok=True)

# Helper to compute angle between three points (in degrees)
def angle(pt1, pt2, pt3):
    v1 = pt1 - pt2
    v2 = pt3 - pt2
    ang = np.arccos(
        np.clip(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)), -1.0, 1.0)
    )
    return np.degrees(ang)

def rectangularness(pts):
    # pts: 4x2 array
    pts = np.array(pts)
    angles = []
    for i in range(4):
        ang = angle(pts[i - 1], pts[i], pts[(i + 1) % 4])
        angles.append(ang)
    # Rectangularness: sum of |angle - 90| for all corners
    return sum(abs(a - 90) for a in angles), angles

def draw_rectangles(image, rectangles, rectangularness_scores, selected_idx=None):
    overlay = image.copy()
    font = cv2.FONT_HERSHEY_SIMPLEX
    for i, rect in enumerate(rectangles):
        color = (0, 255, 0)  # green for all
        thickness = 2
        if i == selected_idx:
            color = (0, 0, 255)  # red for selected
            thickness = 4
        pts = rect.reshape((-1, 1, 2)).astype(int)
        cv2.polylines(overlay, [pts], isClosed=True, color=color, thickness=thickness)
        # Draw rectangularness score
        score = rectangularness_scores[i][0]
        label = f"{score:.1f}"
        pt = tuple(pts[0][0])
        cv2.putText(overlay, label, pt, font, 0.7, color, 2, cv2.LINE_AA)
    return overlay

def process_image(img_path, out_path, rect_thresh=20, min_area=10000):
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
    scores = []
    areas = []
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            pts = approx.reshape(4, 2)
            area = cv2.contourArea(pts)
            score, angles = rectangularness(pts)
            if area > min_area:
                rectangles.append(pts)
                scores.append((score, angles))
                areas.append(area)
    # Select the best rectangle: lowest rectangularness score (closest to 0), then largest area
    selected_idx = None
    if scores:
        # Only consider those with rectangularness below threshold
        candidates = [(i, s[0], areas[i]) for i, s in enumerate(scores) if s[0] < rect_thresh]
        if candidates:
            # Pick the largest area among good rectangles
            selected_idx = max(candidates, key=lambda x: x[2])[0]
        else:
            # If none are good, pick the one closest to rectangle
            selected_idx = min(range(len(scores)), key=lambda i: scores[i][0])
    overlay = draw_rectangles(orig, rectangles, scores, selected_idx)
    if selected_idx is not None and scores[selected_idx][0] >= rect_thresh:
        print(f"[WARN] No good rectangle found in {os.path.basename(img_path)} (best rectangularness: {scores[selected_idx][0]:.1f})")
    elif selected_idx is None:
        print(f"[WARN] No rectangles found in {os.path.basename(img_path)}")
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
