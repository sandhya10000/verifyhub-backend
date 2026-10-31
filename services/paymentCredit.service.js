const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Pricing = require("../models/Pricing");
const {
  PLAN_KEYS,
  SINGLE_PLAN_MODE,
  SINGLE_PLAN_KEY,
  creditForRecharge,
  DEFAULT_RECHARGE_PLANS,
} = require("../models/Pricing");
const { sendRechargeSuccessMail } = require("../utils/sendMail");
const { earnPoints } = require("../utils/points");

// Credit a WALLET_RECHARGE transaction whose payment has been confirmed.
// The caller is responsible for setting transaction.status = "SUCCESS" (and
// saving) before calling this. Shared by /verify/payment and the Razorpay
// webhook so both paths credit identically.
async function creditWalletRecharge(transaction) {
  const pricing = await Pricing.findOne({ key: "default" }).lean();

  const current = await User.findById(transaction.userId)
    .select("activePlan email name phone partner_id")
    .lean();
  if (!current) throw new Error("User not found");

  let plan = transaction.planSelected;
  if (plan && !PLAN_KEYS.includes(plan)) plan = null; // corrupt value -> treat as pure top-up
  // Plans are free — never withhold a fee.
  const planFee = 0;

  // Bonus locked at order time wins; legacy rows recompute from live pricing.
  let walletCredit = Number(transaction.walletCredit);
  let bonusCredit = Number(transaction.bonusCredit);
  if (!Number.isFinite(walletCredit) || walletCredit <= 0) {
    const livePlans = pricing?.rechargePlans?.length
      ? pricing.rechargePlans
      : DEFAULT_RECHARGE_PLANS;
    const recomputed = creditForRecharge(Number(transaction.amount), livePlans);
    walletCredit = recomputed != null ? recomputed : Math.max(0, Number(transaction.amount));
    bonusCredit = Math.max(0, walletCredit - Number(transaction.amount));
    transaction.walletCredit = walletCredit;
    transaction.bonusCredit = bonusCredit;
  }
  if (!Number.isFinite(bonusCredit)) {
    bonusCredit = Math.max(0, walletCredit - Number(transaction.amount));
  }

  let effectivePlan;
  if (SINGLE_PLAN_MODE) {
    effectivePlan = SINGLE_PLAN_KEY;
    plan = SINGLE_PLAN_KEY;
    transaction.planTier = SINGLE_PLAN_KEY;
  } else {
    effectivePlan = plan || current.activePlan || null;
    transaction.planTier = plan || current.activePlan || null;
  }
  await transaction.save();

  // First funding ever? (no other successful recharge besides this one)
  const autoAssigned = !(await Transaction.exists({
    userId: transaction.userId,
    purpose: "WALLET_RECHARGE",
    status: "SUCCESS",
    _id: { $ne: transaction._id },
  }));

  const updatedUser = await User.findByIdAndUpdate(
    transaction.userId,
    {
      $inc: { walletBalance: walletCredit },
      $set: { activePlan: effectivePlan, pendingPlanChoice: false },
    },
    { new: true },
  );
  if (!updatedUser) throw new Error("User not found");

  // Credit points: Rs paid = points earned (bonus not counted). Idempotent per orderId.
  try {
    await earnPoints(transaction.userId, Number(transaction.amount), transaction.orderId);
  } catch (err) {
    console.error("[points] earn failed for order", transaction.orderId, err.message);
  }

  // Receipt mail (fire-and-forget).
  if (current.email) {
    sendRechargeSuccessMail(current.email, {
      name: current.name,
      baseAmount: Number(transaction.amount),
      gstAmount: Number(transaction.gstAmount) || 0,
      totalPaid: Number(transaction.totalAmount),
      walletCredit,
      bonusCredit,
      plan,
      planFee,
      walletBalance: updatedUser.walletBalance,
      activePlan: updatedUser.activePlan,
      paymentId: transaction.paymentId,
      orderId: transaction.orderId,
      transactionId: String(transaction._id),
      partnerId: current.partner_id,
      date: new Date(),
    }).catch((e) => console.error("[mail] recharge receipt failed:", e.message));
  }

  // Receipt WhatsApp (fire-and-forget).
  if (current.phone) {
    const { sendRechargeSuccessWhatsApp } = require("../utils/sendWhatsApp");
    sendRechargeSuccessWhatsApp(current.phone, {
      paid: Number(transaction.amount),
      bonus: bonusCredit,
      credited: walletCredit,
      walletBalance: updatedUser.walletBalance,
      activePlan: updatedUser.activePlan,
    }).catch((e) => console.error("[whatsapp] recharge receipt failed:", e.message));
  }

  // Admin top-up alert (fire-and-forget fan-out).
  (async () => {
    try {
      const { sendTopupAdminNotifyMail } = require("../utils/sendMail");
      const platform = String(process.env.TOPUP_NOTIFY_EMAILS || "info@verifyhub.in")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const admins = await User.find({ role: "admin", isActive: { $ne: false } })
        .select("email")
        .lean();
      const recipients = new Set([
        ...platform,
        ...admins.map((a) => a && a.email).filter(Boolean),
      ]);
      if (current.email) recipients.delete(current.email); // partner already got the receipt
      const payload = {
        name: current.name,
        email: current.email,
        phone: current.phone,
        walletCredit,
        bonusCredit,
        walletBalance: updatedUser.walletBalance,
        activePlan: updatedUser.activePlan,
        paymentId: transaction.paymentId,
        orderId: transaction.orderId,
        transactionId: String(transaction._id),
        partnerId: current.partner_id,
        date: new Date(),
      };
      await Promise.allSettled(
        [...recipients].map((to) =>
          sendTopupAdminNotifyMail(to, payload).catch((e) =>
            console.error("[mail] top-up admin notify failed:", to, e.message),
          ),
        ),
      );
    } catch (e) {
      console.error("[mail] top-up admin notify failed:", e.message);
    }
  })();

  // Clear stale low-balance flag once the wallet is healthy again.
  const threshold = pricing?.lowBalanceThreshold ?? 500;
  if ((updatedUser.walletBalance ?? 0) >= threshold) {
    User.updateOne(
      { _id: transaction.userId },
      { $set: { lowBalanceLastAlertAt: null } },
    )
      .exec()
      .catch(() => {});
  }

  return { updatedUser, plan, planFee, walletCredit, bonusCredit, autoAssigned };
}

module.exports = { creditWalletRecharge };
