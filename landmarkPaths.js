/**
 * MediaPipe Face Mesh topology (first 478 indices match Face Landmarker).
 * Ordered polygons for raster masks.
 */

/** Face contour — closed path (no repeated first vertex at end). */
export const FACE_OVAL_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Outer lip — closed. */
export const OUTER_LIP_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];

/** Inner lip / oral cavity — even-odd subtract. */
export const INNER_LIP_INDICES = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
];

/** Left / right eye rim indices for hull + under-eye extension. */
export const LEFT_EYE_INDICES = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398,
];

export const RIGHT_EYE_INDICES = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173,
];

/** Left eyebrow — exclude from skin smoothing. */
export const LEFT_BROW_INDICES = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];

/** Right eyebrow. */
export const RIGHT_BROW_INDICES = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
