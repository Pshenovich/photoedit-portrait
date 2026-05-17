/**
 * ИИ-редактирование: OpenRouter (primary) → CometAPI (fallback).
 */

const { normalizeApiKey } = require("./_cometKey");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const COMET_URL = "https://api.cometapi.com/v1/images/edits";
const OR_TIMEOUT_MS = 52000;
const COMET_TIMEOUT_MS = 52000;

function getOpenRouterKey() {
  return normalizeApiKey(
    process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || ""
  );
}

function getCometKey() {
  return normalizeApiKey(
    process.env.COMET_API_KEY || process.env.COMETAPI_KEY || ""
  );
}

function getOpenRouterModel(requested) {
  const env = process.env.OPENROUTER_IMAGE_MODEL || process.env.OPENROUTER_MODEL;
  if (env) return env;
  const m = typeof requested === "string" ? requested : "";
  if (m === "gpt-image-1") return "openai/gpt-4o";
  return "google/gemini-2.5-flash-image";
}

/** @param {unknown} payload */
function stringifyUpstreamError(payload, label) {
  if (payload == null) return `Неизвестная ошибка ${label}`;
  if (typeof payload === "string") return payload.trim() || `Ошибка ${label}`;
  if (typeof payload === "object") {
    const o = /** @type {Record<string, unknown>} */ (payload);
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
    try {
      const s = JSON.stringify(o);
      if (s === "{}") return `${label}: пустой ответ ошибки`;
      return s.slice(0, 800);
    } catch {
      return `Ошибка ${label}`;
    }
  }
  return String(payload);
}

/**
 * @param {import('http').IncomingMessage} req
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, unknown>} body
 */
function parseEditBody(body) {
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const maskBase64 = typeof body.maskBase64 === "string" ? body.maskBase64 : "";
  const imageFormat = body.imageFormat === "png" ? "png" : "jpeg";
  const model = typeof body.model === "string" ? body.model : "gpt-image-2";
  const output_format = body.output_format || "jpeg";
  return { prompt, imageBase64, maskBase64, imageFormat, model, output_format };
}

/**
 * @param {string} imageBase64
 * @param {string} imageFormat
 */
function imageDataUrl(imageBase64, imageFormat) {
  const mime = imageFormat === "png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${imageBase64}`;
}

/**
 * @param {ReturnType<typeof parseEditBody>} p
 */
