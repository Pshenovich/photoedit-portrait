/**
 * Vercel Serverless: прокси к CometAPI POST https://api.cometapi.com/v1/images/edits
 * Переменная окружения: COMET_API_KEY
 */

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/** Comet / OpenAI часто отдают error как объект — всегда отдаём клиенту строку. */
function stringifyCometError(payload) {
  if (payload == null) return "Неизвестная ошибка CometAPI";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const e = payload.error ?? payload.message ?? payload;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const m = e.message ?? e.msg ?? e.detail;
      if (typeof m === "string") return m;
    }
    try {
      return JSON.stringify(payload).slice(0, 800);
    } catch {
      return "Ошибка CometAPI";
    }
  }
  return String(payload);
}

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const key = (process.env.COMET_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!key) {
    sendJson(res, 501, {
      error:
        "COMET_API_KEY не задан. В Vercel: Settings → Environment Variables → COMET_API_KEY = ваш ключ CometAPI.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Bad body" });
    return;
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const model = typeof body.model === "string" ? body.model : "gpt-image-2";
  const output_format = body.output_format || "jpeg";

  if (!prompt || !imageBase64) {
    sendJson(res, 400, { error: "Нужны поля prompt и imageBase64" });
    return;
  }

  let buf;
  try {
    buf = Buffer.from(imageBase64, "base64");
  } catch {
    sendJson(res, 400, { error: "Некорректный base64" });
    return;
  }
  if (buf.length < 100 || buf.length > 12 * 1024 * 1024) {
    sendJson(res, 400, { error: "Размер изображения вне допустимого диапазона" });
    return;
  }

  const form = new FormData();
  const jpegPart =
    typeof File !== "undefined"
      ? new File([buf], "photo.jpg", { type: "image/jpeg" })
      : new Blob([buf], { type: "image/jpeg" });
  if (typeof File !== "undefined" && jpegPart instanceof File) {
    form.append("image", jpegPart);
  } else {
    form.append("image", jpegPart, "photo.jpg");
  }
  form.append("prompt", prompt.slice(0, 4000));
  form.append("model", model);
  form.append("output_format", output_format);
  form.append("response_format", "b64_json");
  form.append("n", "1");

  try {
    const upstream = await fetch("https://api.cometapi.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
      },
      body: form,
    });

    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      sendJson(res, 502, { error: "Comet вернул не-JSON", raw: text.slice(0, 500) });
      return;
    }

    if (!upstream.ok) {
      sendJson(res, upstream.status >= 400 ? upstream.status : 502, {
        error: stringifyCometError(json),
        status: upstream.status,
      });
      return;
    }

    if (json.error) {
      sendJson(res, 502, {
        error: stringifyCometError(json),
        status: upstream.status,
      });
      return;
    }

    const row = json.data && json.data[0];
    let b64Out = row && row.b64_json;
    if (!b64Out && row && row.url && typeof row.url === "string") {
      try {
        const imgRes = await fetch(row.url);
        if (!imgRes.ok) {
          sendJson(res, 502, {
            error: `Comet вернул url, но скачивание не удалось: ${imgRes.status}`,
          });
          return;
        }
        const ab = await imgRes.arrayBuffer();
        b64Out = Buffer.from(ab).toString("base64");
      } catch (fe) {
        sendJson(res, 502, { error: `url из ответа: ${fe.message || fe}` });
        return;
      }
    }
    if (!b64Out) {
      sendJson(res, 502, {
        error: `Нет изображения в ответе: ${stringifyCometError(json)}`,
      });
      return;
    }

    sendJson(res, 200, { b64_json: b64Out });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "Upstream fetch failed" });
  }
};
