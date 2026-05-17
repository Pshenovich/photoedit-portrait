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
import {
  buildTeethMaskCanvas,
  buildIrisMaskCanvas,
  buildScleraMaskCanvas,
  buildCheekMaskCanvas,
} from "./segmentMasks.js";

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const WASM_ROOT = `${VISION_CDN}/wasm`;

/** @type {import('@mediapipe/tasks-vision').FaceLandmarker | null} */
let landmarker = null;
let landmarkerPromise = null;

/** @type {import('@mediapipe/tasks-vision').ImageSegmenter | null} */
let imageSegmenter = null;
let segmenterPromise = null;

export function getImageSegmenter() {
  return imageSegmenter;
}

export function isMobileUA() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
}

/** iOS WebKit, Yandex, in-app browsers — file input needs extra care. */
export function needsFilePickerWorkaround() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/YaBrowser|YandexSearch|Yandex\.Search/i.test(ua)) return true;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|SamsungBrowser/i.test(ua) && /Mobile/i.test(ua)) return true;
  return false;
}

/** «На экран Домой» на iOS — выбор из медиатеки часто не работает. */
export function isIosStandalonePWA() {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (!/iPhone|iPad|iPod/i.test(ua)) return false;
  if (/** @type {{ standalone?: boolean }} */ (navigator).standalone === true) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

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
      const vision = await import(`${VISION_CDN}/vision_bundle.mjs`);
      const { FaceLandmarker, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const modelAssetPath =
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

      const base = {
        runningMode: "IMAGE",
        numFaces: 6,
        minFaceDetectionConfidence: 0.15,
        minFacePresenceConfidence: 0.15,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      };

      const tryOrder = isMobileUA()
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

/**
 * Selfie multiclass: 0=bg, 1=hair, 2=body-skin, 3=face-skin, 4=clothes, 5=others
 * @returns {Promise<import('@mediapipe/tasks-vision').ImageSegmenter>}
 */
export async function ensureImageSegmenter() {
  if (imageSegmenter) return imageSegmenter;
  if (segmenterPromise) {
    try {
      return await segmenterPromise;
    } catch {
      segmenterPromise = null;
    }
  }
  segmenterPromise = (async () => {
    const vision = await import(`${VISION_CDN}/vision_bundle.mjs`);
    const { ImageSegmenter, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    const modelAssetPath =
      "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
    const tryOrder = isMobileUA()
      ? [{ delegate: "CPU" }, { delegate: "GPU" }, {}]
      : [{ delegate: "GPU" }, { delegate: "CPU" }, {}];
    let lastErr = null;
    for (const del of tryOrder) {
      try {
        imageSegmenter = await ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, ...del },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        imageSegmenter = null;
      }
    }
    if (!imageSegmenter && lastErr) throw lastErr;
    return imageSegmenter;
  })();
  return segmenterPromise;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ hair: Uint8ClampedArray, background: Uint8ClampedArray } | null}
 */
export function buildSegmentationMasks(canvas) {
  if (!imageSegmenter) return null;
  const w = canvas.width;
  const h = canvas.height;
  let result;
  try {
    result = imageSegmenter.segment(canvas);
  } catch {
    return null;
  }
  const cat = result.categoryMask;
  if (!cat) return null;
  let mask;
  try {
    if (typeof cat.getAsUint8Array === "function") {
      mask = cat.getAsUint8Array();
    } else if (cat instanceof Uint8ClampedArray || cat instanceof Uint8Array) {
      mask = cat;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const len = w * h;
  if (mask.length < len) return null;
  const hair = new Uint8ClampedArray(len);
  const background = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    const c = mask[i];
    hair[i] = c === 1 ? 255 : 0;
    background[i] = c === 0 ? 255 : 0;
  }
  return { hair, background };
}

/**
 * Raw category mask from selfie segmenter (0=background, 1=hair, 2–5=person).
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8Array | Uint8ClampedArray | null}
 */
function getSegmentationCategoryMask(canvas) {
  if (!imageSegmenter) return null;
  const w = canvas.width;
  const h = canvas.height;
  let result;
  try {
    result = imageSegmenter.segment(canvas);
  } catch {
    return null;
  }
  const cat = result.categoryMask;
  if (!cat) return null;
  try {
    if (typeof cat.getAsUint8Array === "function") return cat.getAsUint8Array();
    if (cat instanceof Uint8ClampedArray || cat instanceof Uint8Array) return cat;
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {Uint8ClampedArray} alpha length w*h, 0..255
 * @param {number} w
 * @param {number} h
 * @param {number} radius px
 */
function dilateMaskAlpha(alpha, w, h, radius) {
  if (radius <= 0) return;
  const src = new Uint8ClampedArray(alpha);
  const r = Math.min(8, Math.max(1, radius | 0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] > 127) {
        alpha[i] = 255;
        continue;
      }
      let max = 0;
      for (let dy = -r; dy <= r && !max; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (src[yy * w + xx] > 127) {
            max = 255;
            break;
          }
        }
      }
      alpha[i] = max;
    }
  }
}

/**
 * @param {Uint8ClampedArray} alpha
 * @param {number} w
 * @param {number} h
 * @param {number} passes
 */
function boxBlurMaskAlpha(alpha, w, h, passes) {
  for (let p = 0; p < passes; p++) {
    const tmp = new Uint8ClampedArray(alpha);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += tmp[(y + dy) * w + (x + dx)];
          }
        }
        alpha[y * w + x] = Math.round(sum / 9);
      }
    }
  }
}

