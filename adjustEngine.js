/**
 * Коррекции лица по MediaPipe landmarks: деформация (RBF + сетка) и косметика поверх.
 * Упрощённые аналоги FaceTune — без 3D-модели.
 */

import {
  lmPx,
  convexHull,
  applyAutoEyes,
  applyAutoLip,
  applyIrisBright,
  applyScleraWhiten,
  applyTeethWhite,
} from "./engine.js";
import { applyMakeup } from "./makeupEngine.js";
import {
  FACE_OVAL_INDICES,
  LEFT_EYE_INDICES,
  RIGHT_EYE_INDICES,
  LEFT_BROW_INDICES,
  RIGHT_BROW_INDICES,
} from "./landmarkPaths.js";

/** @typedef {Record<string, number>} AdjustParams */

/** @returns {AdjustParams} */
export function defaultAdjustParams() {
  return {
    nose_size: 0,
    nose_lift: 0,
    nose_bridge: 0,
    nose_tip: 0,
    face_size: 0,
    head_narrow: 0,
    v_shape: 0,
    chin_width: 0,
    chin_len: 0,
    chin_point: 0,
    cheek_slim: 0,
    forehead: 0,
    eye_bags: 0,
    eye_bright: 0,
    eye_enlarge: 0,
    eye_whiten: 0,
    eye_lashes: 0,
    eye_liner: 0,
    eye_brows: 0,
    eye_shadow: 0,
    teeth_white: 0,
    smile: 0,
    lip_plump: 0,
    lip_tint: 0,
    lip_width: 0,
    blush: 0,
    contour: 0,
    lip_gloss: 0,
  };
}

function s(v) {
  return Math.max(0, Math.min(1, (Number(v) || 0) / 100));
}

function faceBBox(lm, w, h, pad = 0.06) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of FACE_OVAL_INDICES) {
    const p = lmPx(lm, i, w, h);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const pw = maxX - minX;
  const ph = maxY - minY;
  const px = pw * pad;
  const py = ph * pad;
  return {
    x0: Math.max(0, Math.floor(minX - px)),
    y0: Math.max(0, Math.floor(minY - py)),
    x1: Math.min(w - 1, Math.ceil(maxX + px)),
    y1: Math.min(h - 1, Math.ceil(maxY + py)),
    fw: pw,
    fh: ph,
  };
}

/**
 * @typedef {{ x: number, y: number, dx: number, dy: number, sigma: number }} Control
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {number} w
 * @param {number} h
 * @param {AdjustParams} p
 * @param {{ fw: number, fh: number }} bb
 * @returns {Control[]}
 */
