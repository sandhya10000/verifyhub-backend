const Razorpay = require("razorpay");
const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Pricing = require("../models/Pricing");
const { PLAN_KEYS, tierForAmount, SINGLE_PLAN_MODE, SINGLE_PLAN_KEY, creditForRecharge, DEFAULT_RECHARGE_PLANS } = require("../models/Pricing");
const { sendRechargeSuccessMail, sendPlanActivationMail } = require("../utils/sendMail");
const { creditWalletRecharge } = require("../services/paymentCredit.service");
const { sendRetryLink } = require("../services/paymentRetry.service");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const createWalletRechargeOrder = async (req, res) => {
  try {
    console.log("Wallet recharge request:", req.body);

    const { amount, plan: requestedPlan } = req.body;
    const userId = req.user.id;

    const pricing = await Pricing.findOne({ key: "default" }).lean();
    const MIN_RECHARGE = pricing?.minRecharge ?? 200;

    // 1. Validate amount — plans-only checkout: must exactly match a plan.
    const livePlans = pricing?.rechargePlans?.length ? pricing.rechargePlans : DEFAULT_RECHARGE_PLANS;
    if (!amount || Number(amount) < MIN_RECHARGE) {
      return res.status(400).json({
        success: false,
        message: `Minimum recharge amount is ₹${MIN_RECHARGE}`,
      });
    }

    const baseAmount = Number(amount);
    const planCredit = creditForRecharge(baseAmount, livePlans);
    if (planCredit == null) {
      return res.status(400).json({
        success: false,
        message: `Please choose one of the recharge plans: ${livePlans.map((p) => `₹${Number(p.pay).toLocaleString('en-IN')}`).join(', ')}`,
      });
    }

    // 2. Validate user
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // 3. Resolve plan (free tier selection — NEVER a fee).
    // Plans are eligibility tiers, not purchases: the wallet is pure prepaid
    // balance and the full top-up is always credited. A plan may ride along
    // (first funding auto-assigns by amount slab; later top-ups may carry a
    // checkout choice, upgrades and downgrades both allowed) purely to set
    // the per-report price row. Nothing is ever deducted for the plan itself.
    const priorSuccess = await Transaction.exists({
      userId: user._id, purpose: "WALLET_RECHARGE", status: "SUCCESS",
    });
    let plan = null, autoAssigned = false;
    if (!priorSuccess) {
      plan = tierForAmount(baseAmount);
      autoAssigned = true;
      // No minimum-plan gate on first funding beyond minRecharge (checked
      // above): tierForAmount may return null for tiny amounts and the
      // partner simply starts tier-less (billing defaults to starter).
    } else if (requestedPlan) {
      if (!PLAN_KEYS.includes(requestedPlan)) {
        return res.status(400).json({ success: false, message: "Unknown plan selected" });
      }
      // Single-plan mode: ignore ride-along tier choice, always bill starter.
      // TODO(multi-plan-restore): remove this override to allow plan switching at checkout.
      plan = SINGLE_PLAN_MODE ? tierForAmount(baseAmount) || SINGLE_PLAN_KEY : requestedPlan;
    } else if (SINGLE_PLAN_MODE) {
      // Single-plan mode: pure top-ups also resolve to the single plan.
      plan = tierForAmount(baseAmount) || SINGLE_PLAN_KEY;
      autoAssigned = false;
    }

    const planFee = 0;
    // Razorpay collects baseAmount; wallet gets planCredit (bonus = diff).
    const walletCredit = planCredit;
    const bonusCredit = Math.max(0, planCredit - baseAmount);

    // 4. No GST on top-ups and no plan fee — the customer pays exactly the
    // entered amount via Razorpay and the full amount lands in the wallet.
    const gstAmount = 0;

    const totalAmount = baseAmount;

    console.log("Base Amount:", baseAmount);
    console.log("Total Amount:", totalAmount);
    console.log("Plan:", plan, "| Plan Fee:", planFee, "| Wallet Credit:", walletCredit);

    // 5. Create Razorpay order
    const options = {
      amount: Math.round(totalAmount * 100),
      currency: "INR",
      receipt: `wallet_recharge_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    console.log("Razorpay order created:", order.id);

    // 6. Save transaction (planSelected is the source of truth at verify)
    const transaction = new Transaction({
      userId: user._id,

      orderId: order.id,

      amount: baseAmount,

      gstAmount: gstAmount,

      totalAmount: totalAmount,

      currency: "INR",

      type: "CREDIT",

      purpose: "WALLET_RECHARGE",

      status: "PENDING",

      gateway: "RAZORPAY",

      planSelected: plan,

      planFee,

      bonusCredit,

      walletCredit,
    });

    await transaction.save();

    // 7. Response (keyId is public — the frontend needs it for Checkout.js)
    return res.status(200).json({
      success: true,

      orderId: order.id,

      keyId: process.env.RAZORPAY_KEY_ID,

      amount: order.amount,

      currency: order.currency,

      transactionId: transaction._id,

      plan,
      planFee,
      walletCredit,
      bonusCredit,
      autoAssigned,

      breakdown: {
        baseAmount: baseAmount,
        gstAmount: gstAmount,
        totalAmount: totalAmount,
        bonusCredit,
        walletCredit,
      },
    });
  } catch (error) {
    console.error("Error in wallet recharge order:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create wallet recharge order",
      error: error.message,
    });
  }
};
// POST /api/wallet-recharge/cancel — mark own PENDING recharge as FAILED.
// Called when the partner closes the Razorpay modal or the payment fails,
// so cancelled attempts don't sit in history as Pending forever.
// Strictly scoped: only the requester's own PENDING WALLET_RECHARGE rows.
// SUCCESS rows are never touched (cancel after a completed verify is a
// no-op), and a later successful verify can still flip FAILED -> SUCCESS
// if the partner retries and pays on the same order.
const cancelWalletRechargeOrder = async (req, res) => {
  try {
    const { orderId, failed } = req.body;
    const userId = req.user.id;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId is required",
      });
    }

    const updated = await Transaction.findOneAndUpdate(
      {
        orderId: String(orderId).trim(),
        userId,
        purpose: "WALLET_RECHARGE",
        status: "PENDING",
      },
      { $set: { status: "FAILED" } },
      { new: true },
    )
      .select("_id orderId status amount totalAmount userId purpose")
      .lean();

    // A genuine gateway failure (not a modal dismiss) → WhatsApp retry link.
    // Only fires when this call actually flipped the row PENDING -> FAILED,
    // so repeats and deliberate dismissals send nothing.
    if (updated && failed === true) {
      const user = await User.findById(userId).select("name email phone").lean();
      if (user?.phone) {
        sendRetryLink({
          transaction: updated,
          phone: user.phone,
          name: user.name,
          email: user.email,
          amount: Number(updated.totalAmount) || Number(updated.amount),
          purpose: "WALLET_RECHARGE",
          description: "VerifyHub wallet recharge",
          callbackPath: "/partner/add-funds",
        }).catch((e) => console.error("[payment-retry] wallet link failed:", e.message));
      }
    }

    // Idempotent: already SUCCESS/FAILED (or unknown order) is still a
    // successful no-op from the caller's perspective.
    return res.status(200).json({
      success: true,
      alreadyResolved: !updated,
      transactionId: updated?._id || null,
    });
  } catch (error) {
    console.error("Error in wallet recharge cancel:", error);
    return res.status(500).json({
      success: false,
      message: "Could not cancel wallet recharge order",
    });
  }
};
const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    // 1. Basic validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment details are required",
      });
    }

    // 2. Find transaction
    const transaction = await Transaction.findOne({
      orderId: razorpay_order_id,
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // 3. Prevent duplicate processing
    if (transaction.status === "SUCCESS") {
      return res.status(200).json({
        success: true,
        message: "Payment already verified",
        transaction,
      });
    }

    // 4. Generate Razorpay signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // 5. Verify signature
    if (generatedSignature !== razorpay_signature) {
      await Transaction.findByIdAndUpdate(transaction._id, {
        status: "FAILED",
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      });

      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed",
      });
    }

    // 6. Payment verified successfully
    transaction.paymentId = razorpay_payment_id;
    transaction.signature = razorpay_signature;
    transaction.status = "SUCCESS";

    await transaction.save();

    // 7. Wallet recharge.
    // Two shapes: tier selection rides along (planSelected set -> tier set,
    // full amount credited) or pure top-up (planSelected null -> full credit,
    // tier untouched). Plans are free — no fee is ever withheld.
    // Re-derive defensively and never strand paid money.
    if (transaction.purpose === "WALLET_RECHARGE") {
      const result = await creditWalletRecharge(transaction);
      return res.status(200).json({
        success: true,
        message: "Wallet recharged successfully",
        transaction,
        walletBalance: result.updatedUser.walletBalance,
        activePlan: result.updatedUser.activePlan,
        plan: result.plan,
        planFee: result.planFee,
        credited: result.walletCredit,
        bonusCredit: result.bonusCredit,
        autoAssigned: result.autoAssigned,
        pendingPlanChoice: result.updatedUser.pendingPlanChoice ?? false,
      });
    }

    // 8. If package purchase
    if (transaction.purpose === "PACKAGE_PURCHASE") {
      // Yahan package activation ka logic aayega

      return res.status(200).json({
        success: true,
        message: "Package payment verified successfully",
        transaction,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully",
      transaction,
    });
  } catch (error) {
    console.error("Verify payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
      error: error.message,
    });
  }
};

module.exports = {
  createWalletRechargeOrder,
  cancelWalletRechargeOrder,
  verifyPayment,
  activatePlan,
};

// POST /api/plan/activate { plan }
// Single-plan launch: NO-OP back-compat endpoint. Single plan auto-applies to
// everyone, so any call just ensures activePlan=starter and returns success
// (no balance gate, no 402, no mails). Old clients calling this never break.
// TODO(multi-plan-restore): restore balance-gated tier selection below.
async function activatePlan(req, res) {
  try {
    const userId = req.user._id;
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { activePlan: SINGLE_PLAN_KEY, pendingPlanChoice: false } },
      { new: true },
    ).select("walletBalance activePlan").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.status(200).json({
      success: true,
      message: `${SINGLE_PLAN_KEY} plan active (single launch plan)`,
      walletBalance: user.walletBalance,
      activePlan: user.activePlan,
      planFee: 0,
    });
  } catch (err) {
    console.error("activatePlan Error:", err);
    return res.status(500).json({ success: false, message: "Could not activate plan. Please try again." });
  }
}