function buildOpenRouterUserContent(p) {
  /** @type {Array<Record<string, unknown>>} */
  const parts = [
    {
      type: "image_url",
      image_url: { url: imageDataUrl(p.imageBase64, p.imageFormat) },
    },
  ];
  let text = p.prompt;
  if (p.maskBase64) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${p.maskBase64}` },
    });
    text +=
      " The second image is an edit mask: fully transparent areas mark regions to remove and inpaint with matching background. Keep all opaque mask areas unchanged.";
  }
  parts.push({ type: "text", text });
  return parts;
}

/**
 * @param {unknown} json
 * @returns {string | null}
 */
function extractImageB64FromOpenRouter(json) {
  if (!json || typeof json !== "object") return null;
  const choices = /** @type {Record<string, unknown>} */ (json).choices;
  if (!Array.isArray(choices) || !choices[0]) return null;
  const message = choices[0].message;
  if (!message || typeof message !== "object") return null;
  const msg = /** @type {Record<string, unknown>} */ (message);

  const images = msg.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (!item || typeof item !== "object") continue;
      const im = /** @type {Record<string, unknown>} */ (item);
      const iu = im.image_url || im.imageUrl;
      if (!iu || typeof iu !== "object") continue;
      const url = /** @type {Record<string, unknown>} */ (iu).url;
      if (typeof url !== "string") continue;
      const m = url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
      if (m) return m[1];
    }
  }

  const content = msg.content;
  if (typeof content === "string") {
    const m = content.match(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)/);
    if (m) return m[1];
  }

  return null;
}

/**
 * @param {ReturnType<typeof parseEditBody>} p
 */
async function callOpenRouter(p) {
  const key = getOpenRouterKey();
  if (!key) return { ok: false, skip: true, error: "OPENROUTER_API_KEY не задан" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OR_TIMEOUT_MS);

  try {
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://photoedit-portrait.vercel.app",
        "X-OpenRouter-Title": "PhotoEdit Pro",
      },
      body: JSON.stringify({
        model: getOpenRouterModel(p.model),
        messages: [
          {
            role: "user",
            content: buildOpenRouterUserContent(p),
          },
        ],
        modalities: ["image"],
      }),
    });

    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `OpenRouter: не-JSON (${upstream.status})`, raw: text.slice(0, 400) };
    }

    if (!upstream.ok) {
      return {
        ok: false,
        error: stringifyUpstreamError(json, "OpenRouter") + ` (${upstream.status})`,
        raw: text.slice(0, 400),
      };
    }

    const b64 = extractImageB64FromOpenRouter(json);
    if (!b64) {
      return {
        ok: false,
        error: `OpenRouter: нет изображения в ответе — ${stringifyUpstreamError(json, "OpenRouter")}`,
        raw: text.slice(0, 400),
      };
    }

    return { ok: true, b64_json: b64, provider: "openrouter" };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "OpenRouter: таймаут" : e.message || String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {ReturnType<typeof parseEditBody>} p
 */
function buildCometForm(p) {
  let buf;
  try {
    buf = Buffer.from(p.imageBase64, "base64");
  } catch {
    throw new Error("Некорректный base64 изображения");
  }
  if (buf.length < 100 || buf.length > 12 * 1024 * 1024) {
    throw new Error("Размер изображения вне допустимого диапазона");
  }

  const imageMime = p.imageFormat === "png" ? "image/png" : "image/jpeg";
  const imageName = p.imageFormat === "png" ? "photo.png" : "photo.jpg";
  const form = new FormData();
  const imagePart =
    typeof File !== "undefined"
      ? new File([buf], imageName, { type: imageMime })
      : new Blob([buf], { type: imageMime });
  if (typeof File !== "undefined" && imagePart instanceof File) {
    form.append("image", imagePart);
  } else {
    form.append("image", imagePart, imageName);
  }
  form.append("prompt", p.prompt.slice(0, 4000));
  form.append("model", p.model);
  form.append("output_format", p.output_format);
  form.append("n", "1");

  if (p.maskBase64) {
    let maskBuf;
    try {
      maskBuf = Buffer.from(p.maskBase64, "base64");
    } catch {
      throw new Error("Некорректный base64 маски");
    }
    if (maskBuf.length < 50 || maskBuf.length > 4 * 1024 * 1024) {
      throw new Error("Размер маски вне допустимого диапазона");
    }
    const maskPart =
      typeof File !== "undefined"
        ? new File([maskBuf], "mask.png", { type: "image/png" })
        : new Blob([maskBuf], { type: "image/png" });
    if (typeof File !== "undefined" && maskPart instanceof File) {
      form.append("mask", maskPart);
    } else {
      form.append("mask", maskPart, "mask.png");
    }
  }

  return form;
}

/**
 * @param {ReturnType<typeof parseEditBody>} p
 */
async function callComet(p) {
  const key = getCometKey();
  if (!key) return { ok: false, skip: true, error: "COMET_API_KEY не задан" };

  let form;
  try {
    form = buildCometForm(p);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMET_TIMEOUT_MS);

  try {
    const upstream = await fetch(COMET_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });

    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "Comet: не-JSON", raw: text.slice(0, 400) };
    }

    if (!upstream.ok || json.error) {
      const errText = stringifyUpstreamError(json, "CometAPI");
      return {
        ok: false,
        error: errText + (upstream.status ? ` (${upstream.status})` : ""),
        raw: text.slice(0, 400),
      };
    }

    const row = json.data && json.data[0];
    let b64Out = row && row.b64_json;
    if (!b64Out && row && row.url && typeof row.url === "string") {
      const imgRes = await fetch(row.url);
      if (!imgRes.ok) {
        return { ok: false, error: `Comet: не удалось скачать url (${imgRes.status})` };
      }
      const ab = await imgRes.arrayBuffer();
      b64Out = Buffer.from(ab).toString("base64");
    }
    if (!b64Out) {
      return {
        ok: false,
        error: `Comet: нет изображения — ${stringifyUpstreamError(json, "CometAPI")}`,
        raw: text.slice(0, 400),
      };
    }

    return { ok: true, b64_json: b64Out, provider: "comet" };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Comet: таймаут" : e.message || String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenRouter → Comet (fallback).
 * @param {ReturnType<typeof parseEditBody>} p
 */
async function runImageEdit(p) {
  const orKey = getOpenRouterKey();
  const cometKey = getCometKey();
  if (!orKey && !cometKey) {
    return {
      ok: false,
      error:
        "Нет ключей API. В Vercel задайте OPENROUTER_API_KEY (основной) и/или COMET_API_KEY (запасной).",
    };
  }

  const errors = [];

  if (orKey) {
    const or = await callOpenRouter(p);
    if (or.ok) return or;
    if (!or.skip && or.error) errors.push(or.error);
  }

  if (cometKey) {
    const comet = await callComet(p);
    if (comet.ok) return comet;
    if (!comet.skip && comet.error) errors.push(comet.error);
  }

  const detail = errors.filter(Boolean).join(" | ");
  return {
    ok: false,
    error: detail || "ИИ-редактирование недоступно",
    tried: [orKey ? "openrouter" : null, cometKey ? "comet" : null].filter(Boolean),
  };
}

module.exports = {
  readJsonBody,
  parseEditBody,
  getOpenRouterKey,
  getCometKey,
  runImageEdit,
  stringifyUpstreamError,
};