function buildControls(lm, w, h, p, bb) {
  const controls = [];
  /** Масштаб от размера лица в кадре — раньше unit≈8–12 даже на 2K, визуально «ноль». */
  const faceSpan = Math.max(bb.fw, bb.fh, 32);
  const unit = Math.max(14, faceSpan * 0.034);
  const sigmaN = bb.fw * 0.055;
  const sigmaW = bb.fw * 0.09;
  const midX = lmPx(lm, 6, w, h).x;

  const add = (idx, dx, dy, sig, str) => {
    if (!str) return;
    const pt = lmPx(lm, idx, w, h);
    controls.push({ x: pt.x, y: pt.y, dx: dx * str, dy: dy * str, sigma: sig });
  };

  const ns = s(p.nose_size);
  if (ns > 0) {
    add(48, (midX - lmPx(lm, 48, w, h).x) * 0.34, 0, sigmaN, ns);
    add(278, (midX - lmPx(lm, 278, w, h).x) * 0.34, 0, sigmaN, ns);
    add(98, (midX - lmPx(lm, 98, w, h).x) * 0.2, 0, sigmaN * 0.85, ns * 0.7);
    add(327, (midX - lmPx(lm, 327, w, h).x) * 0.2, 0, sigmaN * 0.85, ns * 0.7);
  }
  const nl = s(p.nose_lift);
  if (nl > 0) {
    add(1, 0, -unit * 2.35, sigmaN * 0.75, nl);
    add(2, 0, -unit * 1.45, sigmaN * 0.65, nl);
    add(4, 0, -unit * 1.15, sigmaN * 0.55, nl * 0.6);
  }
  const nb = s(p.nose_bridge);
  if (nb > 0) {
    add(168, (midX - lmPx(lm, 168, w, h).x) * 0.24, 0, sigmaW * 0.7, nb);
    add(6, (midX - lmPx(lm, 6, w, h).x) * 0.16, 0, sigmaW * 0.55, nb);
    add(197, (midX - lmPx(lm, 197, w, h).x) * 0.13, 0, sigmaW * 0.5, nb * 0.8);
  }
  const nt = s(p.nose_tip);
  if (nt > 0) {
    add(1, 0, -unit * 1.25, sigmaN * 0.55, nt);
    add(19, 0, -unit * 0.65, sigmaN * 0.45, nt * 0.6);
  }

  const cx = (lmPx(lm, 1, w, h).x + lmPx(lm, 152, w, h).x) / 2;
  const cy = (lmPx(lm, 1, w, h).y + lmPx(lm, 152, w, h).y) / 2;
  const fs = s(p.face_size);
  if (fs > 0) {
    for (const idx of [10, 152, 234, 454, 338, 297, 172, 58]) {
      const pt = lmPx(lm, idx, w, h);
      const ang = Math.atan2(pt.y - cy, pt.x - cx);
      const dist = Math.hypot(pt.x - cx, pt.y - cy);
      const extra = dist * 0.12 * fs;
      controls.push({
        x: pt.x,
        y: pt.y,
        dx: Math.cos(ang) * extra,
        dy: Math.sin(ang) * extra,
        sigma: sigmaW * 1.05,
      });
    }
  }

  const hn = s(p.head_narrow);
  if (hn > 0) {
    const p234 = lmPx(lm, 234, w, h);
    const p454 = lmPx(lm, 454, w, h);
    controls.push({
      x: p234.x,
      y: p234.y,
      dx: unit * 2.1 * hn,
      dy: 0,
      sigma: sigmaW * 1.1,
    });
    controls.push({
      x: p454.x,
      y: p454.y,
      dx: -unit * 2.1 * hn,
      dy: 0,
      sigma: sigmaW * 1.1,
    });
  }

  const vs = s(p.v_shape);
  if (vs > 0) {
    const p152 = lmPx(lm, 152, w, h);
    controls.push({
      x: p152.x,
      y: p152.y,
      dx: (midX - p152.x) * 0.2 * vs,
      dy: -unit * 2.2 * vs,
      sigma: sigmaW * 0.95,
    });
    add(176, (midX - lmPx(lm, 176, w, h).x) * 0.1 * vs, -unit * 0.52 * vs, sigmaW * 0.75, vs);
    add(400, (midX - lmPx(lm, 400, w, h).x) * 0.1 * vs, -unit * 0.52 * vs, sigmaW * 0.75, vs);
  }

  const cw = s(p.chin_width);
  if (cw > 0) {
    add(148, -unit * 1.35 * cw, 0, sigmaN, cw);
    add(377, unit * 1.35 * cw, 0, sigmaN, cw);
    add(152, 0, unit * 0.38 * cw, sigmaN * 0.9, cw * 0.4);
  }

  const cl = s(p.chin_len);
  if (cl > 0) {
    add(152, 0, unit * 2.35 * cl, sigmaW * 0.85, cl);
    add(176, 0, unit * 1.05 * cl, sigmaN * 0.8, cl * 0.7);
    add(400, 0, unit * 1.05 * cl, sigmaN * 0.8, cl * 0.7);
  }

  const cp = s(p.chin_point);
  if (cp > 0) {
    add(148, unit * 0.82 * cp, unit * 0.3 * cp, sigmaN * 0.85, cp);
    add(377, -unit * 0.82 * cp, unit * 0.3 * cp, sigmaN * 0.85, cp);
    add(152, 0, -unit * 0.52 * cp, sigmaN * 0.65, cp * 0.6);
  }

  const sm = s(p.smile);
  if (sm > 0) {
    add(61, 0, -unit * 1.75 * sm, sigmaN * 0.75, sm);
    add(291, 0, -unit * 1.75 * sm, sigmaN * 0.75, sm);
  }

  const lp = s(p.lip_plump);
  if (lp > 0) {
    for (const idx of [61, 185, 40, 39, 37, 267, 269, 270, 409, 291]) {
      const pt = lmPx(lm, idx, w, h);
      const vx = pt.x - midX;
      const vy = pt.y - lmPx(lm, 13, w, h).y;
      const len = Math.hypot(vx, vy) || 1;
      controls.push({
        x: pt.x,
        y: pt.y,
        dx: (vx / len) * unit * 0.98 * lp,
        dy: (vy / len) * unit * 0.68 * lp,
        sigma: sigmaN * 0.65,
      });
    }
  }

  const cs = s(p.cheek_slim);
  if (cs > 0) {
    add(234, unit * 1.65 * cs, 0, sigmaW, cs);
    add(454, -unit * 1.65 * cs, 0, sigmaW, cs);
    add(205, unit * 0.9 * cs, 0, sigmaW * 0.85, cs * 0.75);
    add(425, -unit * 0.9 * cs, 0, sigmaW * 0.85, cs * 0.75);
  }

  const fh = s(p.forehead);
  if (fh > 0) {
    add(10, 0, -unit * 1.45 * fh, sigmaW * 0.9, fh);
    add(338, (midX - lmPx(lm, 338, w, h).x) * 0.08 * fh, -unit * 0.55 * fh, sigmaW * 0.75, fh * 0.7);
    add(297, (midX - lmPx(lm, 297, w, h).x) * 0.08 * fh, -unit * 0.55 * fh, sigmaW * 0.75, fh * 0.7);
  }

  const es = s(p.eye_size);
  if (es > 0) {
    for (const idx of [33, 133, 263, 362]) {
      const pt = lmPx(lm, idx, w, h);
      const vx = pt.x - midX;
      const vy = pt.y - lmPx(lm, idx === 33 || idx === 133 ? 159 : 386, w, h).y;
      const len = Math.hypot(vx, vy) || 1;
      controls.push({
        x: pt.x,
        y: pt.y,
        dx: (vx / len) * unit * 0.75 * es,
        dy: (vy / len) * unit * 0.45 * es,
        sigma: sigmaN * 0.55,
      });
    }
  }

  const et = s(p.eye_tilt);
  if (et > 0) {
    add(33, unit * 0.35 * et, -unit * 0.55 * et, sigmaN * 0.5, et);
    add(263, -unit * 0.35 * et, -unit * 0.55 * et, sigmaN * 0.5, et);
  }

  const lw = s(p.lip_width);
  if (lw > 0) {
    add(61, -unit * 0.85 * lw, 0, sigmaN * 0.6, lw);
    add(291, unit * 0.85 * lw, 0, sigmaN * 0.6, lw);
  }

  return controls;
}

