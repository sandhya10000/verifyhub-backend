// Cron-only low-balance alerts.
// Sends at most one mail per user per `lowBalanceAlertIntervalDays`
// while their wallet stays below `lowBalanceThreshold` (both from Pricing).
const User = require("../models/User");
const Pricing = require("../models/Pricing");
const { sendLowBalanceMail } = require("../utils/sendMail");

let running = false;

async function runLowBalanceAlerts() {
  if (running) {
    console.log("[low-balance] previous run still in progress — skipping");
    return { skipped: true };
  }
  running = true;
  try {
    const pricing = await Pricing.findOne({ key: "default" }).lean();
    const threshold = Number(pricing?.lowBalanceThreshold ?? 500);
    const intervalDays = Math.max(1, Number(pricing?.lowBalanceAlertIntervalDays ?? 7));
    const cutoff = new Date(Date.now() - intervalDays * 24 * 60 * 60 * 1000);

    const due = await User.find({
      role: { $ne: "admin" },
      isActive: true,
      walletBalance: { $lt: threshold },
      $or: [{ lowBalanceLastAlertAt: null }, { lowBalanceLastAlertAt: { $lte: cutoff } }],
    }).select("name email phone walletBalance lowBalanceLastAlertAt").lean();

    let sent = 0, failed = 0;
    for (const u of due) {
      if (!u.email) continue;
      try {
        const r = await sendLowBalanceMail(u.email, {
          name: u.name, balance: u.walletBalance, threshold,
        });
        if (u.phone) {
          try {
            const { sendLowBalanceWhatsApp } = require("../utils/sendWhatsApp");
            await sendLowBalanceWhatsApp(u.phone, { balance: u.walletBalance, threshold });
          } catch (waErr) {
            console.error("[low-balance] whatsapp failed for", u.phone, ":", waErr.message);
          }
        }
        if (r?.skipped) continue;
        await User.updateOne({ _id: u._id }, { $set: { lowBalanceLastAlertAt: new Date() } });
        sent++;
      } catch (err) {
        failed++;
        console.error("[low-balance] mail failed for", u.email, ":", err.message);
      }
    }
    console.log(`[low-balance] done: ${sent} sent, ${failed} failed, ${due.length} due (threshold ₹${threshold}, every ${intervalDays}d)`);
    return { sent, failed, due: due.length, threshold, intervalDays };
  } finally {
    running = false;
  }
}

module.exports = { runLowBalanceAlerts };
