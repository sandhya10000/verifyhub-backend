const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { createPaymentLink } = require("../utils/paymentLink");
const { normalizePhone } = require("../utils/sendWhatsApp");

// How far back a failed recharge stays retryable from the WhatsApp page.
const LOOKBACK_DAYS = 7;
const MAX_ROWS = 10;

function amountOf(txn) {
  return Number(txn.totalAmount) || Number(txn.amount) || 0;
}

// GET /api/wallet-recharge/retries — the caller's failed wallet recharges that
// already received a WhatsApp retry link. Each row is backed by a live hosted
// Razorpay Payment Link (created at failure time); if that link is missing or
// expired a fresh one is created here and persisted, so the partner can always
// pay from the retry page.
const listWalletRechargeRetries = async (req, res) => {
  try {
    const userId = req.user._id;
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const txns = await Transaction.find({
      userId,
      purpose: "WALLET_RECHARGE",
      status: "FAILED",
      retryLinkSentAt: { $gte: since },
    })
      .sort({ retryLinkSentAt: -1 })
      .limit(MAX_ROWS)
      .lean();

    if (!txns.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const user = await User.findById(userId).select("name email phone").lean();
    const now = Date.now();
    const data = [];

    for (const txn of txns) {
      let url = txn.retryLinkUrl || null;
      let expiresAt = txn.retryLinkExpiresAt ? new Date(txn.retryLinkExpiresAt) : null;
      const expired = !url || !expiresAt || expiresAt.getTime() <= now;

      if (expired) {
        try {
          const link = await createPaymentLink({
            amount: amountOf(txn),
            name: user?.name,
            contact: normalizePhone(user?.phone),
            email: user?.email,
            description: "VerifyHub wallet recharge",
            transactionId: String(txn._id),
            orderId: txn.orderId,
            purpose: "WALLET_RECHARGE",
            callbackPath: "/partner/add-funds",
          });
          if (link?.shortUrl) {
            url = link.shortUrl;
            expiresAt = link.expiresAt || null;
            await Transaction.updateOne(
              { _id: txn._id },
              {
                $set: {
                  retryLinkId: link.id,
                  retryLinkUrl: link.shortUrl,
                  retryLinkExpiresAt: link.expiresAt || null,
                },
              },
            );
          }
        } catch (e) {
          console.error("[payment-retry] refresh link failed:", e.message);
        }
      }

      // Razorpay unavailable and nothing stored — nothing to pay from.
      if (!url) continue;

      data.push({
        transactionId: String(txn._id),
        orderId: txn.orderId,
        amount: Number(txn.amount) || 0,
        gstAmount: Number(txn.gstAmount) || 0,
        totalAmount: amountOf(txn),
        walletCredit: Number(txn.walletCredit) || Number(txn.amount) || 0,
        bonusCredit: Number(txn.bonusCredit) || 0,
        retryLinkUrl: url,
        expiresAt,
        createdAt: txn.createdAt,
      });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[payment-retry] list failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load retry payments",
    });
  }
};

module.exports = { listWalletRechargeRetries };