function dispAt(controls, x, y, midX, symmetry, maxDisp) {
  let dx = 0;
  let dy = 0;
  let wsum = 0;
  for (const c of controls) {
    const ddx = x - c.x;
    const ddy = y - c.y;
    const d2 = ddx * ddx + ddy * ddy;
    const s2 = c.sigma * c.sigma * 2;
    const w = Math.exp(-d2 / Math.max(1e-6, s2));
    dx += w * c.dx;
    dy += w * c.dy;
    wsum += w;
  }
  if (wsum < 1e-8) return { dx: 0, dy: 0 };
  dx /= wsum;
  dy /= wsum;

  if (symmetry && midX != null) {
    let mdx = 0;
    let mdy = 0;
    let mw = 0;
    const mx = 2 * midX - x;
    for (const c of controls) {
      const ddx = mx - c.x;
      const ddy = y - c.y;
      const d2 = ddx * ddx + ddy * ddy;
      const s2 = c.sigma * c.sigma * 2;
      const w = Math.exp(-d2 / Math.max(1e-6, s2));
      mdx += w * c.dx;
      mdy += w * c.dy;
      mw += w;
    }
    if (mw > 1e-8) {
      mdx /= mw;
      mdy /= mw;
      dx = (dx - mdx) * 0.5;
      dy = (dy + mdy) * 0.5;
    }
  }

  const mag = Math.hypot(dx, dy);
  if (mag > maxDisp) {
    const sc = maxDisp / mag;
    dx *= sc;
    dy *= sc;
  }
  return { dx, dy };
}

