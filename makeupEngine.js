/**
 * Local makeup: blush, contour, lip gloss — masked overlays.
 */

import { lmPx, drawFaceOvalPath } from "./engine.js";
import { OUTER_LIP_INDICES } from "./landmarkPaths.js";

function s(v) {
  return Math.max(0, Math.min(1, (Number(v) || 0) / 100));
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {import('./engine.js').FaceMaskBundle} masks
 * @param {{ blush: number, contour: number, lip_gloss: number }} p
 * @param {Array<{x:number,y:number,z?:number}>} lm
 */
export function applyMakeup(ctx, canvas, masks, p, lm) {
  const w = canvas.width;
  const h = canvas.height;
  const blush = s(p.blush);
  const contour = s(p.contour);
  const gloss = s(p.lip_gloss);
  if (blush <= 0 && contour <= 0 && gloss <= 0) return false;

  if (blush > 0 && masks.cheeksAlpha) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const ma = masks.cheeksAlpha;
    const str = blush * 0.42;
    let pi = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = (ma[y * w + x] / 255) * str;
        if (m > 0.01) {
          d[pi] = Math.min(255, d[pi] + 28 * m);
          d[pi + 1] = Math.max(0, d[pi + 1] - 6 * m);
          d[pi + 2] = Math.max(0, d[pi + 2] - 4 * m);
        }
        pi += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  if (contour > 0) {
    ctx.save();
    ctx.strokeStyle = `rgba(40,25,18,${0.06 + contour * 0.22})`;
    ctx.lineWidth = 2 + contour * 4;
    ctx.globalCompositeOperation = "multiply";
    drawFaceOvalPath(ctx, lm, w, h);
    ctx.stroke();
    ctx.restore();
  }

  if (gloss > 0 && masks.lipAlpha) {
    const upper = [61, 185, 40, 39, 37, 0, 267, 269, 270];
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const i of upper) {
      const pt = lmPx(lm, i, w, h);
      cx += pt.x;
      cy += pt.y;
      n++;
    }
    if (n > 0) {
      cx /= n;
      cy /= n;
      const g = ctx.createRadialGradient(cx, cy * 0.98, 0, cx, cy, 18 + gloss * 22);
      g.addColorStop(0, `rgba(255,255,255,${0.15 + gloss * 0.35})`);
      g.addColorStop(0.6, `rgba(255,240,250,${0.04 + gloss * 0.08})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      ctx.fillStyle = g;
      ctx.globalCompositeOperation = "screen";
      ctx.beginPath();
      for (let k = 0; k < OUTER_LIP_INDICES.length; k++) {
        const pt = lmPx(lm, OUTER_LIP_INDICES[k], w, h);
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  return true;
}

/** @type {Record<string, Record<string, number>>} */
export const MAKEUP_PRESETS = {
  natural: { blush: 18, contour: 8, lip_gloss: 12 },
  evening: { blush: 42, contour: 28, lip_gloss: 35, eye_shadow: 35, eye_liner: 22 },
};
