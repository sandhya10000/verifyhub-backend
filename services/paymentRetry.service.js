const Transaction = require("../models/Transaction");
const { createPaymentLink } = require("../utils/paymentLink");
const { sendPaymentRetryWhatsApp, normalizePhone } = require("../utils/sendWhatsApp");

// Send a Razorpay payment link to a partner's WhatsApp after a genuine
// payment failure. Designed to be fire-and-forget and idempotent:
//   - retryLinkSentAt acts as an atomic once-per-order claim
//   - the claim is released again if link creation fails so a later retry
//     can still deliver
// Never throws — callers log the returned reason.
async function sendRetryLink({
  transaction,
  phone,
  name,
  email,
  amount,
  purpose,
  description,
  callbackPath,
}) {
  if (!transaction || !transaction._id) {
    return { sent: false, reason: "no-transaction" };
  }

  try {
    // Atomic claim: only the first caller flips null -> timestamp.
    const claimed = await Transaction.findOneAndUpdate(
      { _id: transaction._id, retryLinkSentAt: null },
      { $set: { retryLinkSentAt: new Date() } },
      { new: true },
    ).lean();
    if (!claimed) return { sent: false, reason: "already-sent" };

    const contact = normalizePhone(phone);
    if (!contact) {
      await Transaction.updateOne(
        { _id: transaction._id },
        { $set: { retryLinkSentAt: null } },
      );
      return { sent: false, reason: "no-phone" };
    }

    let link = null;
    try {
      link = await createPaymentLink({
        amount,
        name,
        contact,
        email,
        description,
        transactionId: String(transaction._id),
        orderId: transaction.orderId,
        purpose,
        callbackPath,
      });
    } catch (e) {
      await Transaction.updateOne(
        { _id: transaction._id },
        { $set: { retryLinkSentAt: null } },
      );
      console.error("[payment-retry] link creation failed:", e.message);
      return { sent: false, reason: "link-failed" };
    }

    if (!link?.shortUrl) {
      await Transaction.updateOne(
        { _id: transaction._id },
        { $set: { retryLinkSentAt: null } },
      );
      return { sent: false, reason: "link-unavailable" };
    }

    await Transaction.updateOne(
      { _id: transaction._id },
      { $set: { retryLinkId: link.id, retryLinkUrl: link.shortUrl } },
    );

    const whatsapp = await sendPaymentRetryWhatsApp(phone, {
      name,
      amount,
      link: link.shortUrl,
    });

    console.log(
      `[payment-retry] link ${link.id} for txn ${transaction._id} -> ${whatsapp?.sent ? "whatsapp sent" : "whatsapp not sent"}`,
    );
    return { sent: true, url: link.shortUrl, whatsapp };
  } catch (e) {
    console.error("[payment-retry] unexpected failure:", e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendRetryLink };
