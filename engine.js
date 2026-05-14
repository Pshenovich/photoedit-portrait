/**
 * Face detection (MediaPipe) + retouch: frequency separation skin,
 * periorbital correction, lip tint. ES module.
 */

import {
  FACE_OVAL_INDICES,
  OUTER_LIP_INDICES,
  INNER_LIP_INDICES,
  LEFT_EYE_INDICES,
  RIGHT_EYE_INDICES,
  LEFT_BROW_INDICES,
  RIGHT_BROW_INDICES,
} from "./landmarkPaths.js";

/** @type {import('@mediapipe/tasks-vision').FaceLandmarker | null} */
let landmarker = null;
let landmarkerPromise = null;

export function getLandmarker() {
  return landmarker;
}

/**
 * @returns {Promise<import('@mediapipe/tasks-vision').FaceLandmarker>}
 */
export async function ensureFaceLandmarker() {
  if (landmarker) return landmarker;
  if (landmarkerPromise) {
    try {
      return await landmarkerPromise;
    } catch {
      landmarkerPromise = null;
    }
  }
  landmarkerPromise = (async () => {
    try {
      const vision = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"
      );
      const { FaceLandmarker, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const modelAssetPath =
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

      const base = {
        runningMode: "IMAGE",
        numFaces: 2,
        minFaceDetectionConfidence: 0.15,
        minFacePresenceConfidence: 0.15,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      };

      const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
      const isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);

      const tryOrder = isMobile
        ? [{ delegate: "CPU" }, { delegate: "GPU" }, {}]
        : [{ delegate: "GPU" }, { delegate: "CPU" }, {}];

      let lastErr = null;
      for (const del of tryOrder) {
        try {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...base,
            baseOptions: { modelAssetPath, ...del },
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          landmarker = null;
        }
      }
      if (!landmarker && lastErr) throw lastErr;
      return landmarker;
    } catch (e) {
      landmarker = null;
      landmarkerPromise = null;
      throw e;
    }
  })();
  return landmarkerPromise;
}

function pickBestFace(faces) {
  if (!faces || faces.length === 0) return null;
  const valid = faces.filter((lm) => lm && lm.length >= 468);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  let best = null;
  let bestArea = 0;
  for (const lm of valid) {
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    let any = false;
    for (const i of [10, 152, 234, 454, 1, 33, 263]) {
      if (!lm[i]) continue;
      any = true;
      const x = lm[i].x;
      const y = lm[i].y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const area = any ? (maxX - minX) * (maxY - minY) : 0;
    if (area > bestArea) {
      bestArea = area;
      best = lm;
    }
  }
  return best || valid[0];
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ landmarks: Array<{x:number,y:number,z?:number}> } | null}
 */
export function detectLandmarks(canvas) {
  if (!landmarker) return null;

  const tryDetect = (c) => {
    const res = landmarker.detect(c);
    const faces = res.faceLandmarks;
    const lm = pickBestFace(faces);
    return lm ? { landmarks: lm } : null;
  };

  let det = tryDetect(canvas);
  if (det) return det;

  const W = canvas.width;
  const H = canvas.height;
  if (W < 32 || H < 32) return null;

  const scales = [1.75, 2.25, 1.35, 0.85];
  for (const sc of scales) {
    const tw = Math.round(Math.min(1920, Math.max(96, W * sc)));
    const th = Math.round(Math.min(1920, Math.max(96, H * sc)));
    if (tw === W && th === H) continue;
    const mc = document.createElement("canvas");
    mc.width = tw;
    mc.height = th;
    const mx = mc.getContext("2d");
    mx.imageSmoothingEnabled = true;
    mx.imageSmoothingQuality = "high";
    mx.drawImage(canvas, 0, 0, tw, th);
    det = tryDetect(mc);
    if (det) return det;
  }

  return null;
}

export function lmPx(lm, i, w, h) {
  const p = lm[i];
  return { x: p.x * w, y: p.y * h };
}

