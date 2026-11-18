// ============================================================
// PROVIDER BALANCE GUARD
// ------------------------------------------------------------
// Bureau providers (IndiConnect, Surepass, Finpass) return errors when OUR
// prepaid balance with them runs low or is empty. That is an internal
// problem: the owner must top up the provider account. Partners must never
// see provider balance wording, so any error response that carries it is
// replaced with a neutral message here, and the owner is told in the logs.
// ============================================================

const PROVIDER_BALANCE_RE =
  /INSUFFICIENT_PROVIDER_BALANCE|insufficient[^"]{0,40}balance|balance[^"]{0,40}(low|zero|exhausted|depleted|insufficient)|balance_exhausted/i;

const PROVIDER_BALANCE_USER_MESSAGE =
  "Verification service temporarily unavailable. Please try again later.";

const isProviderBalanceError = (payload) => {
  try {
    return PROVIDER_BALANCE_RE.test(JSON.stringify(payload ?? ""));
  } catch {
    return false;
  }
};

// Wraps an Express handler. If it responds with an error status whose body
// mentions provider balance, the body sent to the partner is replaced.
const guardProviderBalance = (label, handler) => async (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    if (res.statusCode >= 400 && isProviderBalanceError(body)) {
      console.error(
        `[${label}] Provider balance exhausted — owner recharge needed.`,
      );

      res.status(503);

      return originalJson({
        success: false,
        status: "failed",
        message: PROVIDER_BALANCE_USER_MESSAGE,
        creditReportId: body?.creditReportId ?? null,
        failureCharge: body?.failureCharge ?? 0,
      });
    }

    return originalJson(body);
  };

  return handler(req, res, next);
};

module.exports = {
  guardProviderBalance,
  isProviderBalanceError,
  PROVIDER_BALANCE_USER_MESSAGE,
};
