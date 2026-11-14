'use strict';
// Promote an existing user to the brand_designer role (or demote back to user).
//
// Usage:
//   node scripts/setBrandDesignerRole.js <email> [--revoke]
//
// The user must already have an account (sign up normally first). Requires
// MONGO_URI / MONGODB_URI in .env.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function main() {
  const [, , rawEmail, flag] = process.argv;
  if (!rawEmail) {
    console.error('Usage: node scripts/setBrandDesignerRole.js <email> [--revoke]');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI / MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const email = String(rawEmail).trim().toLowerCase();
  const revoke = flag === '--revoke';
  const role = revoke ? 'user' : 'brand_designer';

  const user = await User.findOneAndUpdate(
    { email },
    { $set: { role } },
    { new: true },
  ).select('email role').lean();

  if (!user) {
    console.error(`No user found with email ${email}`);
  } else {
    console.log(`Updated ${user.email}: role = ${user.role}`);
  }
  await mongoose.disconnect();
  process.exit(user ? 0 : 1);
}

main().catch(async (err) => {
  console.error('setBrandDesignerRole failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
