// Shared failure classification for credit bureau pulls.
// Derives a human-readable reason + stable category from raw bureau errors
// so the admin Failed Reports tab can show `reason` without parsing blobs.

const FAILURE_CATEGORIES = [
  "BUREAU_REJECT",
  "VALIDATION",
  "TIMEOUT",
  "AUTH_CONFIG",
  "NETWORK",
  "EMPTY_RESPONSE",
  "UNKNOWN",
];

function safeString(v, max = 500) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return String(s).slice(0, max);
}

const MESSAGE_KEYS = new Set([
  "message", "errormessage", "error_message", "msg", "description",
  "reason", "failurereason", "remark", "remarks", "error_description",
  "errordescription", "detail", "details",
]);

const JUNK_VALUES = new Set(["", "null", "undefined", "none", "unknown", "error", "failed"]);

function looksLikeJson(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function isHumanMessage(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 300) return false;
  if (JUNK_VALUES.has(t.toLowerCase())) return false;
  if (looksLikeJson(t)) return false;
  return true;
}

// Depth-first search for the most human-readable message in nested bureau payloads,
// e.g. { data: { verify: { message: "Please provide valid mobile number." } } }
function deepFindMessage(node, depth = 0) {
  if (node === null || node === undefined || depth > 5) return "";
  if (typeof node === "string") return isHumanMessage(node) ? node.trim() : "";
  if (typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindMessage(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  // Prefer message-like keys first
  for (const key of Object.keys(node)) {
    if (MESSAGE_KEYS.has(key.toLowerCase())) {
      const v = node[key];
      if (typeof v === "string" && isHumanMessage(v)) return v.trim();
      const nested = deepFindMessage(v, depth + 1);
      if (nested) return nested;
    }
  }
  // Then recurse into everything else (data, verify, response, result, error objects)
  for (const key of Object.keys(node)) {
    if (MESSAGE_KEYS.has(key.toLowerCase())) continue;
    const found = deepFindMessage(node[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function extractRawMessage(err) {
  if (!err) return "";
  if (typeof err === "string") {
    const t = err.trim();
    if (looksLikeJson(t)) {
      // Last resort: pull "message":"..." out of a stringified blob
      const m = t.match(/"message"\s*:\s*"([^"]{3,300})"/);
      if (m) return m[1];
      return "";
    }
    return isHumanMessage(t) ? t : "";
  }
  const deep = deepFindMessage(err);
  if (deep) return deep;
  // Regex fallback on the stringified object (catches unusual key casing)
  try {
    const m = JSON.stringify(err).match(/"message"\s*:\s*"([^"]{3,300})"/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return "";
}

// Classify a raw error payload into { failureReason, failureCategory, errorCode }
function classifyFailure(input, httpStatus = null) {
  const raw = extractRawMessage(input);
  const lower = String(raw).toLowerCase();

  let category = "UNKNOWN";
  let code = null;

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes("invalid token") ||
    lower.includes("unauthorized") ||
    lower.includes("auth") && lower.includes("fail")
  ) {
    category = "AUTH_CONFIG";
    code = httpStatus ? String(httpStatus) : "AUTH_FAILED";
  } else if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnaborted") ||
    lower.includes("etimedout") ||
    lower.includes("504")
  ) {
    category = "TIMEOUT";
    code = "TIMEOUT";
  } else if (
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    lower.includes("503") ||
    lower.includes("unable to connect")
  ) {
    category = "NETWORK";
    code = "NETWORK_ERROR";
  } else if (
    lower.includes("empty") ||
    lower.includes("no data") ||
    lower.includes("empty_digi_response") ||
    lower === ""
  ) {
    category = "EMPTY_RESPONSE";
    code = "EMPTY_RESPONSE";
  } else if (
    lower.includes("invalid") ||
    lower.includes("validation") ||
    lower.includes("pan") && (lower.includes("mismatch") || lower.includes("incorrect")) ||
    lower.includes("mobile") ||
    lower.includes("required") ||
    lower.includes("bad request") ||
    httpStatus === 400 ||
    httpStatus === 422
  ) {
    category = "VALIDATION";
    code = httpStatus ? String(httpStatus) : "VALIDATION";
  } else if (
    lower.includes("reject") ||
    lower.includes("declin") ||
    lower.includes("not found") ||
    lower.includes("no hit") ||
    lower.includes("no record") ||
    lower.includes("failed")
  ) {
    category = "BUREAU_REJECT";
    code = httpStatus ? String(httpStatus) : "BUREAU_REJECT";
  } else if (httpStatus) {
    category = "BUREAU_REJECT";
    code = String(httpStatus);
  }

  // Human-readable reason, trimmed for table display
  let reason = safeString(raw, 300).trim() || "Bureau request failed";
  // Normalize common machine tokens
  if (/empty_digi_response/i.test(reason)) reason = "Empty response from bureau";
  if (/^timeout$/i.test(reason)) reason = "Bureau request timed out";

  return { failureReason: reason, failureCategory: category, errorCode: code };
}

// Backfill helper: derive reason fields from an existing CreditReport doc.
// Also repairs rows whose stored failureReason is a raw JSON dump.
function deriveFromReport(doc) {
  if (!doc) return { failureReason: "Bureau request failed", failureCategory: "UNKNOWN", errorCode: null };
  if (doc.failureReason && !looksLikeJson(doc.failureReason)) {
    return {
      failureReason: doc.failureReason,
      failureCategory: doc.failureCategory || "UNKNOWN",
      errorCode: doc.errorCode || null,
    };
  }
  const errPayload =
    doc.reportData?.error ?? doc.reportData ?? doc.remarks ?? doc.failureReason ?? null;
  return classifyFailure(errPayload);
}

module.exports = { FAILURE_CATEGORIES, classifyFailure, deriveFromReport, extractRawMessage, looksLikeJson };
