'use strict';
// Syncs White Label statuses so only partners who paid ₹2500 have 'paid' status,
// unpaid partners have 'not_purchased', and only VH098 has 'active' status.
//
// Usage:
//   node scripts/syncWhiteLabelStatuses.js
//   node scripts/syncWhiteLabelStatuses.js --apply

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const BrandProfile = require('../models/BrandProfile');
const Transaction = require('../models/Transaction');

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI / MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected to DB. Running sync (${apply ? 'APPLY' : 'DRY RUN'})...`);

  try {
    const allUsers = await User.find({}).select('_id partner_id email brandingStatus').lean();

    let countResetToNotPurchased = 0;
    let countSetToPaid = 0;
    let countActiveVH098 = 0;

    for (const user of allUsers) {
      const partnerCode = String(user.partner_id || '').toLowerCase();
      const userId = user._id;

      // Check if user has paid ₹2500
      const hasPaidRequest = await CustomBrandedRequest.exists({
        partnerId: userId,
        paymentStatus: 'Paid',
      });

      const hasPaidTxn = await Transaction.exists({
        userId,
        purpose: 'CUSTOM_BRAND_FEE',
        status: 'SUCCESS',
      });

      const isPaid = Boolean(hasPaidRequest || hasPaidTxn);

      let targetStatus = 'not_purchased';

      if (isPaid) {
        if (partnerCode === 'vh098') {
          targetStatus = 'active';
        } else {
          // If setup was done previously or status was active, normalize to paid
          targetStatus = 'paid';
        }
      } else {
        targetStatus = 'not_purchased';
      }

      if (user.brandingStatus !== targetStatus) {
        console.log(`User ${user.email} (${user.partner_id || user._id}): status ${user.brandingStatus} -> ${targetStatus}`);

        if (targetStatus === 'not_purchased') countResetToNotPurchased++;
        if (targetStatus === 'paid') countSetToPaid++;
        if (targetStatus === 'active') countActiveVH098++;

        if (apply) {
          await User.updateOne(
            { _id: userId },
            { $set: { brandingStatus: targetStatus } }
          );

          if (targetStatus !== 'active' && partnerCode !== 'vh098') {
            await CustomBrandedRequest.updateMany(
              { partnerId: userId, setupStatus: 'done' },
              { $set: { setupStatus: 'in_progress', status: 'Active' } }
            );
          }
        }
      }
    }

    console.log(`\nSummary:`);
    console.log(`- Users needing reset to 'not_purchased' (unpaid): ${countResetToNotPurchased}`);
    console.log(`- Users needing set to 'paid': ${countSetToPaid}`);
    console.log(`- Users set to 'active' (VH098): ${countActiveVH098}`);

    if (!apply) {
      console.log('\nRun with --apply to write changes to database.');
    } else {
      console.log('\nChanges successfully applied to database!');
    }

  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
