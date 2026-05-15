/**
 * Локальные коррекции: экспозиция, контраст, тон, насыщенность, резкость, виньетка.
 */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * @param {ImageData} img
 * @param {{ exposure: number, contrast: number, warmth: number, saturation: number }} p
 */
export function applyColorMatrix(img, p) {
  const d = img.data;
  const exp = (p.exposure / 100) * 0.55;
  const mult = Math.pow(2, exp);
  const con = 1 + (p.contrast / 100) * 0.65;
  const warm = p.warmth / 100;
  const sat = 1 + (p.saturation / 100) * 0.65;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * mult;
    let g = d[i + 1] * mult;
    let b = d[i + 2] * mult;

    r += warm * 18;
    b -= warm * 18;

    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    r = L + (r - L) * sat;
    g = L + (g - L) * sat;
    b = L + (b - L) * sat;

    r = (r - 128) * con + 128;
    g = (g - 128) * con + 128;
    b = (b - 128) * con + 128;

    d[i] = clamp(r, 0, 255);
    d[i + 1] = clamp(g, 0, 255);
    d[i + 2] = clamp(b, 0, 255);
  }
}

/**
 * Лапласиан high-boost (amount 0..100).
 * @param {ImageData} img
 */
export function applySharpenAmount(img, amount) {
  if (amount <= 0) return;
  const w = img.width;
  const h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const k = (amount / 100) * 0.42;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const c0 = src[idx + c];
        const lap =
          4 * c0 -
          src[idx - 4 + c] -
          src[idx + 4 + c] -
          src[idx - w * 4 + c] -
          src[idx + w * 4 + c];
        d[idx + c] = clamp(c0 + k * lap, 0, 255);
      }
    }
  }
}

/**
 * @param {ImageData} img
 * @param {number} amount 0..100
 */
export function applyVignetteAmount(img, amount) {
  if (amount <= 0) return;
  const w = img.width;
  const h = img.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const str = (amount / 100) * 0.75;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / maxR;
      const m = 1 - str * r * r;
      const o = (y * w + x) * 4;
      d[o] *= m;
      d[o + 1] *= m;
      d[o + 2] *= m;
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {{ exposure: number, contrast: number, warmth: number, saturation: number, sharpen: number, vignette: number }} p
 */
export function applyLightPipeline(ctx, canvas, p) {
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  applyColorMatrix(img, p);
  applySharpenAmount(img, p.sharpen);
  applyVignetteAmount(img, p.vignette);
  ctx.putImageData(img, 0, 0);
}

/** Поворот на 90° по часовой стрелке */
export function rotateCanvas90CW(canvas, ctx) {
  const w = canvas.width;
  const h = canvas.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d").drawImage(canvas, 0, 0);
  canvas.width = h;
  canvas.height = w;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Blur background using mask (255 = background), composite subject sharp.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8ClampedArray} bgMask
 * @param {number} amount 0..100
 */
export function applyBackgroundBlur(ctx, canvas, bgMask, amount) {
  if (!bgMask || amount <= 0) return;
  const w = canvas.width;
  const h = canvas.height;
  const blurPx = 2 + (amount / 100) * 22;
  const orig = ctx.getImageData(0, 0, w, h);

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d").putImageData(orig, 0, 0);

  const blurred = document.createElement("canvas");
  blurred.width = w;
  blurred.height = h;
  const bc = blurred.getContext("2d");
  try {
    bc.filter = `blur(${blurPx}px)`;
    bc.drawImage(src, 0, 0);
  } catch (_) {
    bc.drawImage(src, 0, 0);
  }
  bc.filter = "none";
  const bd = bc.getImageData(0, 0, w, h).data;
  const od = orig.data;
  const str = amount / 100;
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    const m = (bgMask[p] / 255) * str;
    od[i] = od[i] * (1 - m) + bd[i] * m;
    od[i + 1] = od[i + 1] * (1 - m) + bd[i + 1] * m;
    od[i + 2] = od[i + 2] * (1 - m) + bd[i + 2] * m;
  }
  ctx.putImageData(orig, 0, 0);
}

/** Против часовой */
export function rotateCanvas90CCW(canvas, ctx) {
  const w = canvas.width;
  const h = canvas.height;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d").drawImage(canvas, 0, 0);
  canvas.width = h;
  canvas.height = w;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(0, canvas.height);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
