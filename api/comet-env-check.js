/**
 * GET /api/comet-env-check — диагностика без раскрытия ключа.
 * Проверяет, подхватилась ли переменная на Vercel и принимает ли её Comet (GET /v1/models).
 */

const { normalizeApiKey } = require("./_cometKey");

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Только GET" });
    return;
  }

  const rawPresent = !!(process.env.COMET_API_KEY || process.env.COMETAPI_KEY);
  const key = normalizeApiKey(
    process.env.COMET_API_KEY || process.env.COMETAPI_KEY || ""
  );

  let modelsProbe = null;
  if (key.length > 0) {
    try {
      const r = await fetch("https://api.cometapi.com/v1/models?limit=1", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      });
      modelsProbe = {
        status: r.status,
        ok: r.ok,
      };
    } catch (e) {
      modelsProbe = { error: e.message || String(e) };
    }
  }

  sendJson(res, 200, {
    vercel_ui:
      "В Environment Variables при нажатии «Редактировать» поле значения пустое — это нормально: Vercel не показывает сохранённые секреты повторно. Ключ всё равно хранится, пока вы его не перезапишете.",
    env_var_name_used: process.env.COMET_API_KEY ? "COMET_API_KEY" : process.env.COMETAPI_KEY ? "COMETAPI_KEY" : null,
    raw_env_nonempty: rawPresent,
    normalized_key_length: key.length,
    comet_models_GET: modelsProbe,
    if_invalid_token:
      "Если comet_models_GET.status 401 — ключ CometAPI неверный, отозван или не тот. Создайте новый токен в кабинете Comet, вставьте только строку ключа (без Bearer), сохраните и сделайте Redeploy.",
  });
};
