'use strict';
// Setup script for partner VH744 (Ultimate Associates Pvt Ltd)
// Creates / updates the active BrandProfile with red/black/white theme,
// social links, contact info, and activates their branding status.
//
// Usage:
//   node scripts/setupVH744.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const BrandProfile = require('../models/BrandProfile');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const { validateBrand, resolveBrandLogo } = require('../utils/reportRenderer');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI / MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB. Setting up VH744...');

  try {
    // 1. Locate partner VH744
    const user = await User.findOne({
      partner_id: { $regex: /^vh744$/i },
    });

    if (!user) {
      console.error('Could not find user with partner_id VH744 in database!');
      process.exit(1);
    }

    console.log(`Found partner VH744: ${user.name} (${user.email}, _id: ${user._id})`);

    // 2. Read logo from brand-assets/vh744/logo.png
    const logoDir = path.join(__dirname, '..', 'brand-assets', 'vh744');
    let logoPath = path.join(logoDir, 'logo.png');
    if (!fs.existsSync(logoPath)) {
      const altLogo = path.join(logoDir, 'ultimate_logo.png');
      if (fs.existsSync(altLogo)) {
        fs.copyFileSync(altLogo, logoPath);
      } else {
        console.error(`No logo found in ${logoDir}`);
        process.exit(1);
      }
    }

    const logoBytes = fs.readFileSync(logoPath);
    const logoDataUri = `data:image/png;base64,${logoBytes.toString('base64')}`;

    const logoObj = {
      dataUri: logoDataUri,
      mimeType: 'image/png',
      width: 0,
      height: 0,
    };

    // 3. Define brand profile details
    // Red, Black, White theme
    // Red (Primary): #E50914 (or bold red #D32F2F / #DC2626)
    // Black (Secondary): #1E293B / #111827 / #000000
    // White / Neutral Accent: #FFFFFF or subtle highlight
    const brandDoc = {
      partnerId: user._id,
      partnerCode: 'vh744',
      firmName: 'Ultimate Associates',
      tagline: 'Your Trusted Financial Partner',
      logo: logoObj,
      colors: {
        primary: '#DC2626',   // Bold Red
        secondary: '#111827', // Deep Black
        accent: '#991B1B',    // Dark Crimson Red (satisfies hex validation)
      },
      email: 'info@ultimatecare.in',
      website: 'http://www.ultimateassociates.net',
      phone: user.phone || '9999999999',
      whatsapp: user.phone || '',
      socialLinks: {
        linkedin: 'https://www.linkedin.com/company/ultimate-associates-pvt-ltd/?viewAsMember=true',
        instagram: 'https://www.instagram.com/ultimate_associates/',
        facebook: 'https://www.facebook.com/ultimateconsultants.in',
        youtube: 'https://www.youtube.com/@FinancebyultimateAssociates',
      },
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

    console.log(`Created active BrandProfile version ${version} for VH744 (_id: ${createdProfile._id})`);

    // 6. Update user brandingStatus to 'active'
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          brandingStatus: 'active',
          brandingPaidAt: user.brandingPaidAt || new Date(),
          brandingAmount: user.brandingAmount || 2500,
          'brandingDetails.companyName': brandDoc.firmName,
          'brandingDetails.tagline': brandDoc.tagline,
          'brandingDetails.contactEmail': brandDoc.email,
        },
      }
    );

    // 7. Update CustomBrandedRequest to setupStatus = 'done' and status = 'Completed'
    await CustomBrandedRequest.updateMany(
      { partnerId: user._id },
      {
        $set: {
          setupStatus: 'done',
          status: 'Completed',
          setupCompletedAt: new Date(),
        },
      }
    );

    console.log('Successfully activated VH744 with custom branding and upload capability!');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Setup error:', err);
  process.exit(1);
});
