#!/usr/bin/env python3
"""
Painting Straightener - Automatically straighten and crop paintings from photos
Usage: python straighten_painting.py input.jpg output.jpg [--debug]
"""

import cv2
import numpy as np
import argparse
import sys
from pathlib import Path


def order_points(pts):
    """Order points in top-left, top-right, bottom-right, bottom-left order"""
    rect = np.zeros((4, 2), dtype="float32")
    
    # Sum: top-left will have smallest sum, bottom-right largest
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    
    # Diff: top-right will have smallest diff, bottom-left largest
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    
    return rect


def detect_frame_by_color(image, debug=False):
    """Detect frame by looking for shadow/depth at edges"""
    # Convert to LAB color space for better shadow detection
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0]
    
    # Create a mask for darker regions (potential frame depth/shadow)
    _, shadow_mask = cv2.threshold(l_channel, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    # Invert if needed (we want dark areas)
    if np.mean(shadow_mask) > 127:
        shadow_mask = cv2.bitwise_not(shadow_mask)
    
    if debug:
        cv2.imwrite("debug_shadow_mask.jpg", shadow_mask)
    
    return shadow_mask


def find_painting_contour_multimethod(image, debug=False):
    """Try multiple methods to find the painting contour"""
    h, w = image.shape[:2]
    
    # Method 1: Enhanced edge detection with multiple thresholds
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Apply CLAHE for better contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    # Bilateral filter to reduce noise while keeping edges
    blurred = cv2.bilateralFilter(enhanced, 9, 75, 75)
    
    # Try multiple Canny thresholds
    edges_list = []
    for low, high in [(30, 100), (50, 150), (70, 200)]:
        edges = cv2.Canny(blurred, low, high)
        edges_list.append(edges)
    
    # Combine edges
    combined_edges = cv2.bitwise_or(edges_list[0], edges_list[1])
    combined_edges = cv2.bitwise_or(combined_edges, edges_list[2])
    
    # Method 2: Detect frame shadows/depth
    shadow_mask = detect_frame_by_color(image, debug)
    
    # Combine edge detection with shadow detection
    combined = cv2.bitwise_or(combined_edges, cv2.Canny(shadow_mask, 50, 150))
    
    # Morphological operations to close gaps
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)
    dilated = cv2.dilate(closed, kernel, iterations=2)
    
    if debug:
        cv2.imwrite("debug_enhanced.jpg", enhanced)
        cv2.imwrite("debug_combined_edges.jpg", combined)
        cv2.imwrite("debug_dilated.jpg", dilated)
    
    # Find contours
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        return None
    
    # Sort by area
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    
    if debug:
        debug_img = image.copy()
        cv2.drawContours(debug_img, contours[:5], -1, (0, 255, 0), 2)
        cv2.imwrite("debug_all_contours.jpg", debug_img)
    
    # Score candidates based on multiple criteria
    candidates = []
    
    for i, contour in enumerate(contours[:15]):
        peri = cv2.arcLength(contour, True)
        
        # Try different epsilon values for approximation
        for epsilon_factor in [0.02, 0.03, 0.04, 0.05]:
            approx = cv2.approxPolyDP(contour, epsilon_factor * peri, True)
            
            if len(approx) == 4:
                area = cv2.contourArea(approx)
                img_area = h * w
                
                # Must be at least 20% of image
                if area > img_area * 0.20:
                    # Check aspect ratio is reasonable
                    rect = order_points(approx.reshape(4, 2))
                    width = np.linalg.norm(rect[0] - rect[1])
                    height = np.linalg.norm(rect[0] - rect[3])
                    aspect_ratio = max(width, height) / min(width, height)
                    
                    # Accept reasonable aspect ratios
                    if aspect_ratio < 3:
                        # Calculate how close to image edges (prioritize outermost)
                        points = approx.reshape(4, 2)
                        min_x, min_y = points.min(axis=0)
                        max_x, max_y = points.max(axis=0)
                        
                        # Distance from edges (smaller = closer to edge = better)
                        edge_distance = (min_x + min_y + (w - max_x) + (h - max_y)) / 4
                        
                        # Score: prefer larger area and closer to edges
                        score = area / img_area - (edge_distance / min(w, h)) * 0.5
                        
                        candidates.append({
                            'approx': approx,
                            'score': score,
                            'area_ratio': area / img_area,
                            'edge_dist': edge_distance,
                            'index': i,
                            'epsilon': epsilon_factor
                        })
    
    # Sort by score and pick the best
    if candidates:
        candidates.sort(key=lambda x: x['score'], reverse=True)
        best = candidates[0]
        
        if debug:
            debug_img = image.copy()
            # Show top 3 candidates
            for idx, cand in enumerate(candidates[:3]):
                color = [(0, 255, 0), (0, 255, 255), (255, 0, 255)][idx]
                cv2.drawContours(debug_img, [cand['approx']], -1, color, 3)
            
            # Mark best candidate corners
            for point in best['approx'].reshape(4, 2):
                cv2.circle(debug_img, tuple(point.astype(int)), 10, (0, 0, 255), -1)
            
            cv2.imwrite("debug_detected_contour.jpg", debug_img)
            print(f"Best contour: index {best['index']}, epsilon {best['epsilon']}, "
                  f"area ratio: {best['area_ratio']:.2%}, score: {best['score']:.3f}")
        
        return best['approx'].reshape(4, 2)
    
    # Fallback: use image bounds with margin (assume painting fills most of frame)
    print("Warning: Could not detect exact edges, using image bounds with margin")
    margin = 0.05  # 5% margin
    return np.array([
        [w * margin, h * margin],
        [w * (1 - margin), h * margin],
        [w * (1 - margin), h * (1 - margin)],
        [w * margin, h * (1 - margin)]
    ], dtype="float32")


