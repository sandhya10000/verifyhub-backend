const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: 'c:/verifyhub/verifyhub-backend/.env' });

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to:', process.env.MONGO_URI);
  
  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  const BrandProfile = mongoose.model('BrandProfile', new mongoose.Schema({}, { strict: false }));
  const CustomBrandedRequest = mongoose.model('CustomBrandedRequest', new mongoose.Schema({}, { strict: false }));

  const user = await User.findOne({ partner_id: { $regex: '^vh744$', $options: 'i' } }).lean();
  console.log('User VH744:', user ? {
    _id: user._id,
    name: user.name,
    email: user.email,
    partner_id: user.partner_id,
    brandingStatus: user.brandingStatus,
    brandingPaidAt: user.brandingPaidAt,
  } : 'NOT FOUND');

  if (user) {
    const profiles = await BrandProfile.find({ partnerId: user._id }).lean();
    console.log('BrandProfiles for user:', profiles.map(p => ({
      _id: p._id,
      partnerCode: p.partnerCode,
      firmName: p.firmName,
      isActive: p.isActive,
      version: p.version
    })));

    const requests = await CustomBrandedRequest.find({ partnerId: user._id }).lean();
    console.log('CustomBrandedRequests for user:', requests.map(r => ({
      _id: r._id,
      paymentStatus: r.paymentStatus,
      status: r.status,
      setupStatus: r.setupStatus
    })));
  }

  await mongoose.disconnect();
}
check().catch(err => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
