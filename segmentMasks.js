/**
 * Landmark-driven masks: teeth, iris, sclera, cheeks.
 */

import {
  INNER_LIP_INDICES,
  LEFT_EYE_INDICES,
  RIGHT_EYE_INDICES,
  LEFT_IRIS_INDICES,
  RIGHT_IRIS_INDICES,
  LEFT_CHEEK_INDICES,
  RIGHT_CHEEK_INDICES,
  MOUTH_INNER_INDICES,
} from "./landmarkPaths.js";
function lmPx(lm, i, w, h) {
  const p = lm[i];
  return { x: p.x * w, y: p.y * h };
}

function convexHull(pts) {
  const uniq = [];
  const seen = new Set();
  for (const p of pts) {
    const k = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
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

function featherCanvas(src, blurPx = 5) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const bx = out.getContext("2d");
  bx.filter = `blur(${blurPx}px)`;
  bx.drawImage(src, 0, 0);
  bx.filter = "none";
  bx.drawImage(out, 0, 0);
  return out;
}

function fillPolygonIndices(mctx, lm, w, h, indices) {
  if (!indices.length) return;
  mctx.beginPath();
  const p0 = lmPx(lm, indices[0], w, h);
  mctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < indices.length; k++) {
    const p = lmPx(lm, indices[k], w, h);
    mctx.lineTo(p.x, p.y);
  }
  mctx.closePath();
  mctx.fill();
}

function drawEyeEllipse(mctx, lm, w, h, eyeIndices, scaleX, scaleY) {
  const pts = eyeIndices.map((i) => lmPx(lm, i, w, h));
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
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = ((maxX - minX) / 2) * scaleX;
  const ry = ((maxY - minY) / 2) * scaleY;
  mctx.beginPath();
  mctx.ellipse(cx, cy, Math.max(2, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
  mctx.fill();
  return { cx, cy, rx, ry };
}

function irisEllipseFromIndices(mctx, lm, w, h, irisIndices, fallbackEyeIndices) {
  const valid = irisIndices.filter((i) => lm[i]);
  if (valid.length >= 3) {
    const pts = valid.map((i) => lmPx(lm, i, w, h));
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let r = 0;
    for (const p of pts) {
      r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    }
    mctx.beginPath();
    mctx.ellipse(cx, cy, Math.max(2, r * 1.15), Math.max(2, r * 1.05), 0, 0, Math.PI * 2);
    mctx.fill();
    return;
  }
  drawEyeEllipse(mctx, lm, w, h, fallbackEyeIndices, 0.38, 0.42);
}

/**
 * Teeth: inner mouth minus lips, refined by brightness vs lip color.
 * @param {HTMLCanvasElement} sourceCanvas
 */
export function buildTeethMaskCanvas(lm, w, h, sourceCanvas = null) {
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  fillPolygonIndices(mx, lm, w, h, MOUTH_INNER_INDICES);

  mx.globalCompositeOperation = "destination-out";
  fillPolygonIndices(mx, lm, w, h, INNER_LIP_INDICES);
  mx.globalCompositeOperation = "source-over";

  if (sourceCanvas) {
    const ctx = sourceCanvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const mask = mx.getImageData(0, 0, w, h);
    const md = mask.data;
    const id = img.data;
    for (let i = 0; i < md.length; i += 4) {
      if (md[i] < 8) continue;
      const r = id[i];
      const g = id[i + 1];
      const b = id[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (L < 95 || sat > 85) {
        md[i] = md[i + 1] = md[i + 2] = 0;
      } else if (L < 140) {
        const t = (L - 95) / 45;
        const v = Math.round(255 * t);
        md[i] = md[i + 1] = md[i + 2] = v;
      }
    }
    mx.putImageData(mask, 0, 0);
  }

  return featherCanvas(m, 3);
}

export function buildIrisMaskCanvas(lm, w, h, side) {
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  if (side === "left") {
    irisEllipseFromIndices(mx, lm, w, h, LEFT_IRIS_INDICES, LEFT_EYE_INDICES);
  } else {
    irisEllipseFromIndices(mx, lm, w, h, RIGHT_IRIS_INDICES, RIGHT_EYE_INDICES);
  }
  return featherCanvas(m, 2);
}

/** Sclera: eye hull minus iris. */
export function buildScleraMaskCanvas(lm, w, h, side) {
  const eyeIdx = side === "left" ? LEFT_EYE_INDICES : RIGHT_EYE_INDICES;
  const irisIdx = side === "left" ? LEFT_IRIS_INDICES : RIGHT_IRIS_INDICES;
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);
  mx.fillStyle = "#fff";
  const hull = convexHull(eyeIdx.map((i) => lmPx(lm, i, w, h)));
  if (hull.length >= 3) {
    mx.beginPath();
    mx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) mx.lineTo(hull[i].x, hull[i].y);
    mx.closePath();
    mx.fill();
  }
  mx.globalCompositeOperation = "destination-out";
  irisEllipseFromIndices(mx, lm, w, h, irisIdx, eyeIdx);
  mx.globalCompositeOperation = "source-over";
  return featherCanvas(m, 4);
}

export function buildCheekMaskCanvas(lm, w, h) {
  const m = document.createElement("canvas");
  m.width = w;
  m.height = h;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, w, h);

  const drawCheek = (indices) => {
    const pts = indices.map((i) => lmPx(lm, i, w, h));
    if (pts.length < 2) return;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let spread = 0;
    for (const p of pts) {
      spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy));
    }
    const rx = spread * 1.35;
    const ry = spread * 1.05;
    const g = mx.createRadialGradient(cx, cy, 0, cx, cy, rx);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.55, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g;
    mx.beginPath();
    mx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    mx.fill();
  };

  drawCheek(LEFT_CHEEK_INDICES);
  drawCheek(RIGHT_CHEEK_INDICES);
  return featherCanvas(m, 8);
}
