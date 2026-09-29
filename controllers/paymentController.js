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

    // 3. Resolve plan + fee.
    // First funding ever -> auto-assign by amount slab, client choice ignored,
    // plan fee deducted from the top-up.
    // Later top-ups -> PURE wallet credit by default. A plan may optionally
    // ride along (chosen at checkout, upgrades and downgrades both allowed);
    // otherwise plans are bought separately from wallet balance via
    // /plan/activate.
    const priorSuccess = await Transaction.exists({
      userId: user._id, purpose: "WALLET_RECHARGE", status: "SUCCESS",
    });
    let plan = null, planFee = 0, autoAssigned = false;
    if (!priorSuccess) {
      plan = tierForAmount(baseAmount);
      if (!plan) {
        return res.status(400).json({
          success: false,
          message: `Amount below the cheapest plan. Minimum recharge is ₹${MIN_RECHARGE}`,
        });
      }
      autoAssigned = true;
    } else if (requestedPlan) {
      if (!PLAN_KEYS.includes(requestedPlan)) {
        return res.status(400).json({ success: false, message: "Unknown plan selected" });
      }
      plan = requestedPlan;
    }

    if (plan) {
      const planRow = pricing?.plans?.[plan];
      if (!planRow) {
        return res.status(500).json({ success: false, message: "Pricing not configured for this plan" });
      }
      planFee = Number(planRow.recharge) || 0;
      if (baseAmount < planFee) {
        return res.status(400).json({
          success: false,
          message: `₹${baseAmount} is below the ${plan} plan price of ₹${planFee}`,
        });
      }
    }
    const walletCredit = baseAmount - planFee;

    // 4. GST calculation (on the full top-up, as before)
    const GST_RATE = 18;

    const gstAmount = (baseAmount * GST_RATE) / 100;

    const totalAmount = baseAmount + gstAmount;

    console.log("Base Amount:", baseAmount);
    console.log("GST Amount:", gstAmount);
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
    // Two shapes: plan purchase (planSelected set -> fee split + tier set)
    // or pure top-up (planSelected null -> full credit, tier untouched).
    // Re-derive defensively and never strand paid money.
    if (transaction.purpose === "WALLET_RECHARGE") {
      const pricing = await Pricing.findOne({ key: "default" }).lean();

      const current = await User.findById(transaction.userId).select("activePlan email name partner_id").lean();
      if (!current) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      let plan = transaction.planSelected;
      let planFee = transaction.planFee;
      if (plan && !PLAN_KEYS.includes(plan)) plan = null; // corrupt value -> treat as pure top-up
      if (plan && (planFee === undefined || planFee === null)) {
        // Legacy order predating fee locking — re-read live pricing
        const planRow = pricing?.plans?.[plan];
        planFee = planRow ? Number(planRow.recharge) || 0 : 0;
      }
      if (!plan) planFee = 0;
      const walletCredit = Math.max(0, Number(transaction.amount) - planFee);

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
      const updatedUser = await User.findByIdAndUpdate(
        transaction.userId,
        {
          $inc: {
            walletBalance: walletCredit,
          },
          $set: {
            activePlan: effectivePlan,
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
// Activates a plan by debiting its price from the existing wallet balance.
// No Razorpay involved: top up first, then activate. Upgrades and
// downgrades are both allowed; re-buying the active plan is rejected.
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
    const fee = Number(pricing?.plans?.[plan]?.recharge);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(500).json({ success: false, message: "Pricing not configured for this plan" });
    }

    // Atomic: debit only if balance covers AND tier hasn't moved underneath us
    const debit = await User.updateOne(
      { _id: userId, walletBalance: { $gte: fee }, activePlan: user.activePlan || null },
      { $inc: { walletBalance: -fee }, $set: { activePlan: plan } },
    );
    if (debit.modifiedCount === 0) {
      const fresh = await User.findById(userId).select("activePlan walletBalance").lean();
      if (!fresh) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      if ((fresh.activePlan || null) === plan) {
        return res.status(200).json({
          success: true, duplicate: true,
          message: `You are already on the ${plan} plan`,
          walletBalance: fresh.walletBalance, activePlan: fresh.activePlan,
        });
      }
      return res.status(402).json({
        success: false,
        message: `Insufficient wallet balance. ${plan} costs ₹${fee} — please top up first.`,
        required: fee, balance: fresh.walletBalance ?? 0,
      });
    }

    await Transaction.create({
      userId,
      orderId: `plan_${String(userId)}_${Date.now()}`,
      amount: fee,
      gstAmount: 0,
      totalAmount: fee,
      currency: "INR",
      type: "DEBIT",
      purpose: "PLAN_PURCHASE",
      status: "SUCCESS",
      gateway: "WALLET",
      planTier: plan,
      description: `${plan.toUpperCase()} plan activation from wallet`,
    });

    const updated = await User.findById(userId).select("walletBalance activePlan email name partner_id").lean();
    if (updated?.email) {
      sendPlanActivationMail(updated.email, {
        name: updated.name, plan, planFee: fee,
        walletBalance: updated.walletBalance,
        transactionId: `plan_${String(userId)}`,
        partnerId: updated.partner_id, date: new Date(),
      }).catch((e) => console.error("[mail] plan activation receipt failed:", e.message));
    }
    return res.status(200).json({
      success: true,
      message: `${plan} plan activated`,
      walletBalance: updated.walletBalance,
      activePlan: updated.activePlan,
      planFee: fee,
    });
  } catch (err) {
    // Genuine duplicate (parallel double-click): the guard above already
    // resolved it into duplicate:true, so reaching here means a real error.
    // Balance moves only via the guarded update, never here.
    console.error("activatePlan Error:", err);
    // If the debit applied but the ledger write failed, surface loudly —
    // do NOT retry blindly (would double-charge).
    return res.status(500).json({ success: false, message: "Could not activate plan. Please contact support if balance was deducted." });
  }
}
