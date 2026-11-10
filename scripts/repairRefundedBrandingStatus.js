'use strict';
// Repairs partners whose wallet white-label payment was refunded by the old
// race-guard bug but who were left with brandingStatus='paid' and no paid
// request or successful fee transaction.
//
// Dry run by default. Pass --apply to write.
//   node scripts/repairRefundedBrandingStatus.js
//   node scripts/repairRefundedBrandingStatus.js --apply

require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const User = require('../models/User');

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI / MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const refundedUserIds = await Transaction.distinct('userId', {
      purpose: 'CUSTOM_BRAND_FEE',
      status: 'REFUNDED',
    });
    const candidates = await User.find({
      _id: { $in: refundedUserIds },
      brandingStatus: 'paid',
    }).select('_id email brandingPaidAt brandingAmount').lean();

    const stuck = [];
    for (const u of candidates) {
      const hasSuccess = await Transaction.exists({
        userId: u._id, purpose: 'CUSTOM_BRAND_FEE', status: 'SUCCESS',
      });
      const hasPaidRequest = await CustomBrandedRequest.exists({
        partnerId: u._id, paymentStatus: 'Paid',
      });
      if (!hasSuccess && !hasPaidRequest) stuck.push(u);
    }

    console.log(`Found ${stuck.length} partner(s) stuck at brandingStatus='paid' after a refund.`);
    for (const u of stuck) console.log(`  ${u.email} (${u._id})`);

    if (!apply) {
      console.log('Dry run only. Re-run with --apply to reset them to not_purchased.');
      return;
    }

    const res = await User.updateMany(
      { _id: { $in: stuck.map((u) => u._id) } },
      {
        $set: { brandingStatus: 'not_purchased' },
        $unset: { brandingPaidAt: '', brandingAmount: '' },
      },
    );
    console.log(`Reset ${res.modifiedCount} partner(s) to not_purchased.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('repair failed:', err.message);
  process.exit(1);
});
