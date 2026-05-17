/**
 * POST /api/comet-edit — ИИ-редактирование фото.
 * Сначала OpenRouter (OPENROUTER_API_KEY), при ошибке — CometAPI (COMET_API_KEY).
 */

const {
  readJsonBody,
  parseEditBody,
  runImageEdit,
} = require("./_upstreamImageEdit");

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
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

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Bad body" });
    return;
  }

  const p = parseEditBody(body);
  if (!p.prompt || !p.imageBase64) {
    sendJson(res, 400, { error: "Нужны поля prompt и imageBase64" });
    return;
  }

  try {
    const result = await runImageEdit(p);
    if (result.ok) {
      sendJson(res, 200, { b64_json: result.b64_json, provider: result.provider });
      return;
    }
    sendJson(res, 502, {
      error: result.error,
      tried: result.tried,
    });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "Upstream failed" });
  }
};
