/**
 * GET /api/comet-env-check — диагностика ключей (без раскрытия секретов).
 */

const {
  getOpenRouterKey,
  getCometKey,
  stringifyUpstreamError,
} = require("./_upstreamImageEdit");

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
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const orKey = getOpenRouterKey();
  const cometKey = getCometKey();

  /** @type {Record<string, unknown>} */
  let openrouterModels = { skipped: true };
  if (orKey) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${orKey}` },
      });
      const text = await r.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      openrouterModels = {
        status: r.status,
        ok: r.ok,
        error: r.ok ? null : stringifyUpstreamError(json, "OpenRouter"),
      };
    } catch (e) {
      openrouterModels = { status: 0, error: e.message || String(e) };
    }
  }

  /** @type {Record<string, unknown>} */
  let cometModels = { skipped: true };
  if (cometKey) {
    try {
      const r = await fetch("https://api.cometapi.com/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${cometKey}` },
      });
      const text = await r.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      cometModels = {
        status: r.status,
        ok: r.ok,
        error: r.ok ? null : stringifyUpstreamError(json, "CometAPI"),
      };
    } catch (e) {
      cometModels = { status: 0, error: e.message || String(e) };
    }
  }

  sendJson(res, 200, {
    primary: "openrouter",
    fallback: "comet",
    OPENROUTER_API_KEY: {
      present: !!orKey,
      length: orKey ? orKey.length : 0,
    },
    COMET_API_KEY: {
      present: !!cometKey,
      length: cometKey ? cometKey.length : 0,
    },
    OPENROUTER_IMAGE_MODEL:
      process.env.OPENROUTER_IMAGE_MODEL ||
      process.env.OPENROUTER_MODEL ||
      "google/gemini-2.5-flash-image (default)",
    openrouter_models_GET: openrouterModels,
    comet_models_GET: cometModels,
    hint:
      "Сначала используется OpenRouter (OPENROUTER_API_KEY), при ошибке — Comet (COMET_API_KEY). В Vercel: Settings → Environment Variables, без префикса Bearer, затем Redeploy.",
  });
};
