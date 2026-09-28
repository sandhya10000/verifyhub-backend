const Razorpay = require("razorpay");
const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const User = require("../models/User");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const createWalletRechargeOrder = async (req, res) => {
  try {
    console.log("Wallet recharge request:", req.body);

    const { amount } = req.body;
    const userId = req.user.id;

    // 1. Validate amount (floor moves to Pricing config later)
    const MIN_RECHARGE = 100;
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

    // 3. GST calculation
    const GST_RATE = 18;

    const gstAmount = (baseAmount * GST_RATE) / 100;

    const totalAmount = baseAmount + gstAmount;

    console.log("Base Amount:", baseAmount);
    console.log("GST Amount:", gstAmount);
    console.log("Total Amount:", totalAmount);

    // 4. Create Razorpay order
    const options = {
      amount: Math.round(totalAmount * 100),
      currency: "INR",
      receipt: `wallet_recharge_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    console.log("Razorpay order created:", order.id);

    // 5. Save transaction
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
    });

    await transaction.save();

    // 6. Response (keyId is public — the frontend needs it for Checkout.js)
    return res.status(200).json({
      success: true,

      orderId: order.id,

      keyId: process.env.RAZORPAY_KEY_ID,

      amount: order.amount,

      currency: order.currency,

      transactionId: transaction._id,

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

    // 7. Wallet recharge
    if (transaction.purpose === "WALLET_RECHARGE") {
      // Plan tier from the recharge slab (floor-mapped). Sticky: a small
      // top-up never downgrades an existing higher tier.
      const { tierForAmount, PLAN_KEYS } = require("../models/Pricing");
      const newPlan = tierForAmount(transaction.amount);
      const current = await User.findById(transaction.userId).select("activePlan").lean();
      const keepPlan =
        current &&
        PLAN_KEYS.indexOf(current.activePlan || "starter") >= PLAN_KEYS.indexOf(newPlan)
          ? current.activePlan
          : newPlan;
      const updatedUser = await User.findByIdAndUpdate(
        transaction.userId,
        {
          $inc: {
            walletBalance: transaction.amount,
          },
          $set: {
            activePlan: keepPlan,
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

      return res.status(200).json({
        success: true,
        message: "Wallet recharged successfully",
        transaction,
        walletBalance: updatedUser.walletBalance,
        activePlan: updatedUser.activePlan,
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
};