/**
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {number} w
 * @param {number} h
 */
export function faceCentroidPx(lm, w, h) {
  const idx = [1, 4, 33, 133, 263, 362, 10, 152];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const i of idx) {
    if (!lm[i]) continue;
    sx += lm[i].x * w;
    sy += lm[i].y * h;
    n++;
  }
  if (!n) return { x: w * 0.5, y: h * 0.5 };
  return { x: sx / n, y: sy / n };
}

/**
 * @param {Uint8ClampedArray} cat
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray}
 */
function buildFullPersonMaskFromCategories(cat, w, h) {
  const len = w * h;
  const person = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    person[i] = cat[i] === 0 ? 0 : 255;
  }
  dilateMaskAlpha(person, w, h, 5);
  boxBlurMaskAlpha(person, w, h, 2);
  return person;
}

/**
 * @param {Uint8ClampedArray} person 255 on person pixels
 * @param {number} w
 * @param {number} h
 * @param {number} sx
 * @param {number} sy
 * @param {number} maxR
 */
function nearestPersonPixel(sx, sy, person, w, h, maxR) {
  const ix = Math.round(sx);
  const iy = Math.round(sy);
  if (ix >= 0 && ix < w && iy >= 0 && iy < h && person[iy * w + ix] > 127) {
    return { x: ix, y: iy };
  }
  const rMax = Math.min(maxR, Math.max(w, h));
  for (let r = 1; r <= rMax; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = ix + dx;
        const y = iy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (person[y * w + x] > 127) return { x, y };
      }
    }
  }
  return null;
}

/**
 * @param {Uint8ClampedArray} cat
 * @param {number} w
 * @param {number} h
 * @param {Array<{ faceIndex: number, px: number, py: number }>} seeds
 */
function labelPersonByFaces(cat, w, h, seeds) {
  const len = w * h;
  const labels = new Int16Array(len);
  const person = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    if (cat[i] === 0) {
      labels[i] = -2;
      continue;
    }
    person[i] = 255;
    labels[i] = -1;
  }
  const queue = [];
  for (const s of seeds) {
    const hit = nearestPersonPixel(s.px, s.py, person, w, h, 140);
    if (!hit) continue;
    const i = hit.y * w + hit.x;
    if (labels[i] !== -1) continue;
    labels[i] = s.faceIndex;
    queue.push(hit.x, hit.y, s.faceIndex);
  }
  for (let qi = 0; qi < queue.length; ) {
    const x = queue[qi++];
    const y = queue[qi++];
    const fid = queue[qi++];
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (labels[ni] !== -1) continue;
      labels[ni] = fid;
      queue.push(nx, ny, fid);
    }
  }
  return { labels, person };
}

