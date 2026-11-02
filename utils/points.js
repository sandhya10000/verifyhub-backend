const User = require("../models/User");
const PointsLedger = require("../models/PointsLedger");

// Earning: 1 point per Rs 1 paid on a wallet recharge.
const POINTS_PER_RUPEE_EARN = 1;

// Redemption: 10 points = Rs 1.
const POINTS_PER_RUPEE_REDEEM = 10;

// Per-order redemption caps.
const AI_MAX_POINTS = 100;
const CBR_MAX_POINTS = 1000;

const pointsToRupees = (points) => Math.floor(Number(points) || 0) / POINTS_PER_RUPEE_REDEEM;

// Largest whole-point amount allowed: min(requested, balance, cap).
const clampRedeem = (requested, balance, cap) => {
  const req = Math.max(0, Math.floor(Number(requested) || 0));
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  return Math.min(req, bal, cap);
};

// Credit points for a paid recharge. The ledger row is written first with a
// unique key, so replaying the same order (verify + webhook) never double-credits.
const earnPoints = async (userId, rupeesPaid, orderId) => {
  const points = Math.floor(Number(rupeesPaid) * POINTS_PER_RUPEE_EARN) || 0;
  if (points <= 0) return { ok: false, reason: "zero" };

  const key = `earn_${orderId}`;
  try {
    await PointsLedger.create({
      userId,
      type: "EARN",
      points,
      rupeeValue: 0,
      key,
      refId: String(orderId),
      description: `Earned on recharge ${orderId}`,
    });
  } catch (err) {
    if (err?.code === 11000) return { ok: false, reason: "duplicate" };
    throw err;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { creditPoints: points } },
    { new: true },
  );
  if (user) {
    await PointsLedger.updateOne({ key }, { $set: { balanceAfter: user.creditPoints } });
  }
  return { ok: true, points, balance: user?.creditPoints ?? null };
};

module.exports = {
  POINTS_PER_RUPEE_EARN,
  POINTS_PER_RUPEE_REDEEM,
  AI_MAX_POINTS,
  CBR_MAX_POINTS,
  pointsToRupees,
  clampRedeem,
  earnPoints,
};