/** Monotone chain convex hull. @param {{x:number,y:number}[]} pts */
export function convexHull(pts) {
  const uniq = [];
  const key = (p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const seen = new Set();
  for (const p of pts) {
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  if (uniq.length < 3) return uniq.slice();
  uniq.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * @param {CanvasRenderingContext2D} mctx
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {number} w
 * @param {number} h
 */
export function drawFaceOvalPath(mctx, lm, w, h) {
  mctx.beginPath();
  const p0 = lmPx(lm, FACE_OVAL_INDICES[0], w, h);
  mctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < FACE_OVAL_INDICES.length; k++) {
    const p = lmPx(lm, FACE_OVAL_INDICES[k], w, h);
    mctx.lineTo(p.x, p.y);
  }
  mctx.closePath();
}

/**
 * Soft skin mask: face oval minus eyes, brows, lips, inner mouth.
 * @returns {HTMLCanvasElement} grayscale mask white=skin
 */
export function buildSkinMaskCanvas(lm, w, h) {
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  drawFaceOvalPath(mx, lm, w, h);
  mx.fill();

  mx.globalCompositeOperation = "destination-out";
  mx.fillStyle = "#fff";

  const cutHull = (indices, expand) => {
    const pts = indices.map((i) => lmPx(lm, i, w, h));
    const c = convexHull(pts);
    if (c.length < 3) return;
    let cx = 0;
    let cy = 0;
    for (const p of c) {
      cx += p.x;
      cy += p.y;
    }
    cx /= c.length;
    cy /= c.length;
    mx.beginPath();
    const q0 = c[0];
    mx.moveTo(cx + (q0.x - cx) * expand, cy + (q0.y - cy) * expand);
    for (let i = 1; i < c.length; i++) {
      const p = c[i];
      mx.lineTo(cx + (p.x - cx) * expand, cy + (p.y - cy) * expand);
    }
    mx.closePath();
    mx.fill();
  };

  cutHull(LEFT_EYE_INDICES, 1.22);
  cutHull(RIGHT_EYE_INDICES, 1.22);
  cutHull(LEFT_BROW_INDICES, 1.12);
  cutHull(RIGHT_BROW_INDICES, 1.12);

  mx.beginPath();
  for (let k = 0; k < OUTER_LIP_INDICES.length; k++) {
    const p = lmPx(lm, OUTER_LIP_INDICES[k], w, h);
    if (k === 0) mx.moveTo(p.x, p.y);
    else mx.lineTo(p.x, p.y);
  }
  mx.closePath();
  mx.fill();

  mx.beginPath();
  for (let k = 0; k < INNER_LIP_INDICES.length; k++) {
    const p = lmPx(lm, INNER_LIP_INDICES[k], w, h);
    if (k === 0) mx.moveTo(p.x, p.y);
    else mx.lineTo(p.x, p.y);
  }
  mx.closePath();
  mx.fill();

  mx.globalCompositeOperation = "source-over";
  const blurred = document.createElement("canvas");
  blurred.width = w;
  blurred.height = h;
  const bx = blurred.getContext("2d");
  bx.filter = "blur(10px)";
  bx.drawImage(m, 0, 0);
  bx.filter = "none";
  bx.drawImage(blurred, 0, 0);
  return blurred;
}

/**
 * Under-eye soft mask (ellipse under lower lid).
 * @param {'left'|'right'} side
 */
export function drawUnderEyeMask(mctx, lm, w, h, side) {
  const idx = side === "left" ? LEFT_EYE_INDICES : RIGHT_EYE_INDICES;
  const pts = idx.map((i) => lmPx(lm, i, w, h));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const outerL = side === "left" ? lmPx(lm, 263, w, h) : lmPx(lm, 33, w, h);
  const outerR = side === "left" ? lmPx(lm, 362, w, h) : lmPx(lm, 133, w, h);
  const ang = Math.atan2(outerR.y - outerL.y, outerR.x - outerL.x);
  const cx = (minX + maxX) / 2;
  const cy = maxY + (maxY - minY) * 0.38;
  const rx = (maxX - minX) * 0.78;
  const ry = (maxY - minY) * 1.05;

  mctx.save();
  mctx.translate(cx, cy);
  mctx.rotate(ang);
  const g = mctx.createRadialGradient(0, -ry * 0.15, 0, 0, ry * 0.2, ry * 1.05);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.55, "rgba(255,255,255,0.75)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  mctx.fillStyle = g;
  mctx.beginPath();
  mctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  mctx.fill();
  mctx.restore();
}

/**
 * Lip region canvas mask (outer minus inner), feathered.
 */
export function buildLipMaskCanvas(lm, w, h) {
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  mx.beginPath();
  for (let k = 0; k < OUTER_LIP_INDICES.length; k++) {
    const p = lmPx(lm, OUTER_LIP_INDICES[k], w, h);
    if (k === 0) mx.moveTo(p.x, p.y);
    else mx.lineTo(p.x, p.y);
  }
  mx.closePath();
  for (let k = 0; k < INNER_LIP_INDICES.length; k++) {
    const p = lmPx(lm, INNER_LIP_INDICES[k], w, h);
    if (k === 0) mx.moveTo(p.x, p.y);
    else mx.lineTo(p.x, p.y);
  }
  mx.closePath();
  mx.fill("evenodd");

  const blurred = document.createElement("canvas");
  blurred.width = w;
  blurred.height = h;
  const bx = blurred.getContext("2d");
  bx.filter = "blur(4px)";
  bx.drawImage(m, 0, 0);
  bx.filter = "none";
  bx.drawImage(blurred, 0, 0);
  return blurred;
}

/**
 * @param {ImageData} a
 * @param {ImageData} b
 * @param {Uint8ClampedArray} maskAlpha length w*h, 0..255
 * @param {number} strength 0..1
 */
export function blendWithMask(a, b, maskAlpha, strength) {
  const w = a.width;
  const h = a.height;
  const out = new ImageData(w, h);
  const ad = a.data;
  const bd = b.data;
  const od = out.data;
  let p = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = (maskAlpha[y * w + x] / 255) * strength;
      od[p] = ad[p] * (1 - m) + bd[p] * m;
      od[p + 1] = ad[p + 1] * (1 - m) + bd[p + 1] * m;
      od[p + 2] = ad[p + 2] * (1 - m) + bd[p + 2] * m;
      od[p + 3] = 255;
      p += 4;
    }
  }
  return out;
}

