/**
 * Убираем кавычки, переносы, случайный префикс Bearer — иначе получится Bearer Bearer …
 */
function normalizeApiKey(raw) {
  if (raw == null) return "";
  let k = String(raw).trim();
  k = k.replace(/^["'`]+|["'`]+$/g, "");
  k = k.replace(/^Bearer\s+/i, "").trim();
  k = k.split(/\r?\n/)[0].trim();
  return k;
}

module.exports = { normalizeApiKey };
