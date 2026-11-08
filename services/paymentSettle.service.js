const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const Transaction = require("../models/Transaction");
const { creditWalletRecharge } = require("./paymentCredit.service");

// Shared settlement path for webhooks, client verify, cancel and reconciliation.
// Every path ends in creditWalletRecharge, which is idempotent via
// walletCreditedAt, so calling this repeatedly is always safe.

let razorpayClient = null;
function getRazorpay() {
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// Find the transaction by our id (notes) or by Razorpay order id.
async function findTransaction({ txnId, orderId }) {
  if (txnId && mongoose.isValidObjectId(txnId)) {
    const byId = await Transaction.findById(txnId);
    if (byId) return byId;
  }
  if (orderId) return Transaction.findOne({ orderId: String(orderId) });
  return null;
}

// Mark a transaction SUCCESS (if not already) and apply its side effects.
// Returns { ok, already, credited }.
async function settlePaidTransaction(txn, paymentId) {
  if (!txn) return { ok: false, reason: "not-found" };

  let flipped = false;
  if (txn.status !== "SUCCESS") {
    const update = { status: "SUCCESS" };
    if (paymentId) update.paymentId = paymentId;
    const res = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: { $ne: "SUCCESS" } },
      { $set: update },
      { new: true },
    );
    if (res) {
      flipped = true;
      txn = res;
    }
  }

  if (txn.purpose === "WALLET_RECHARGE") {
    // Always attempt: creditWalletRecharge is idempotent, and this is what
    // heals rows that were marked SUCCESS but whose credit never completed.
    const fresh = await Transaction.findById(txn._id);
    const result = await creditWalletRecharge(fresh);
    return { ok: true, already: !flipped, credited: !result.alreadyCredited };
  }

  if (txn.purpose === "CUSTOM_BRAND_FEE" && flipped) {
    // Only on the first transition: activation is not guarded like wallet credit.
    const { activateCustomBrandedReport } = require("../controllers/customBrandedReportController");
    await activateCustomBrandedReport(txn, paymentId);
    return { ok: true, already: false, credited: true };
  }

  return { ok: true, already: !flipped, credited: false };
}

// Ask Razorpay whether this order has a captured payment, and settle if so.
// Used by the cancel path and the reconciliation job so a paid order is never
// marked FAILED and never left PENDING.
async function reconcileOrder(orderId) {
  const txn = await Transaction.findOne({ orderId: String(orderId) });
  if (!txn) return { ok: false, reason: "not-found" };
  if (txn.status === "SUCCESS" && txn.walletCreditedAt) return { ok: true, already: true };

  const res = await getRazorpay().orders.fetchPayments(String(orderId));
  const captured = (res?.items || []).find((p) => p.status === "captured");
  if (!captured) return { ok: false, reason: "not-captured" };

  return settlePaidTransaction(txn, captured.id);
}

// Sweep WALLET_RECHARGE rows stuck in PENDING (browser verify never completed
// and the webhook could not match them). Only looks at rows older than a grace
// period so it doesn't race an in-flight checkout.
async function reconcilePendingRecharges({ graceMs = 10 * 60 * 1000, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - graceMs);
  const stuck = await Transaction.find({
    purpose: "WALLET_RECHARGE",
    status: "PENDING",
    createdAt: { $lt: cutoff },
  })
    .select("orderId")
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  let settled = 0;
  for (const row of stuck) {
    try {
      const r = await reconcileOrder(row.orderId);
      if (r.ok && !r.already) settled++;
    } catch (e) {
      console.error("[reconcile] order", row.orderId, "failed:", e.message);
    }
  }
  if (stuck.length) console.log(`[reconcile] checked ${stuck.length} pending recharge(s), settled ${settled}`);
  return { checked: stuck.length, settled };
}

module.exports = {
  findTransaction,
  settlePaidTransaction,
  reconcileOrder,
  reconcilePendingRecharges,
};
