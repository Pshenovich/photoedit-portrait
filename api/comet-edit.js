/**
 * Vercel Serverless: прокси к CometAPI POST https://api.cometapi.com/v1/images/edits
 * Переменная окружения: COMET_API_KEY
 */

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
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

  const key = process.env.COMET_API_KEY;
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
  form.append("image", new Blob([buf], { type: "image/jpeg" }), "photo.jpg");
  form.append("prompt", prompt.slice(0, 4000));
  form.append("model", model);
  form.append("output_format", output_format);
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
        error: json.error || json.message || json,
      });
      return;
    }

    const b64 = json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) {
      sendJson(res, 502, { error: "Нет b64_json в ответе", json });
      return;
    }

    sendJson(res, 200, { b64_json: b64 });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "Upstream fetch failed" });
  }
};
