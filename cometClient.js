/**
 * ИИ-ретушь: /api/comet-edit → OpenRouter (основной), CometAPI (fallback).
 * Ключи только на сервере: OPENROUTER_API_KEY, COMET_API_KEY.
 */

import { buildPersonMaskAlpha, personMaskToPngBase64 } from "./engine.js";

export const COMET_PRESET_REMOVE_PERSON = "remove_person";

const COMET_PRESETS = {
  full_beauty:
    "High-end beauty magazine portrait retouch: natural smooth skin, subtle professional makeup, brighter eyes, slight teeth whitening if visible, soft studio lighting. Preserve identity, face shape, and expression exactly. Photorealistic JPEG.",
  skin_studio:
    "Professional skin retouch only: even tone, reduce blemishes and redness, keep natural pores and texture. Do not change facial features or makeup. Photorealistic.",
  makeup_natural:
    "Apply subtle natural makeup: light mascara, soft neutral eyeshadow, natural lip tint, groomed brows. Keep face structure unchanged. Photorealistic portrait.",
  eyes_bright:
    "Brighten eyes subtly, reduce under-eye shadows and redness, very subtle eyeliner. Natural look, preserve identity.",
  teeth_smile:
    "Naturally whiten visible teeth slightly and gently enhance smile lines if any. Realistic, not exaggerated.",
  hair_shine:
    "ONLY enhance hair: add natural healthy shine and subtle highlight on hair strands. Do NOT change skin, face, eyes, lips, clothes, or background. Preserve exact hair color and hairstyle. Photorealistic.",
  bg_soft:
    "ONLY soften and blur the background. Keep the entire person (face, hair, body, clothes) perfectly sharp and unchanged. Natural depth-of-field; no relighting on subject. Photorealistic.",
  [COMET_PRESET_REMOVE_PERSON]:
    "Remove the person completely from this photo. Fill the transparent masked area with natural background that seamlessly matches the surroundings (sky, wall, floor, foliage, texture). No people, body parts, or silhouettes. Match lighting and perspective. Photorealistic.",
};

export function getCometPresetKeys() {
  return Object.keys(COMET_PRESETS);
}

export function getCometPresetPrompt(key) {
  return COMET_PRESETS[key] || "";
}

/**
 * @param {unknown} j
 * @param {Response} r
 */
function formatCometClientError(j, r) {
  const o = j && typeof j === "object" ? /** @type {Record<string, unknown>} */ (j) : {};
  const err = o.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const e = /** @type {Record<string, unknown>} */ (err);
    const parts = [];
    for (const k of ["message", "msg", "detail", "type", "code"]) {
      const v = e[k];
      if (typeof v === "string" && v.trim()) parts.push(v.trim());
    }
    if (parts.length) return parts.join(" — ");
  }
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  if (typeof o.detail === "string" && o.detail.trim()) return o.detail.trim();
  if (typeof o.raw === "string" && o.raw.trim()) return o.raw.trim().slice(0, 500);
  const status = r.status || o.status;
  try {
    const s = JSON.stringify(o);
    if (s && s !== "{}" && s !== "null") return s.slice(0, 500);
  } catch {
    /* ignore */
  }
  return `Ошибка Comet API${status ? ` (${status})` : ""}. Проверьте ключ и квоту.`;
}

/**
 * @param {Record<string, unknown>} body
 * @returns {Promise<string>}
 */
async function requestCometEdit(body) {
  const r = await fetch("/api/comet-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(formatCometClientError(j, r));
  }
  const b64 = j.b64_json;
  if (!b64) {
    throw new Error(formatCometClientError(j, r) || "Пустой ответ от ИИ");
  }
  return `data:image/jpeg;base64,${b64}`;
}

/**
 * @param {Uint8ClampedArray} personAlpha
 */
function countPersonMaskPixels(personAlpha) {
  let n = 0;
  for (let i = 0; i < personAlpha.length; i++) {
    if (personAlpha[i] > 48) n++;
  }
  return n;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ prompt: string, model?: string, maxSide?: number, withPersonMask?: boolean, personFaceIndex?: number, personFaces?: Array<Array<{x:number,y:number,z?:number}>> }} opts
 * @returns {Promise<string>} data URL (image/jpeg) готовый для drawImage
 */
export async function runCometEdit(canvas, opts) {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) throw new Error("Пустой промпт");

  const withMask = !!opts.withPersonMask;
  const maxSide = withMask ? (opts.maxSide ?? 1024) : (opts.maxSide ?? 1152);
  const sc = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const tw = Math.max(1, Math.round(canvas.width * sc));
  const th = Math.max(1, Math.round(canvas.height * sc));
  const mc = document.createElement("canvas");
  mc.width = tw;
  mc.height = th;
  const mx = mc.getContext("2d");
  mx.imageSmoothingEnabled = true;
  mx.imageSmoothingQuality = "high";
  mx.drawImage(canvas, 0, 0, tw, th);

  const model = opts.model || "gpt-image-2";
  const jpegBase64 = mc.toDataURL("image/jpeg", 0.9).split(",")[1];
  const pngBase64 = mc.toDataURL("image/png").split(",")[1];

  if (!withMask) {
    return requestCometEdit({
      prompt,
      model,
      imageBase64: jpegBase64,
      imageFormat: "jpeg",
      output_format: "jpeg",
    });
  }

  const personAlpha = buildPersonMaskAlpha(canvas, {
    faceIndex: opts.personFaceIndex ?? 0,
    faces: opts.personFaces,
  });
  if (!personAlpha) {
    throw new Error(
      "Не удалось выделить человека на фото. Попробуйте другое фото или подождите загрузки моделей."
    );
  }
  if (countPersonMaskPixels(personAlpha) < 80) {
    throw new Error("Область человека слишком мала. Выберите другое фото или другого человека.");
  }

  const maskBase64 = personMaskToPngBase64(canvas.width, canvas.height, personAlpha, tw, th);
  const multi = opts.personFaces && opts.personFaces.length > 1;

  try {
    return await requestCometEdit({
      prompt,
      model,
      imageBase64: pngBase64,
      imageFormat: "png",
      maskBase64,
      output_format: "jpeg",
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (multi) {
      throw new Error(
        msg && msg !== "{}"
          ? msg
          : "API не принял маску. На групповом фото попробуйте кадр покрупнее или другое освещение."
      );
    }
    console.warn("masked remove failed, retry without mask", e);
    return requestCometEdit({
      prompt:
        prompt +
        " Remove the entire person from the image. Fill with matching background. No people left.",
      model,
      imageBase64: jpegBase64,
      imageFormat: "jpeg",
      output_format: "jpeg",
    });
  }
}