def apply_perspective_transform(image, corners):
    """Apply perspective transformation to get a bird's eye view"""
    rect = order_points(corners)
    (tl, tr, br, bl) = rect
    
    # Calculate width
    widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    maxWidth = max(int(widthA), int(widthB))
    
    # Calculate height
    heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    maxHeight = max(int(heightA), int(heightB))
    
    # Destination points
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]
    ], dtype="float32")
    
    # Apply transform
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    
    return warped


def auto_crop_frame(image, debug=False):
    """Crop away the frame by detecting inner rectangle"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Edge detection
    edges = cv2.Canny(gray, 50, 150)
    
    # Dilate edges slightly
    kernel = np.ones((3, 3), np.uint8)
    dilated = cv2.dilate(edges, kernel, iterations=1)
    
    if debug:
        cv2.imwrite("debug_crop_edges.jpg", edges)
    
    # Find contours
    contours, _ = cv2.findContours(dilated, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    
    if contours:
        # Get bounding box of all edges (inner content)
        all_points = np.vstack([c.reshape(-1, 2) for c in contours])
        x, y, w, h = cv2.boundingRect(all_points)
        
        # Add small margin
        margin = 5
        y1 = max(0, y + margin)
        y2 = min(image.shape[0], y + h - margin)
        x1 = max(0, x + margin)
        x2 = min(image.shape[1], x + w - margin)
        
        return image[y1:y2, x1:x2]
    
    return image


def straighten_painting(input_path, output_path, debug=False):
    """Main function to straighten and crop a painting"""
    # Load image
    image = cv2.imread(str(input_path))
    if image is None:
        print(f"Error: Could not load image from {input_path}")
        return False
    
    print(f"Processing {input_path}...")
    print(f"Original size: {image.shape[1]}x{image.shape[0]}")
    
    # Find the painting contour
    print("Detecting painting boundaries...")
    corners = find_painting_contour_multimethod(image, debug)
    
    if corners is None:
        print("Error: Could not detect painting.")
        return False
    
    print("Applying perspective correction...")
    straightened = apply_perspective_transform(image, corners)
    
    print("Cropping frame...")
    final = auto_crop_frame(straightened, debug)
    
    # Save result
    cv2.imwrite(str(output_path), final)
    print(f"✓ Saved straightened painting to {output_path}")
    print(f"Final size: {final.shape[1]}x{final.shape[0]}")
    
    if debug:
        print("Debug images saved in current directory (debug_*.jpg)")
    
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Straighten and crop paintings from photos",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python straighten_painting.py painting.jpg output.jpg
  python straighten_painting.py photo.jpg result.jpg --debug
        """
    )
    parser.add_argument("input", help="Input image path")
    parser.add_argument("output", help="Output image path")
    parser.add_argument("--debug", action="store_true", 
                       help="Save debug images showing detection steps")
    
    args = parser.parse_args()
    
    # Validate paths
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file '{input_path}' does not exist")
        sys.exit(1)
    
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Process the image
    success = straighten_painting(input_path, output_path, args.debug)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()