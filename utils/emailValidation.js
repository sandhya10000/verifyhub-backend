const dns = require("dns").promises;

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Domains that never receive real mail (RFC 2606 + common test traps)
const BLOCKED_EXACT = new Set([
  "example.com",
  "example.net",
  "example.org",
  "test.com",
  "localhost",
  "invalid",
  "test",
  "example",
]);

function isBlockedDomain(domain) {
  const d = String(domain || "").toLowerCase();
  if (BLOCKED_EXACT.has(d)) return true;
  if (d === "localhost" || d.endsWith(".localhost")) return true;
  if (d.endsWith(".invalid") || d.endsWith(".test") || d.endsWith(".example")) return true;
  if (d.startsWith("example.") || d.endsWith(".example.com")) return true;
  return false;
}

function validateEmailFormat(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!em || em.length > 254) return { ok: false, message: "Enter a valid email address" };
  if (!EMAIL_RE.test(em)) return { ok: false, message: "Enter a valid email address" };
  const domain = em.split("@")[1];
  if (isBlockedDomain(domain)) {
    return { ok: false, message: "Please use a real email address (test/example addresses are not allowed)" };
  }
  return { ok: true, email: em, domain };
}

// Fail-open: DNS errors/timeouts return ok:true so real users aren't blocked by blips
async function hasMx(domain, timeoutMs = 2500) {
  try {
    const lookup = dns.resolveMx(domain);
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("MX_TIMEOUT")), timeoutMs));
    const records = await Promise.race([lookup, timer]);
    return { ok: Array.isArray(records) && records.length > 0, skipped: false };
  } catch (e) {
    if (e && (e.code === "ENOTFOUND" || e.code === "ENODATA" || /no answer|queryMx/i.test(e.message || ""))) {
      return { ok: false, skipped: false };
    }
    // Timeout / EAI_AGAIN / network blip → fail open
    console.warn("[mail] MX lookup skipped for", domain, "-", e.message || e.code);
    return { ok: true, skipped: true };
  }
}

function isMailboxNotFoundError(err) {
  const msg = `${err?.message || ""} ${err?.response || ""}`.toLowerCase();
  const code = String(err?.code || err?.responseCode || "");
  return (
    code === "550" ||
    code === "553" ||
    code === "EENVELOPE" ||
    msg.includes("550-5.1.1") ||
    msg.includes("550 5.1.1") ||
    msg.includes("mailbox unavailable") ||
    msg.includes("recipient address rejected") ||
    msg.includes("address not found") ||
    msg.includes("enotfound")
  );
}

module.exports = { validateEmailFormat, isBlockedDomain, hasMx, isMailboxNotFoundError };