function sampleBilinear(data, w, h, x, y) {
  const xn = Math.min(w - 1.000001, Math.max(0, x));
  const yn = Math.min(h - 1.000001, Math.max(0, y));
  const x0 = Math.floor(xn);
  const y0 = Math.floor(yn);
  if (x0 >= w - 1 || y0 >= h - 1) return null;
  const fx = xn - x0;
  const fy = yn - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x0 + 1) * 4;
  const i01 = ((y0 + 1) * w + x0) * 4;
  const i11 = ((y0 + 1) * w + x0 + 1) * 4;
  const lerp = (a, b, t) => a + (b - a) * t;
  const r = lerp(lerp(data[i00], data[i10], fx), lerp(data[i01], data[i11], fx), fy);
  const g = lerp(lerp(data[i00 + 1], data[i10 + 1], fx), lerp(data[i01 + 1], data[i11 + 1], fx), fy);
  const b = lerp(lerp(data[i00 + 2], data[i10 + 2], fx), lerp(data[i01 + 2], data[i11 + 2], fx), fy);
  const a = lerp(lerp(data[i00 + 3], data[i10 + 3], fx), lerp(data[i01 + 3], data[i11 + 3], fx), fy);
  return { r, g, b, a };
}

/**
 * Обратная деформация: выходной пиксель (x,y) берёт цвет из входа (x-dx, y-dy).
 * @param {ImageData} src
 * @param {Control[]} controls
 * @param {{ x0: number, y0: number, x1: number, y1: number }} bbox
 * @param {number} gridN
 */
function warpBackward(src, w, h, bbox, controls, gridN = 20, warpOpts = {}) {
  const { x0, y0, x1, y1, fw } = bbox;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4) return src;

  const midX = (x0 + x1) / 2;
  const symmetry = !!warpOpts.symmetry;
  const maxDisp = Math.max(8, (fw || bw) * 0.12);
  const feather = Math.max(12, (fw || bw) * 0.08);

  const gx = gridN;
  const gy = gridN;
  const cellX = bw / gx;
  const cellY = bh / gy;
  const gridDx = new Float32Array((gx + 1) * (gy + 1));
  const gridDy = new Float32Array((gx + 1) * (gy + 1));

  for (let j = 0; j <= gy; j++) {
    for (let i = 0; i <= gx; i++) {
      const px = x0 + i * cellX;
      const py = y0 + j * cellY;
      const d = dispAt(controls, px, py, midX, symmetry, maxDisp);
      const idx = j * (gx + 1) + i;
      gridDx[idx] = d.dx;
      gridDy[idx] = d.dy;
    }
  }

  const out = new ImageData(w, h);
  out.data.set(src.data);
  const sd = src.data;
  const od = out.data;

  const edgeFeather = (px, py) => {
    const dL = px - x0;
    const dR = x1 - px;
    const dT = py - y0;
    const dB = y1 - py;
    const d = Math.min(dL, dR, dT, dB);
    if (d >= feather) return 1;
    const t = d / feather;
    return t * t * (3 - 2 * t);
  };

  const interpDisp = (px, py) => {
    const lx = (px - x0) / cellX;
    const ly = (py - y0) / cellY;
    const ix = Math.min(gx - 1, Math.max(0, Math.floor(lx)));
    const iy = Math.min(gy - 1, Math.max(0, Math.floor(ly)));
    const fx = lx - ix;
    const fy = ly - iy;
    const i00 = iy * (gx + 1) + ix;
    const i10 = i00 + 1;
    const i01 = i00 + (gx + 1);
    const i11 = i01 + 1;
    const lerp = (a, b, t) => a + (b - a) * t;
    const dx = lerp(lerp(gridDx[i00], gridDx[i10], fx), lerp(gridDx[i01], gridDx[i11], fx), fy);
    const dy = lerp(lerp(gridDy[i00], gridDy[i10], fx), lerp(gridDy[i01], gridDy[i11], fx), fy);
    const f = edgeFeather(px, py);
    return { dx: dx * f, dy: dy * f };
  };

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const { dx, dy } = interpDisp(x, y);
      const sx = x - dx;
      const sy = y - dy;
      const samp = sampleBilinear(sd, w, h, sx, sy);
      const o = (y * w + x) * 4;
      if (samp) {
        od[o] = samp.r;
        od[o + 1] = samp.g;
        od[o + 2] = samp.b;
        od[o + 3] = samp.a;
      }
    }
  }
  return out;
}

