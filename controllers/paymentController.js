const Razorpay = require("razorpay");
const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const Pricing = require("../models/Pricing");
const { PLAN_KEYS, tierForAmount } = require("../models/Pricing");
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
      plan = requestedPlan;
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

      // The plan chosen at checkout wins (upgrades and downgrades both
      // allowed). Pure top-ups never touch the tier at all.
      const effectivePlan = plan || current.activePlan || null;
      // Stamp the tier on the ledger row for per-tier revenue (pure top-ups
      // attribute to the tier the partner currently holds)
      transaction.planTier = plan || current.activePlan || null;
      await transaction.save();
      // First funding ever? (no other successful recharge besides this one)
      const autoAssigned = !(await Transaction.exists({
        userId: transaction.userId,
        purpose: "WALLET_RECHARGE",
        status: "SUCCESS",
        _id: { $ne: transaction._id },
      }));
      // Pure top-ups (no plan attached) force a plan pick on next use;
      // plan-attached checkouts just changed the tier, so clear any stale flag.
      const updatedUser = await User.findByIdAndUpdate(
        transaction.userId,
        {
          $inc: {
            walletBalance: walletCredit,
          },
          $set: {
            activePlan: effectivePlan,
            pendingPlanChoice: !plan,
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
// Free tier selection gated by wallet balance: the partner's balance must
// cover the tier's `recharge` slab (eligibility only — NOTHING is deducted).
// No Razorpay, no ledger row: the wallet is pure prepaid balance and only
// per-report generation charges ever move it. Upgrades and downgrades are
// both allowed; re-selecting the active plan is rejected.
// Atomic + idempotent per outcome.
async function activatePlan(req, res) {
  try {
    const { plan } = req.body;
    const userId = req.user._id;

    if (!plan || !PLAN_KEYS.includes(plan)) {
      return res.status(400).json({ success: false, message: "Please choose a valid plan" });
    }

    const user = await User.findById(userId).select("activePlan walletBalance").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if ((user.activePlan || null) === plan) {
      return res.status(400).json({ success: false, message: `You are already on the ${plan} plan` });
    }

    const pricing = await Pricing.findOne({ key: "default" }).lean();
    const threshold = Number(pricing?.plans?.[plan]?.recharge);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return res.status(500).json({ success: false, message: "Pricing not configured for this plan" });
    }

    // Eligibility gate only: balance must cover the slab, but not a rupee
    // moves. Guarded update keeps concurrent switches race-safe.
    const balance = Number(user.walletBalance) || 0;
    if (balance < threshold) {
      return res.status(402).json({
        success: false,
        message: `${plan} needs ₹${threshold} wallet balance to select — please top up first. Nothing is charged for the plan itself.`,
        required: threshold, balance,
      });
    }
    const switched = await User.updateOne(
      { _id: userId, activePlan: user.activePlan || null },
      { $set: { activePlan: plan, pendingPlanChoice: false } },
    );
    if (switched.modifiedCount === 0) {
      const fresh = await User.findById(userId).select("activePlan walletBalance").lean();
      if (!fresh) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      if ((fresh.activePlan || null) === plan) {
        // Already on the plan — still clears any stale forced-pick flag.
        await User.updateOne({ _id: userId }, { $set: { pendingPlanChoice: false } });
        return res.status(200).json({
          success: true, duplicate: true,
          message: `You are already on the ${plan} plan`,
          walletBalance: fresh.walletBalance, activePlan: fresh.activePlan,
        });
      }
      return res.status(409).json({
        success: false,
        message: "Your plan changed just now — please retry.",
      });
    }

    // No ledger row: free selections move no money, so the ledger stays
    // money-only (recharges in, report charges out).

    const updated = await User.findById(userId).select("walletBalance activePlan email name phone partner_id").lean();
    if (updated?.email) {
      sendPlanActivationMail(updated.email, {
        name: updated.name, plan, planFee: 0,
        walletBalance: updated.walletBalance,
        transactionId: `plan_${String(userId)}`,
        partnerId: updated.partner_id, date: new Date(),
      }).catch((e) => console.error("[mail] plan activation receipt failed:", e.message));
    }
    if (updated?.phone) {
      const { sendPlanActivationWhatsApp } = require("../utils/sendWhatsApp");
      sendPlanActivationWhatsApp(updated.phone, {
        plan, walletBalance: updated.walletBalance,
      }).catch((e) => console.error("[whatsapp] plan activation receipt failed:", e.message));
    }
    return res.status(200).json({
      success: true,
      message: `${plan} plan activated`,
      walletBalance: updated.walletBalance,
      activePlan: updated.activePlan,
      planFee: 0,
    });
  } catch (err) {
    // Genuine duplicate (parallel double-click): the guard above already
    // resolved it into duplicate:true, so reaching here means a real error.
    console.error("activatePlan Error:", err);
    return res.status(500).json({ success: false, message: "Could not activate plan. Please try again." });
  }
}
