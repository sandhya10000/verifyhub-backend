const Razorpay = require("razorpay");
const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Pricing = require("../models/Pricing");
const { PLAN_KEYS, tierForAmount, SINGLE_PLAN_MODE, SINGLE_PLAN_KEY } = require("../models/Pricing");
const { sendRechargeSuccessMail, sendPlanActivationMail } = require("../utils/sendMail");

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

    // 1. Validate amount
    if (!amount || Number(amount) < MIN_RECHARGE) {
      return res.status(400).json({
        success: false,
        message: `Minimum recharge amount is ₹${MIN_RECHARGE}`,
      });
    }

    const baseAmount = Number(amount);

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
    const walletCredit = baseAmount;

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
      autoAssigned,

      breakdown: {
        baseAmount: baseAmount,
        gstAmount: gstAmount,
        totalAmount: totalAmount,
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
      const pricing = await Pricing.findOne({ key: "default" }).lean();

      const current = await User.findById(transaction.userId).select("activePlan email name phone partner_id").lean();
      if (!current) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      let plan = transaction.planSelected;
      if (plan && !PLAN_KEYS.includes(plan)) plan = null; // corrupt value -> treat as pure top-up
      // Legacy orders predating free plans may carry a locked planFee —
      // ignore it: plans cost nothing, the full amount is always credited.
      const planFee = 0;
      const walletCredit = Math.max(0, Number(transaction.amount));

      // Single-plan mode: every successful recharge lands on the single plan.
      // TODO(multi-plan-restore): restore checkout-wins logic below.
      let effectivePlan;
      if (SINGLE_PLAN_MODE) {
        effectivePlan = SINGLE_PLAN_KEY;
        plan = SINGLE_PLAN_KEY;
        transaction.planTier = SINGLE_PLAN_KEY;
      } else {
        // The plan chosen at checkout wins (upgrades and downgrades both
        // allowed). Pure top-ups never touch the tier at all.
        effectivePlan = plan || current.activePlan || null;
        // Stamp the tier on the ledger row for per-tier revenue (pure top-ups
        // attribute to the tier the partner currently holds)
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
      // Single-plan launch: no forced plan pick — every recharge lands on the
      // single plan with pendingPlanChoice always false.
      // TODO(multi-plan-restore): restore pendingPlanChoice: !plan gate.
      const updatedUser = await User.findByIdAndUpdate(
        transaction.userId,
        {
          $inc: {
            walletBalance: walletCredit,
          },
          $set: {
            activePlan: effectivePlan,
            pendingPlanChoice: false,
          },
        },
        {
          new: true,
        },
      );

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Fire-and-forget receipt mail + clear stale low-balance flag
      // once the wallet is healthy again. Never blocks the response.
      if (current.email) {
        sendRechargeSuccessMail(current.email, {
          name: current.name, baseAmount: Number(transaction.amount),
          gstAmount: Number(transaction.gstAmount) || 0,
          totalPaid: Number(transaction.totalAmount),
          walletCredit, plan, planFee,
          walletBalance: updatedUser.walletBalance,
          activePlan: updatedUser.activePlan,
          paymentId: transaction.paymentId, orderId: transaction.orderId,
          transactionId: String(transaction._id),
          partnerId: current.partner_id, date: new Date(),
        }).catch((e) => console.error("[mail] recharge receipt failed:", e.message));
      }
      if (current.phone) {
        const { sendRechargeSuccessWhatsApp } = require("../utils/sendWhatsApp");
        sendRechargeSuccessWhatsApp(current.phone, {
          credited: walletCredit,
          walletBalance: updatedUser.walletBalance,
          activePlan: updatedUser.activePlan,
        }).catch((e) => console.error("[whatsapp] recharge receipt failed:", e.message));
      }
      const _threshold = pricing?.lowBalanceThreshold ?? 500;
      if ((updatedUser.walletBalance ?? 0) >= _threshold) {
        User.updateOne({ _id: transaction.userId }, { $set: { lowBalanceLastAlertAt: null } }).exec().catch(() => {});
      }

      return res.status(200).json({
        success: true,
        message: "Wallet recharged successfully",
        transaction,
        walletBalance: updatedUser.walletBalance,
        activePlan: updatedUser.activePlan,
        plan,
        planFee,
        credited: walletCredit,
        autoAssigned,
        pendingPlanChoice: updatedUser.pendingPlanChoice ?? false,
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
