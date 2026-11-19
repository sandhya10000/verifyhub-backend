'use strict';
// Setup script for partner VH1243 (OnePaid)
// Activates White Label Solutions with custom OnePaid branding (Blue & White palette),
// logo at brand-assets/vh1243/logo.jpeg, contact email Support@onepaid.in, phone 89890-77057.
//
// Usage:
//   node scripts/setupVH1243.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const BrandProfile = require('../models/BrandProfile');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const { validateBrand } = require('../utils/reportRenderer');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI / MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB. Setting up VH1243...');

  try {
    // 1. Locate partner VH1243
    const user = await User.findOne({
      partner_id: { $regex: '^vh1243$', $options: 'i' },
    });

    if (!user) {
      console.error('Could not find user with partner_id VH1243 in database!');
      process.exit(1);
    }

    console.log(`Found partner VH1243: ${user.name} (${user.email}, _id: ${user._id})`);

    // 2. Read logo from brand-assets/vh1243/logo.jpeg
    const logoDir = path.join(__dirname, '..', 'brand-assets', 'vh1243');
    const logoPath = path.join(logoDir, 'logo.jpeg');

    if (!fs.existsSync(logoPath)) {
      console.error(`No logo found at ${logoPath}`);
      process.exit(1);
    }

    const logoBytes = fs.readFileSync(logoPath);
    const logoDataUri = `data:image/jpeg;base64,${logoBytes.toString('base64')}`;

    const logoObj = {
      dataUri: logoDataUri,
      mimeType: 'image/jpeg',
      width: 1254,
      height: 1254,
    };

    // 3. Define brand profile details
    // OnePaid Theme: Vibrant Electric Blue, Dark Royal Blue & Cyan Accent
    const brandDoc = {
      partnerId: user._id,
      partnerCode: 'vh1243',
      firmName: 'OnePaid',
      tagline: 'Your Credit, Your Future',
      logo: logoObj,
      colors: {
        primary: '#0052FF',   // Vibrant OnePaid Electric Blue
        secondary: '#0A192F', // Deep Navy / Midnight Blue
        accent: '#00C48C',    // Modern Accent Green / Cyan
      },
      email: 'support@onepaid.in',
      website: 'https://onepaid.in',
      phone: '8989077057',
      whatsapp: '8989077057',
      isActive: true,
    };

    // 4. Validate brand
    try {
      validateBrand(brandDoc);
      console.log('Brand validation passed successfully!');
    } catch (valErr) {
      console.error('Brand validation failed:', valErr.message);
      process.exit(1);
    }

    // 5. Deactivate old profiles and save new profile
    const latest = await BrandProfile.findOne({ partnerId: user._id }).sort({ version: -1 }).lean();
    const version = (latest?.version || 0) + 1;

    await BrandProfile.updateMany({ partnerId: user._id, isActive: true }, { $set: { isActive: false } });

    const createdProfile = await BrandProfile.create({
      ...brandDoc,
      version,
    });

    console.log(`Created active BrandProfile version ${version} for VH1243 (_id: ${createdProfile._id})`);

    // 6. Update user brandingStatus to 'active'
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          brandingStatus: 'active',
          brandingPaidAt: user.brandingPaidAt || new Date(),
          brandingAmount: 2500,
          'brandingDetails.companyName': brandDoc.firmName,
          'brandingDetails.tagline': brandDoc.tagline,
          'brandingDetails.contactEmail': brandDoc.email,
          'brandingDetails.contactPhone': brandDoc.phone,
        },
      }
    );

    // 7. Ensure CustomBrandedRequest exists and marked done / Completed
    await CustomBrandedRequest.findOneAndUpdate(
      { partnerId: user._id },
      {
        $set: {
          partnerId: user._id,
          email: brandDoc.email,
          phone: brandDoc.phone,
          amount: 2500,
          paymentMethod: 'ADMIN_FREE',
          paymentStatus: 'Paid',
          status: 'Completed',
          setupStatus: 'done',
          setupCompletedAt: new Date(),
          requestId: 'CR-1243',
        },
      },
      { upsert: true, new: true }
    );

    console.log('Successfully activated VH1243 (OnePaid) with custom branding and upload capability!');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Setup error:', err);
  process.exit(1);
});
