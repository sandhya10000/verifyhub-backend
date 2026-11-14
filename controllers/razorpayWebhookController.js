const crypto = require("crypto");
const { findTransaction, settlePaidTransaction } = require("../services/paymentSettle.service");

function isValidSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Settle a paid transaction, matched by our txn id (notes) or Razorpay order id.
// Safe to repeat: wallet crediting is guarded by walletCreditedAt.
async function markPaidAndCredit({ txnId, orderId, paymentId }) {
  const txn = await findTransaction({ txnId, orderId });
  if (!txn) return { ok: false, reason: "txn-not-found" };
  return settlePaidTransaction(txn, paymentId);
}

// POST /api/razorpay/webhook — must receive the RAW body (registered before
// express.json in Server.js) so the HMAC signature can be verified.
async function razorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not configured");
    return res.status(503).json({ success: false, message: "Webhook not configured" });
  }

  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

  const signature = req.headers["x-razorpay-signature"];
  if (!isValidSignature(raw, signature, secret)) {
    console.warn("[razorpay-webhook] invalid signature");
    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const type = event.event || event.type;
  try {
    if (type === "payment_link.paid") {
      const link = event.payload?.payment_link?.entity || {};
      const payment = event.payload?.payment?.entity || {};
      const txnId = link.notes?.transactionId || link.notes?.txnId;
      const result = await markPaidAndCredit({ txnId, orderId: payment.order_id, paymentId: payment.id });
      console.log("[razorpay-webhook] payment_link.paid", link.id, result);
    } else if (type === "payment.captured" || type === "order.paid") {
      // Checkout (order-based) payments carry no notes, so match by order id.
      const payment = event.payload?.payment?.entity || {};
      const order = event.payload?.order?.entity || {};
      const txnId = payment.notes?.transactionId || order.notes?.transactionId;
      const orderId = payment.order_id || order.id;
      const result = await markPaidAndCredit({ txnId, orderId, paymentId: payment.id });
      console.log("[razorpay-webhook]", type, payment.id || order.id, result);
    } else if (type === "payment.failed") {
      // Failure retry links are triggered by the client on payment.failed
      // (so modal dismissals stay silent). Logged here for visibility only.
      const payment = event.payload?.payment?.entity || {};
      console.warn(
        "[razorpay-webhook] payment.failed",
        payment.id || "",
        payment.error_description || "",
      );
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("[razorpay-webhook] handler failed:", e.message);
    // Non-2xx asks Razorpay to retry the delivery.
    return res.status(500).json({ success: false, message: "Webhook handler failed" });
  }
}

module.exports = { razorpayWebhook, markPaidAndCredit };