/**
 * Grayscale alpha from red channel of mask canvas.
 * @param {HTMLCanvasElement} maskCanvas
 */
export function maskAlphaFromCanvas(maskCanvas) {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const ctx = maskCanvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const out = new Uint8ClampedArray(w * h);
  let j = 0;
  for (let i = 0; i < d.length; i += 4) {
    out[j++] = d[i];
  }
  return out;
}

/**
 * Blur canvas snapshot via filter, return ImageData.
 */
export function blurCanvasToImageData(sourceCanvas, blurPx) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const t = document.createElement("canvas");
  t.width = w;
  t.height = h;
  const tc = t.getContext("2d");
  try {
    tc.filter = `blur(${blurPx}px)`;
    tc.drawImage(sourceCanvas, 0, 0, w, h);
  } catch (_) {
    tc.filter = "none";
    tc.drawImage(sourceCanvas, 0, 0, w, h);
  }
  tc.filter = "none";
  return tc.getImageData(0, 0, w, h);
}

/**
 * Frequency-separation style skin: lowSmooth + (orig - lowFine), masked.
 * @param {HTMLCanvasElement} workCanvas — same size as source, already has image
 * @param {Uint8ClampedArray} skinMask
 * @param {number} strength 0..1
 * @param {{ fine?: number; coarse?: number }} sigmas px for blur chain
 */