function shiftLandmarks(lm, w, h, controls, bbox, warpOpts) {
  if (!controls.length) return lm;
  const midX = bbox ? (bbox.x0 + bbox.x1) / 2 : w / 2;
  const maxDisp = bbox ? Math.max(8, bbox.fw * 0.12) : w * 0.12;
  return lm.map((p) => {
    const px = p.x * w;
    const py = p.y * h;
    const d = dispAt(controls, px, py, midX, !!warpOpts?.symmetry, maxDisp);
    return { x: (px + d.dx) / w, y: (py + d.dy) / h, z: p.z };
  });
}

function drawUpperLidPathLeft(ctx, lm, w, h) {
  ctx.beginPath();
  const upper = [263, 466, 388, 387, 386, 385, 384, 398];
  const p0 = lmPx(lm, upper[0], w, h);
  ctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < upper.length; k++) {
    const p = lmPx(lm, upper[k], w, h);
    ctx.lineTo(p.x, p.y);
  }
}

function drawUpperLidPathRight(ctx, lm, w, h) {
  ctx.beginPath();
  const upper = [33, 246, 161, 160, 159, 158, 157, 173];
  const p0 = lmPx(lm, upper[0], w, h);
  ctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < upper.length; k++) {
    const p = lmPx(lm, upper[k], w, h);
    ctx.lineTo(p.x, p.y);
  }
}

function drawLashesAlongPath(ctx, lm, w, h, upperIdx, strength) {
  const pts = upperIdx.map((i) => lmPx(lm, i, w, h));
  const n = pts.length;
  for (let k = 0; k < n - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const steps = 3 + Math.floor(strength * 4);
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const ang = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2;
      const len = 2 + strength * 5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
    }
  }
}