/**
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray}
 */
function buildFaceFallbackPersonMask(lm, w, h) {
  const c = faceCentroidPx(lm, w, h);
  let rx = w * 0.22;
  let ry = h * 0.32;
  for (const i of [10, 152, 234, 454, 33, 263]) {
    if (!lm[i]) continue;
    rx = Math.max(rx, Math.abs(lm[i].x * w - c.x) * 1.85);
    ry = Math.max(ry, Math.abs(lm[i].y * h - c.y) * 2.35);
  }
  const out = new Uint8ClampedArray(w * h);
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - c.x) / rx;
      const dy = (y - c.y) / ry;
      if (dx * dx + dy * dy <= 1) out[y * w + x] = 255;
    }
  }
  dilateMaskAlpha(out, w, h, 8);
  boxBlurMaskAlpha(out, w, h, 2);
  return out;
}

/**
 * Person silhouette (255 = person) from selfie segmentation.
 * @param {HTMLCanvasElement} canvas
 * @param {{ faceIndex?: number, faces?: Array<Array<{x:number,y:number,z?:number}>> }} [opts]
 * @returns {Uint8ClampedArray | null}
 */
export function buildPersonMaskAlpha(canvas, opts = {}) {
  const cat = getSegmentationCategoryMask(canvas);
  if (!cat) return null;
  const w = canvas.width;
  const h = canvas.height;
  const len = w * h;
  if (cat.length < len) return null;

  const faces = opts.faces && opts.faces.length ? opts.faces : null;
  const faceIndex = opts.faceIndex ?? 0;

  if (!faces || faces.length <= 1) {
    if (faces && faces.length === 1 && faces[0]) {
      const c0 = faceCentroidPx(faces[0], w, h);
      const seeds = [{ faceIndex: 0, px: c0.x, py: c0.y }];
      const { labels } = labelPersonByFaces(cat, w, h, seeds);
      const out = new Uint8ClampedArray(len);
      let any = false;
      for (let i = 0; i < len; i++) {
        if (labels[i] === 0) {
          out[i] = 255;
          any = true;
        }
      }
      if (any) {
        dilateMaskAlpha(out, w, h, 5);
        boxBlurMaskAlpha(out, w, h, 2);
        return out;
      }
      return buildFaceFallbackPersonMask(faces[0], w, h);
    }
    return buildFullPersonMaskFromCategories(cat, w, h);
  }

  const seeds = faces.map((lm, idx) => {
    const c = faceCentroidPx(lm, w, h);
    return { faceIndex: idx, px: c.x, py: c.y };
  });
  const { labels } = labelPersonByFaces(cat, w, h, seeds);
  const out = new Uint8ClampedArray(len);
  let any = false;
  const pick = Math.max(0, Math.min(faceIndex, faces.length - 1));
  for (let i = 0; i < len; i++) {
    if (labels[i] === pick) {
      out[i] = 255;
      any = true;
    }
  }
  if (!any && faces[pick]) return buildFaceFallbackPersonMask(faces[pick], w, h);
  dilateMaskAlpha(out, w, h, 5);
  boxBlurMaskAlpha(out, w, h, 2);
  return out;
}

/**
 * PNG mask for Comet/OpenAI edits: transparent = edit (remove), opaque = keep.
 * @param {number} w
 * @param {number} h
 * @param {Uint8ClampedArray} personAlpha 255 on person
 * @param {number} outW
 * @param {number} outH
 * @returns {string} base64 PNG without data-URL prefix
 */
export function personMaskToPngBase64(w, h, personAlpha, outW, outH) {
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const fctx = full.getContext("2d");
  const id = fctx.createImageData(w, h);
  const d = id.data;
  for (let i = 0; i < w * h; i++) {
    const onPerson = personAlpha[i] > 48;
    const o = i * 4;
    d[o] = 255;
    d[o + 1] = 255;
    d[o + 2] = 255;
    d[o + 3] = onPerson ? 0 : 255;
  }
  fctx.putImageData(id, 0, 0);
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, 0, 0, outW, outH);
  return out.toDataURL("image/png").split(",")[1];
}

