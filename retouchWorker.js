/**
 * Web Worker: heavy full-frame skin smoothing (frequency separation).
 */

self.onmessage = (e) => {
  const { id, type, width, height, imageBuffer, maskBuffer, strength, fine, coarse } = e.data;
  if (type !== "autoSkin") return;

  try {
    const w = width;
    const h = height;
    const o = new Uint8ClampedArray(imageBuffer);
    const skinMask = new Uint8ClampedArray(maskBuffer);
    const len = w * h;

    const blurPass = (src, radius) => {
      const out = new Float32Array(len * 4);
      const r = Math.max(1, Math.ceil(radius));
      const kernel = [];
      let ks = 0;
      for (let i = -r; i <= r; i++) {
        const wgt = Math.exp(-(i * i) / (2 * radius * radius));
        kernel.push(wgt);
        ks += wgt;
      }
      for (let i = 0; i < kernel.length; i++) kernel[i] /= ks;

      const tmp = new Float32Array(len * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pi = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) {
              const xx = Math.min(w - 1, Math.max(0, x + k));
              sum += src[(y * w + xx) * 4 + c] * kernel[k + r];
            }
            tmp[pi + c] = sum;
          }
          tmp[pi + 3] = 255;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pi = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) {
              const yy = Math.min(h - 1, Math.max(0, y + k));
              sum += tmp[(yy * w + x) * 4 + c] * kernel[k + r];
            }
            out[pi + c] = sum;
          }
          out[pi + 3] = 255;
        }
      }
      return out;
    };

    const srcF = new Float32Array(len * 4);
    for (let i = 0; i < len * 4; i++) srcF[i] = o[i];

    const lowFine = blurPass(srcF, fine ?? 4.5);
    const lowSmooth = blurPass(lowFine, coarse ?? 14);

    const result = new Uint8ClampedArray(len * 4);
    for (let p = 0; p < len; p++) {
      const i = p * 4;
      const ma = (skinMask[p] / 255) * strength;
      const hf0 = o[i] - lowFine[i];
      const hf1 = o[i + 1] - lowFine[i + 1];
      const hf2 = o[i + 2] - lowFine[i + 2];
      const nr = Math.min(255, Math.max(0, lowSmooth[i] + hf0));
      const ng = Math.min(255, Math.max(0, lowSmooth[i + 1] + hf1));
      const nb = Math.min(255, Math.max(0, lowSmooth[i + 2] + hf2));
      result[i] = o[i] * (1 - ma) + nr * ma;
      result[i + 1] = o[i + 1] * (1 - ma) + ng * ma;
      result[i + 2] = o[i + 2] * (1 - ma) + nb * ma;
      result[i + 3] = 255;
    }

    self.postMessage({ id, ok: true, buffer: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