export function applyAutoSkin(workCanvas, skinMask, strength, sigmas = {}) {
  const fine = sigmas.fine ?? 4.5;
  const coarse = sigmas.coarse ?? 14;
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(0, 0, w, h);

  const lowFine = blurCanvasToImageData(workCanvas, fine);
  const t2 = document.createElement("canvas");
  t2.width = w;
  t2.height = h;
  const t2c = t2.getContext("2d");
  t2c.putImageData(lowFine, 0, 0);
  const lowSmooth = blurCanvasToImageData(t2, coarse);

  const lf = lowFine.data;
  const ls = lowSmooth.data;
  const o = orig.data;
  const tmp = new ImageData(w, h);
  const td = tmp.data;
  for (let i = 0; i < o.length; i += 4) {
    const hf0 = o[i] - lf[i];
    const hf1 = o[i + 1] - lf[i + 1];
    const hf2 = o[i + 2] - lf[i + 2];
    td[i] = clamp(ls[i] + hf0, 0, 255);
    td[i + 1] = clamp(ls[i + 1] + hf1, 0, 255);
    td[i + 2] = clamp(ls[i + 2] + hf2, 0, 255);
    td[i + 3] = 255;
  }

  const blended = blendWithMask(orig, tmp, skinMask, strength);
  ctx.putImageData(blended, 0, 0);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Periorbital: lift luminance, reduce blue cast in masked ellipses.
 */
export function applyAutoEyes(workCanvas, lm, strength) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  drawUnderEyeMask(mx, lm, w, h, "left");
  drawUnderEyeMask(mx, lm, w, h, "right");
  const bx = document.createElement("canvas");
  bx.width = w;
  bx.height = h;
  const bxc = bx.getContext("2d");
  bxc.filter = "blur(6px)";
  bxc.drawImage(m, 0, 0);
  bxc.filter = "none";
  bxc.drawImage(bx, 0, 0);
  const maskA = maskAlphaFromCanvas(bx);

  const orig = ctx.getImageData(0, 0, w, h);
  const out = new ImageData(w, h);
  const od = orig.data;
  const d = out.data;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ma = (maskA[y * w + x] / 255) * strength;
      let r = od[pi];
      let g = od[pi + 1];
      let b = od[pi + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const lift = 10 * ma;
      r += lift * (1 + 0.04 * (255 - L) / 255);
      g += lift * 0.96;
      b += lift * 0.88;
      b -= 6 * ma;
      r += 3 * ma;
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = od[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function hexToRgb(hex) {
  const n = hex.replace("#", "");
  const v = parseInt(n.length === 3 ? n.split("").map((c) => c + c).join("") : n, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/**
 * Natural lip tint inside lip mask.
 */
export function applyAutoLip(workCanvas, lipMaskCanvas, hex, strength) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const { r: lr, g: lg, b: lb } = hexToRgb(hex);
  const orig = ctx.getImageData(0, 0, w, h);
  const maskA = maskAlphaFromCanvas(lipMaskCanvas);
  const o = orig.data;
  const out = new ImageData(w, h);
  const d = out.data;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = (maskA[y * w + x] / 255) * strength;
      let r = o[pi];
      let g = o[pi + 1];
      let b = o[pi + 2];
      const t = m * 0.55;
      r = r * (1 - t) + (r * (lr / 255)) * t + (lr * 0.12 * t);
      g = g * (1 - t) + (g * (lg / 255)) * t + (lg * 0.08 * t);
      b = b * (1 - t) + (b * (lb / 255)) * t + (lb * 0.1 * t);
      const sat = 1 + 0.18 * m;
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = o[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** @param {Uint8ClampedArray | null} maskAlpha */
export function maskValueAt(w, h, x, y, maskAlpha) {
  if (!maskAlpha) return 1;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return 0;
  return maskAlpha[iy * w + ix] / 255;
}