/**
 * @typedef {Object} FaceMaskBundle
 * @property {Uint8ClampedArray} skin
 * @property {HTMLCanvasElement} lip
 * @property {Uint8ClampedArray} lipAlpha
 * @property {HTMLCanvasElement} teeth
 * @property {Uint8ClampedArray} teethAlpha
 * @property {HTMLCanvasElement} leftIris
 * @property {HTMLCanvasElement} rightIris
 * @property {HTMLCanvasElement} leftSclera
 * @property {HTMLCanvasElement} rightSclera
 * @property {Uint8ClampedArray} leftIrisAlpha
 * @property {Uint8ClampedArray} rightIrisAlpha
 * @property {Uint8ClampedArray} leftScleraAlpha
 * @property {Uint8ClampedArray} rightScleraAlpha
 * @property {HTMLCanvasElement} cheeks
 * @property {Uint8ClampedArray} cheeksAlpha
 * @property {Uint8ClampedArray | null} hair
 * @property {Uint8ClampedArray | null} background
 */

/**
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {HTMLCanvasElement} canvas
 * @param {{ withSegmentation?: boolean }} opts
 * @returns {FaceMaskBundle}
 */
export function buildFaceMaskBundle(lm, canvas, opts = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const skinCv = buildSkinMaskCanvas(lm, w, h);
  const lipCv = buildLipMaskCanvas(lm, w, h);
  const teethCv = buildTeethMaskCanvas(lm, w, h, canvas);
  const leftIris = buildIrisMaskCanvas(lm, w, h, "left");
  const rightIris = buildIrisMaskCanvas(lm, w, h, "right");
  const leftSclera = buildScleraMaskCanvas(lm, w, h, "left");
  const rightSclera = buildScleraMaskCanvas(lm, w, h, "right");
  const cheeks = buildCheekMaskCanvas(lm, w, h);

  let hair = null;
  let background = null;
  if (opts.withSegmentation !== false && imageSegmenter) {
    const seg = buildSegmentationMasks(canvas);
    if (seg) {
      hair = seg.hair;
      background = seg.background;
    }
  }

  return {
    skin: maskAlphaFromCanvas(skinCv),
    lip: lipCv,
    lipAlpha: maskAlphaFromCanvas(lipCv),
    teeth: teethCv,
    teethAlpha: maskAlphaFromCanvas(teethCv),
    leftIris,
    rightIris,
    leftSclera,
    rightSclera,
    leftIrisAlpha: maskAlphaFromCanvas(leftIris),
    rightIrisAlpha: maskAlphaFromCanvas(rightIris),
    leftScleraAlpha: maskAlphaFromCanvas(leftSclera),
    rightScleraAlpha: maskAlphaFromCanvas(rightSclera),
    cheeks,
    cheeksAlpha: maskAlphaFromCanvas(cheeks),
    hair,
    background,
  };
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
 * @returns {Array<{ landmarks: Array<{x:number,y:number,z?:number}>, cx: number, cy: number }>}
 */
export function detectAllLandmarks(canvas) {
  if (!landmarker) return [];

  const collect = (c) => {
    const res = landmarker.detect(c);
    const raw = res.faceLandmarks || [];
    const valid = raw.filter((lm) => lm && lm.length >= 468);
    const w = c.width;
    const h = c.height;
    return valid
      .map((landmarks) => {
        const c0 = faceCentroidPx(landmarks, w, h);
        return { landmarks, cx: c0.x, cy: c0.y };
      })
      .sort((a, b) => a.cx - b.cx);
  };

  let list = collect(canvas);
  if (list.length) return list;

  const W = canvas.width;
  const H = canvas.height;
  if (W < 32 || H < 32) return [];

  const scales = [1.75, 2.25, 1.35, 0.85];
  for (const sc of scales) {
    const tw = Math.round(Math.min(1920, Math.max(96, W * sc)));
    const th = Math.round(Math.min(1920, Math.max(96, H * sc)));
    if (tw === W && th === H) continue;
    const mc = document.createElement("canvas");
    mc.width = tw;
    mc.height = th;
    const mx = mc.getContext("2d");
    mx.drawImage(canvas, 0, 0, tw, th);
    list = collect(mc);
    if (list.length) {
      const sx = W / tw;
      const sy = H / th;
      return list.map((f) => ({
        landmarks: f.landmarks,
        cx: f.cx * sx,
        cy: f.cy * sy,
      }));
    }
  }
  return [];
}

/**
 * @param {Array<Array<{x:number,y:number,z?:number}>>} faces
 * @param {number} w
 * @param {number} h
 */
export function pickLargestFaceIndex(faces, w, h) {
  if (!faces || !faces.length) return 0;
  let best = 0;
  let bestArea = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    const lm = faces[fi];
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    let any = false;
    for (const i of [10, 152, 234, 454, 1, 33, 263]) {
      if (!lm[i]) continue;
      any = true;
      minX = Math.min(minX, lm[i].x);
      maxX = Math.max(maxX, lm[i].x);
      minY = Math.min(minY, lm[i].y);
      maxY = Math.max(maxY, lm[i].y);
    }
    const area = any ? (maxX - minX) * (maxY - minY) : 0;
    if (area > bestArea) {
      bestArea = area;
      best = fi;
    }
  }
  return best;
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

/**
 * Even skin tone + reduce redness in skin mask.
 */
export function applySkinTone(workCanvas, skinMask, strength) {
  if (strength <= 0) return;
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(0, 0, w, h);
  const od = orig.data;
  const out = new ImageData(w, h);
  const d = out.data;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ma = (skinMask[y * w + x] / 255) * strength;
      let r = od[pi];
      let g = od[pi + 1];
      let b = od[pi + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const avg = (r + g + b) / 3;
      r += (avg - r) * 0.22 * ma;
      g += (avg - g) * 0.22 * ma;
      b += (avg - b) * 0.18 * ma;
      const redExcess = Math.max(0, r - (g + b) * 0.52);
      r -= redExcess * 0.35 * ma;
      g += redExcess * 0.08 * ma;
      const lift = (128 - L) * 0.06 * ma;
      r += lift;
      g += lift;
      b += lift;
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = od[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Brighten iris regions.
 */
export function applyIrisBright(workCanvas, leftAlpha, rightAlpha, strength) {
  if (strength <= 0) return;
  applyMaskedLift(workCanvas, leftAlpha, strength, { sat: 1.12, lift: 14 });
  applyMaskedLift(workCanvas, rightAlpha, strength, { sat: 1.12, lift: 14 });
}

/**
 * Whiten sclera (desaturate + lift).
 */
export function applyScleraWhiten(workCanvas, leftAlpha, rightAlpha, strength) {
  if (strength <= 0) return;
  applyMaskedLift(workCanvas, leftAlpha, strength, { sat: 0.82, lift: 18, blueCut: 4 });
  applyMaskedLift(workCanvas, rightAlpha, strength, { sat: 0.82, lift: 18, blueCut: 4 });
}

function applyMaskedLift(workCanvas, maskAlpha, strength, { sat = 1, lift = 12, blueCut = 0 }) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(0, 0, w, h);
  const od = orig.data;
  const out = new ImageData(w, h);
  const d = out.data;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ma = (maskAlpha[y * w + x] / 255) * strength;
      let r = od[pi];
      let g = od[pi + 1];
      let b = od[pi + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      r += lift * ma;
      g += lift * 0.98 * ma;
      b += (lift * 0.9 - blueCut) * ma;
      r = L + (r - L) * (1 + (sat - 1) * ma);
      g = L + (g - L) * (1 + (sat - 1) * ma);
      b = L + (b - L) * (1 + (sat - 1) * ma);
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = od[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Teeth whitening using teeth mask.
 */
export function applyTeethWhite(workCanvas, teethAlpha, strength) {
  if (strength <= 0) return;
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(0, 0, w, h);
  const od = orig.data;
  const out = new ImageData(w, h);
  const d = out.data;
  const str = strength * 0.65;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ma = (teethAlpha[y * w + x] / 255) * str;
      let r = od[pi];
      let g = od[pi + 1];
      let b = od[pi + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const lift = (255 - L) * 0.35 * ma + 22 * ma;
      r += lift;
      g += lift * 0.98;
      b += lift * 0.92;
      const sat = 1 - 0.25 * ma;
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = od[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Natural shine in hair mask.
 */
export function applyHairShineLocal(workCanvas, hairMask, strength) {
  if (!hairMask || strength <= 0) return;
  const w = workCanvas.width;
  const h = workCanvas.height;
  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(0, 0, w, h);
  const blurred = blurCanvasToImageData(workCanvas, 1.2);
  const bd = blurred.data;
  const od = orig.data;
  const out = new ImageData(w, h);
  const d = out.data;
  const str = strength * 0.55;
  let pi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ma = (hairMask[y * w + x] / 255) * str;
      let r = od[pi];
      let g = od[pi + 1];
      let b = od[pi + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const lift = 12 * ma;
      const sharp = (od[pi] - bd[pi]) * 0.35 * ma;
      r += lift + sharp;
      g += lift * 0.98 + (od[pi + 1] - bd[pi + 1]) * 0.35 * ma;
      b += lift * 0.95 + (od[pi + 2] - bd[pi + 2]) * 0.35 * ma;
      const sat = 1 + 0.08 * ma;
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
      d[pi] = clamp(r, 0, 255);
      d[pi + 1] = clamp(g, 0, 255);
      d[pi + 2] = clamp(b, 0, 255);
      d[pi + 3] = od[pi + 3];
      pi += 4;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Local frequency separation in brush disk.
 */
export function applyLocalSkinSmooth(workCanvas, cx, cy, radius, skinMask, strength, sigmas = {}) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(w, Math.ceil(cx + radius));
  const y1 = Math.min(h, Math.ceil(cy + radius));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 2 || rh < 2) return;

  const patch = document.createElement("canvas");
  patch.width = rw;
  patch.height = rh;
  patch.getContext("2d").drawImage(workCanvas, x0, y0, rw, rh, 0, 0, rw, rh);

  const fine = sigmas.fine ?? 3;
  const coarse = sigmas.coarse ?? 10;
  const lowFine = blurCanvasToImageData(patch, fine);
  const t2 = document.createElement("canvas");
  t2.width = rw;
  t2.height = rh;
  t2.getContext("2d").putImageData(lowFine, 0, 0);
  const lowSmooth = blurCanvasToImageData(t2, coarse);

  const ctx = workCanvas.getContext("2d");
  const orig = ctx.getImageData(x0, y0, rw, rh);
  const lf = lowFine.data;
  const ls = lowSmooth.data;
  const o = orig.data;
  const r2 = radius * radius;

  for (let py = 0; py < rh; py++) {
    for (let px = 0; px < rw; px++) {
      const gx = x0 + px;
      const gy = y0 + py;
      const dist2 = (gx - cx) ** 2 + (gy - cy) ** 2;
      if (dist2 > r2) continue;
      let ma = strength * (1 - dist2 / r2);
      ma *= ma * (3 - 2 * ma);
      if (skinMask) {
        ma *= 0.15 + 0.85 * (skinMask[gy * w + gx] / 255);
      }
      if (ma < 0.02) continue;
      const i = (py * rw + px) * 4;
      const hf0 = o[i] - lf[i];
      const hf1 = o[i + 1] - lf[i + 1];
      const hf2 = o[i + 2] - lf[i + 2];
      const nr = clamp(ls[i] + hf0, 0, 255);
      const ng = clamp(ls[i + 1] + hf1, 0, 255);
      const nb = clamp(ls[i + 2] + hf2, 0, 255);
      o[i] = o[i] * (1 - ma) + nr * ma;
      o[i + 1] = o[i + 1] * (1 - ma) + ng * ma;
      o[i + 2] = o[i + 2] * (1 - ma) + nb * ma;
    }
  }
  ctx.putImageData(orig, x0, y0);
}