function fillPolygon(ctx, lm, w, h, indices) {
  ctx.beginPath();
  const p0 = lmPx(lm, indices[0], w, h);
  ctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < indices.length; k++) {
    const p = lmPx(lm, indices[k], w, h);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @param {AdjustParams} p
 * @param {{ masks?: import('./engine.js').FaceMaskBundle, lipColor?: string, symmetry?: boolean }} opts
 * @returns {boolean} true если что-то применено
 */
export function applyFaceAdjust(canvas, ctx, lm, p, opts = {}) {
  const w = canvas.width;
  const h = canvas.height;
  if (!lm || !w || !h) return false;

  const masks = opts.masks;
  const bbox = faceBBox(lm, w, h);
  const controls = buildControls(lm, w, h, p, bbox);
  const hasWarp = controls.length > 0;
  const hasBags = s(p.eye_bags) > 0;
  const hasEyeFx = s(p.eye_bright) > 0 || s(p.eye_whiten) > 0;
  const hasLipTint = s(p.lip_tint) > 0;
  const hasMakeupOverlay =
    s(p.eye_lashes) > 0 ||
    s(p.eye_liner) > 0 ||
    s(p.eye_brows) > 0 ||
    s(p.eye_shadow) > 0;
  const hasTeeth = s(p.teeth_white) > 0;
  const hasMakeupParams = s(p.blush) > 0 || s(p.contour) > 0 || s(p.lip_gloss) > 0;

  if (!hasWarp && !hasBags && !hasEyeFx && !hasLipTint && !hasMakeupOverlay && !hasTeeth && !hasMakeupParams) {
    return false;
  }

  const warpOpts = { symmetry: !!opts.symmetry };
  let img = ctx.getImageData(0, 0, w, h);
  if (hasWarp) {
    img = warpBackward(
      img,
      w,
      h,
      bbox,
      controls,
      Math.min(28, Math.max(16, Math.floor(bbox.fw / 40))),
      warpOpts
    );
    ctx.putImageData(img, 0, 0);
  }

  const lm2 = hasWarp ? shiftLandmarks(lm, w, h, controls, bbox, warpOpts) : lm;

  if (hasBags) {
    applyAutoEyes(canvas, lm2, s(p.eye_bags) * 0.98);
  }

  if (masks && hasEyeFx) {
    if (s(p.eye_bright) > 0) {
      applyIrisBright(canvas, masks.leftIrisAlpha, masks.rightIrisAlpha, s(p.eye_bright) * 0.95);
    }
    if (s(p.eye_whiten) > 0) {
      applyScleraWhiten(canvas, masks.leftScleraAlpha, masks.rightScleraAlpha, s(p.eye_whiten) * 0.92);
    }
  }

  if (masks && hasLipTint && opts.lipColor) {
    applyAutoLip(canvas, masks.lip, opts.lipColor, s(p.lip_tint) * 0.88);
  }

  if (masks && hasTeeth) {
    applyTeethWhite(canvas, masks.teethAlpha, s(p.teeth_white));
  }

  if (masks && hasMakeupParams) {
    applyMakeup(ctx, canvas, masks, p, lm2);
  }

  if (hasMakeupOverlay) {
    const la = s(p.eye_lashes);
    const li = s(p.eye_liner);
    const br = s(p.eye_brows);
    const sh = s(p.eye_shadow);

    ctx.save();

    if (sh > 0) {
      const leftHull = convexHull(LEFT_EYE_INDICES.map((i) => lmPx(lm2, i, w, h)));
      const rightHull = convexHull(RIGHT_EYE_INDICES.map((i) => lmPx(lm2, i, w, h)));
      for (const hull of [leftHull, rightHull]) {
        if (hull.length < 3) continue;
        let minY = Infinity;
        let maxY = -Infinity;
        let cx = 0;
        let cy = 0;
        for (const q of hull) {
          minY = Math.min(minY, q.y);
          maxY = Math.max(maxY, q.y);
          cx += q.x;
          cy += q.y;
        }
        cx /= hull.length;
        cy /= hull.length;
        const g = ctx.createRadialGradient(cx, minY + (maxY - minY) * 0.15, 0, cx, cy, (maxY - minY) * 0.95);
        g.addColorStop(0, `rgba(160,100,200,${0.12 + sh * 0.28})`);
        g.addColorStop(0.55, `rgba(200,140,220,${0.06 + sh * 0.12})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
        ctx.globalCompositeOperation = "soft-light";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    if (br > 0) {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgba(55,40,25,${0.08 + br * 0.32})`;
      fillPolygon(ctx, lm2, w, h, LEFT_BROW_INDICES);
      ctx.fill();
      fillPolygon(ctx, lm2, w, h, RIGHT_BROW_INDICES);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    if (li > 0) {
      ctx.strokeStyle = `rgba(20,15,25,${0.75 + li * 0.22})`;
      ctx.lineWidth = 1.2 + li * 2.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawUpperLidPathLeft(ctx, lm2, w, h);
      ctx.stroke();
      drawUpperLidPathRight(ctx, lm2, w, h);
      ctx.stroke();
    }

    if (la > 0) {
      ctx.strokeStyle = `rgba(15,10,20,${0.55 + la * 0.4})`;
      ctx.lineWidth = 0.9;
      const upperL = [263, 466, 388, 387, 386, 385, 384, 398];
      const upperR = [33, 246, 161, 160, 159, 158, 157, 173];
      drawLashesAlongPath(ctx, lm2, w, h, upperL, la);
      drawLashesAlongPath(ctx, lm2, w, h, upperR, la);
    }

    ctx.restore();
  }

  return true;
}
