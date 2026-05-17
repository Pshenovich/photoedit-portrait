/**
 * ИИ-ретушь через CometAPI (OpenAI-совместимый /v1/images/edits).
 * Запрос идёт на /api/comet-edit — ключ хранится только на сервере (Vercel COMET_API_KEY).
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
 * @param {HTMLCanvasElement} canvas
 * @param {{ prompt: string, model?: string, maxSide?: number, withPersonMask?: boolean, personFaceIndex?: number, personFaces?: Array<Array<{x:number,y:number,z?:number}>> }} opts
 * @returns {Promise<string>} data URL (image/jpeg) готовый для drawImage
 */
export async function runCometEdit(canvas, opts) {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) throw new Error("Пустой промпт");

  const maxSide = opts.maxSide ?? 1152;
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

  const imageBase64 = mc.toDataURL("image/jpeg", 0.9).split(",")[1];

  let maskBase64;
  if (opts.withPersonMask) {
    const personAlpha = buildPersonMaskAlpha(canvas, {
      faceIndex: opts.personFaceIndex ?? 0,
      faces: opts.personFaces,
    });
    if (!personAlpha) {
      throw new Error(
        "Не удалось выделить человека на фото. Попробуйте другое фото или подождите загрузки моделей."
      );
    }
    maskBase64 = personMaskToPngBase64(canvas.width, canvas.height, personAlpha, tw, th);
  }

  const r = await fetch("/api/comet-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model: opts.model || "gpt-image-2",
      imageBase64,
      maskBase64: maskBase64 || undefined,
      output_format: "jpeg",
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const raw = j.error ?? j.message ?? j;
    let msg;
    if (typeof raw === "string") msg = raw;
    else if (raw && typeof raw === "object" && typeof raw.message === "string") msg = raw.message;
    else
      try {
        msg = JSON.stringify(raw).slice(0, 500);
      } catch {
        msg = r.statusText;
      }
    throw new Error(msg || "Comet API error");
  }
  const b64 = j.b64_json;
  if (!b64) throw new Error("Пустой ответ от ИИ");
  return `data:image/jpeg;base64,${b64}`;
}
