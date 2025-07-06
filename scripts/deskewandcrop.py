import cv2
import numpy as np
import argparse
import os

def order_points(pts):
    """
    Sorts the four corner points of a rectangle in top-left,
    top-right, bottom-right, and bottom-left order.
    """
    rect = np.zeros((4, 2), dtype="float32")

    # The top-left point will have the smallest sum, whereas
    # the bottom-right point will have the largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # The top-right point will have the smallest difference,
    # whereas the bottom-left will have the largest difference
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    # Return the ordered coordinates
    return rect

def deskew_and_crop(image_path):
    """
    Detects a painting in an image, deskews it, and crops it.

    Args:
        image_path (str): The path to the input image file.

    Returns:
        The cropped and deskewed painting as a NumPy array,
        or None if no painting is found.
    """
    # Read the image
    image = cv2.imread(image_path)
    if image is None:
        print(f"Error: Could not read image from {image_path}")
        return None

    # Convert the image to grayscale
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Apply Gaussian blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Use Canny edge detection
    edged = cv2.Canny(blurred, 50, 200)

    # Find contours in the edged image
    contours, _ = cv2.findContours(edged.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        print(f"No contours found in {image_path}.")
        return None

    # Get the largest contour by area
    largest_contour = max(contours, key=cv2.contourArea)

    # Approximate the contour to a polygon
    peri = cv2.arcLength(largest_contour, True)
    approx = cv2.approxPolyDP(largest_contour, 0.02 * peri, True)

    # If the approximated contour has four points, we assume it's the painting
    if len(approx) == 4:
        # Order the four corner points
        ordered_pts = order_points(approx.reshape(4, 2))
        (tl, tr, br, bl) = ordered_pts

        # Compute the width of the new image
        widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
        widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
        maxWidth = max(int(widthA), int(widthB))

        # Compute the height of the new image
        heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
        heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
        maxHeight = max(int(heightA), int(heightB))

        # Define the destination points for the perspective transform
        dst = np.array([
            [0, 0],
            [maxWidth - 1, 0],
            [maxWidth - 1, maxHeight - 1],
            [0, maxHeight - 1]], dtype="float32")

        # Get the perspective transformation matrix
        M = cv2.getPerspectiveTransform(ordered_pts, dst)

        # Apply the perspective warp
        warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))

        return warped
    else:
        print(f"The largest contour in {image_path} is not a rectangle.")
        return None

if __name__ == '__main__':
    # Set up the argument parser
    ap = argparse.ArgumentParser(description="Detect, deskew, and crop a painting from an image.")
    ap.add_argument("-i", "--input", required=True, help="Path to the input image")
    ap.add_argument("-o", "--output", required=True, help="Path to save the output cropped image")
    ap.add_argument("-d", "--display", action='store_true', help="Display the original and result images")
    
    args = vars(ap.parse_args())

    # Get the input and output paths from the command line
    input_image_path = args["input"]
    output_image_path = args["output"]

    # Process the image
    result = deskew_and_crop(input_image_path)

    if result is not None:
        # Save the resulting image
        cv2.imwrite(output_image_path, result)
        print(f"Successfully processed {input_image_path}")
        print(f"Cropped painting saved to {output_image_path}")

        # Display images if the display flag is set
        if args["display"]:
            original_image = cv2.imread(input_image_path)
            cv2.imshow("Original Image", original_image)
            cv2.imshow("Deskewed and Cropped Painting", result)
            cv2.waitKey(0)
            cv2.destroyAllWindows()