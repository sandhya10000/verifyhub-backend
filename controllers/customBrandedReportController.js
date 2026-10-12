const crypto = require('crypto');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { CBR_PRICE_INR } = require('../models/Pricing');
const { sendCbrReceiptMail, sendCbrAdminNotifyMail } = require('../utils/sendMail');

function razorpayClient() {
  // eslint-disable-next-line global-require
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ---------------------------------------------------------------------------
// Notify on successful subscription — partner receipt + platform/admin alert.
// Same fan-out as wallet top-up alerts. Fully fire-and-forget: failures never
// affect the payment response, and one recipient failing never blocks others.
// ---------------------------------------------------------------------------
function notifySubscription(request, partner, txn) {
  try {
    const method = request.paymentMethod === 'WALLET' ? 'Wallet credits' : 'Razorpay';
    const payload = {
      name: partner.name,
      email: request.email,
      phone: request.phone,
      partnerId: partner.partner_id,
      requestId: request.requestId,
      amount: request.amount || CBR_PRICE_INR,
      method,
      orderId: request.orderId || txn?.orderId,
      paymentId: request.paymentId,
      transactionId: txn ? String(txn._id) : null,
      date: request.updatedAt || new Date(),
    };

    // 1. Partner receipt
    if (request.email) {
      sendCbrReceiptMail(request.email, payload).catch((e) =>
        console.error('[mail] CBR partner receipt failed:', e.message));
    }

    // 2. Platform + all active admins
    (async () => {
      try {
        const platform = String(process.env.TOPUP_NOTIFY_EMAILS || 'info@verifyhub.in')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const admins = await User.find({ role: 'admin', isActive: { $ne: false } })
          .select('email').lean();
        const recipients = new Set([
          ...platform,
          ...admins.map((a) => a && a.email).filter(Boolean),
        ]);
        if (request.email) recipients.delete(request.email); // already got the receipt
        await Promise.allSettled([...recipients].map((to) =>
          sendCbrAdminNotifyMail(to, payload).catch((e) =>
            console.error('[mail] CBR admin notify failed:', to, e.message))));
      } catch (e) {
        console.error('[mail] CBR admin notify failed:', e.message);
      }
    })();
  } catch (e) {
    console.error('[mail] CBR notify failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Shared validation — details come first, payment second (details-then-pay)
// ---------------------------------------------------------------------------
function validateContact(email, phone) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return 'A valid email address is required.';
  }
  const digitsOnly = String(phone || '').replace(/^\+91/, '').replace(/\D/g, '');
  if (!digitsOnly || digitsOnly.length !== 10) {
    return 'A valid 10-digit Indian mobile number is required.';
  }
  return null;
}

async function findBlockingRequest(partnerId) {
  // A Paid+Active request blocks any new payment (one-time fee).
  // A Pending+Unpaid skeleton is resumable — not blocking, reused by /order.
  const [request, user] = await Promise.all([
    CustomBrandedRequest.findOne({
      partnerId,
      paymentStatus: 'Paid',
    }).lean(),
    User.findById(partnerId).select('brandingStatus brandingPaidAt brandingAmount').lean(),
  ]);

  if (user && user.brandingStatus && user.brandingStatus !== 'not_purchased') {
    return {
      status: user.brandingStatus,
      paidAt: user.brandingPaidAt,
      amount: user.brandingAmount || CBR_PRICE_INR,
      reason: 'User already has an active branding subscription',
    };
  }

  return request || null;
}

// ---------------------------------------------------------------------------
// GET /api/partner/custom-branded-report/status
// Status endpoint returning persistent status, paid_at, amount, and onboarding details.
// ---------------------------------------------------------------------------
async function getBrandingStatus(req, res) {
  try {
    const partnerId = req.user._id;
    const user = await User.findById(partnerId).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    let request = await CustomBrandedRequest.findOne({ partnerId, paymentStatus: 'Paid' })
      .sort({ updatedAt: -1 })
      .lean();

    // If no paid request found, check if an unpaid skeleton exists for resuming checkout
    if (!request) {
      request = await CustomBrandedRequest.findOne({ partnerId })
        .sort({ updatedAt: -1 })
        .lean();
    }

    let status = user.brandingStatus || 'not_purchased';
    let paidAt = user.brandingPaidAt || null;
    let amount = user.brandingAmount || null;

    // Self-healing check: If the user has a successful CUSTOM_BRAND_FEE transaction
    // or a Paid CustomBrandedRequest but brandingStatus is not_purchased/unset, sync it now!
    if (status === 'not_purchased' || !status) {
      const successfulTxn = await Transaction.findOne({
        userId: partnerId,
        purpose: 'CUSTOM_BRAND_FEE',
        status: 'SUCCESS',
      }).sort({ createdAt: -1 }).lean();

      if (successfulTxn || (request && request.paymentStatus === 'Paid')) {
        status = 'paid';
        paidAt = user.brandingPaidAt || successfulTxn?.createdAt || request?.updatedAt || new Date();
        amount = user.brandingAmount || successfulTxn?.amount || request?.amount || CBR_PRICE_INR;

        // Persist the healed status to the user record
        await User.updateOne(
          { _id: partnerId },
          {
            $set: {
              brandingStatus: 'paid',
              brandingPaidAt: paidAt,
              brandingAmount: amount,
            },
          }
        );

        // Ensure a paid CustomBrandedRequest exists
        if (!request || request.paymentStatus !== 'Paid') {
          request = await CustomBrandedRequest.findOneAndUpdate(
            { partnerId, paymentStatus: 'Paid' },
            {
              $setOnInsert: {
                partnerId,
                email: user.email,
                phone: user.phone || '',
                amount,
                paymentStatus: 'Paid',
                paymentMethod: successfulTxn?.gateway || 'WALLET',
                orderId: successfulTxn?.orderId || `cbr_healed_${partnerId}`,
                paymentId: successfulTxn ? String(successfulTxn._id) : undefined,
                status: 'Active',
              },
            },
            { upsert: true, new: true }
          ).lean();
        }
      }
    }

    const details = {
      email: request?.email || user.email || '',
      phone: request?.phone || user.phone || '',
      ...(user.brandingDetails || {}),
      ...(request?.brandingDetails || {}),
    };

    const revisionsUsed = Number(details.revisionsUsed || 0);
    const revisionsRemaining = Math.max(0, 2 - revisionsUsed);

    return res.json({
      success: true,
      data: {
        status: status || 'not_purchased',
        paid_at: paidAt,
        amount: amount || (status !== 'not_purchased' ? CBR_PRICE_INR : null),
        onboarding_details: {
          ...details,
          revisionsUsed,
          revisionsRemaining,
        },
        request: request || null,
      },
    });
  } catch (err) {
    console.error('[customBrandedReport] getBrandingStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch branding status.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/partner/custom-branded-report/quote
// Price + live wallet balance so the UI can disable the wallet option.
// ---------------------------------------------------------------------------
async function getQuote(req, res) {
  try {
    const me = await User.findById(req.user._id).select('walletBalance').lean();
    const balance = me?.walletBalance ?? 0;
    return res.json({
      success: true,
      data: {
        price: CBR_PRICE_INR,
        currency: 'INR',
        walletBalance: balance,
        canAffordWallet: balance >= CBR_PRICE_INR,
      },
    });
  } catch (err) {
    console.error('[customBrandedReport] getQuote error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch price quote.' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/partner/custom-branded-report/pay/wallet
// Body: { email, phone } — atomic wallet debit (₹2500 flat, GST-inclusive).
// ---------------------------------------------------------------------------
async function payWithWallet(req, res) {
  try {
    const partnerId = req.user._id;

    // Idempotency check 1: Ensure user has not already purchased
    const currentUser = await User.findById(partnerId);
    if (currentUser && currentUser.brandingStatus && currentUser.brandingStatus !== 'not_purchased') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'You have already paid for the AI Custom Branded Report. Duplicate charge blocked.',
        data: {
          status: currentUser.brandingStatus,
          paid_at: currentUser.brandingPaidAt,
          amount: currentUser.brandingAmount,
        },
      });
    }

    const blocked = await findBlockingRequest(partnerId);
    if (blocked) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'You already have an active custom branded report request. Duplicate charge blocked.',
        data: blocked,
      });
    }

    const { email, phone } = req.body;
    const validationError = validateContact(email, phone);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const digitsOnly = String(phone).replace(/^\+91/, '').replace(/\D/g, '');

    // ATOMIC GUARD: Debit balance AND set brandingStatus = 'paid' in a single atomic update.
    // Guarantees balance cannot go negative AND user cannot be double-charged.
    const now = new Date();
    const debit = await User.updateOne(
      {
        _id: partnerId,
        walletBalance: { $gte: CBR_PRICE_INR },
        $or: [
          { brandingStatus: 'not_purchased' },
          { brandingStatus: { $exists: false } },
          { brandingStatus: null },
        ],
      },
      {
        $inc: { walletBalance: -CBR_PRICE_INR },
        $set: {
          brandingStatus: 'paid',
          brandingPaidAt: now,
          brandingAmount: CBR_PRICE_INR,
        },
      },
    );

    if (debit.modifiedCount === 0) {
      const me = await User.findById(partnerId).select('walletBalance brandingStatus').lean();
      if (me && me.brandingStatus && me.brandingStatus !== 'not_purchased') {
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_REQUEST',
          message: 'You have already paid for the AI Custom Branded Report. Duplicate charge blocked.',
        });
      }
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        message: `Insufficient wallet balance. ₹${CBR_PRICE_INR.toLocaleString('en-IN')} required — please recharge.`,
        required: CBR_PRICE_INR,
        balance: me?.walletBalance ?? 0,
      });
    }

    const orderId = `cbr_wallet_${String(partnerId)}_${Date.now()}`;
    const [txn] = await Promise.all([
      Transaction.create({
        userId: partnerId,
        orderId,
        amount: CBR_PRICE_INR,
        gstAmount: 0,
        totalAmount: CBR_PRICE_INR,
        currency: 'INR',
        type: 'DEBIT',
        purpose: 'CUSTOM_BRAND_FEE',
        status: 'SUCCESS',
        gateway: 'WALLET',
        description: 'Report charge · CUSTOM BRAND FEE −₹2,500',
      }),
      // Remove any stale unpaid skeleton so only the paid request remains.
      CustomBrandedRequest.deleteMany({ partnerId, paymentStatus: 'Unpaid' }),
    ]);

    // Create or update the paid CustomBrandedRequest
    let newRequest = await CustomBrandedRequest.findOne({ partnerId, paymentStatus: 'Paid' });
    if (!newRequest) {
      newRequest = new CustomBrandedRequest({
        partnerId,
        email: String(email).trim().toLowerCase(),
        phone: digitsOnly,
        status: 'Active',
        amount: CBR_PRICE_INR,
        paymentStatus: 'Paid',
        paymentMethod: 'WALLET',
        orderId,
        paymentId: String(txn._id),
      });
      await newRequest.save();
    }

    notifySubscription(newRequest, req.user, txn);
    const me = await User.findById(partnerId).select('walletBalance brandingStatus').lean();
    return res.status(201).json({
      success: true,
      data: newRequest,
      status: 'paid',
      walletBalance: me?.walletBalance ?? null,
      transactionId: txn._id,
    });
  } catch (err) {
    console.error('[customBrandedReport] payWithWallet error:', err);
    return res.status(500).json({ success: false, message: 'Wallet payment failed. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/partner/custom-branded-report/order
// Body: { email, phone } — creates a Razorpay order + Pending/Unpaid skeleton.
// ---------------------------------------------------------------------------
async function createOrder(req, res) {
  try {
    const partnerId = req.user._id;
    const blocked = await findBlockingRequest(partnerId);
    if (blocked) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'You already have an active custom branded report request.',
        data: blocked,
      });
    }

    const { email, phone } = req.body;
    const validationError = validateContact(email, phone);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const digitsOnly = String(phone).replace(/^\+91/, '').replace(/\D/g, '');

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: 'Online payments are not configured. Please use wallet credits.' });
    }

    const razorpay = razorpayClient();
    const order = await razorpay.orders.create({
      amount: Math.round(CBR_PRICE_INR * 100),
      currency: 'INR',
      receipt: `cbr_${Date.now()}`,
      payment_capture: 1,
    });

    // One resumable skeleton per partner — reuse the unpaid row if the user
    // retries order creation (back button / modal dismiss) instead of
    // piling up Pending rows.
    let skeleton = await CustomBrandedRequest.findOne({ partnerId, paymentStatus: 'Unpaid' });
    if (skeleton) {
      skeleton.email = String(email).trim().toLowerCase();
      skeleton.phone = digitsOnly;
      skeleton.orderId = order.id;
      skeleton.amount = CBR_PRICE_INR;
      skeleton.status = 'Pending';
      await skeleton.save();
    } else {
      skeleton = new CustomBrandedRequest({
        partnerId,
        email: String(email).trim().toLowerCase(),
        phone: digitsOnly,
        status: 'Pending',
        amount: CBR_PRICE_INR,
        paymentStatus: 'Unpaid',
        paymentMethod: 'RAZORPAY',
        orderId: order.id,
      });
      await skeleton.save();
    }

    await Transaction.create({
      userId: partnerId,
      orderId: order.id,
      amount: CBR_PRICE_INR,
      gstAmount: 0,
      totalAmount: CBR_PRICE_INR,
      currency: 'INR',
      type: 'DEBIT',
      purpose: 'CUSTOM_BRAND_FEE',
      status: 'PENDING',
      gateway: 'RAZORPAY',
      description: `Custom Branded Report one-time fee (${skeleton.requestId})`,
    });

    return res.status(200).json({
      success: true,
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      price: CBR_PRICE_INR,
      requestId: skeleton.requestId,
    });
  } catch (err) {
    console.error('[customBrandedReport] createOrder error:', err);
    return res.status(500).json({ success: false, message: 'Could not start online payment. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/partner/custom-branded-report/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Idempotent — safe to retry after network drops.
// ---------------------------------------------------------------------------
async function verifyPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment details are required.' });
    }

    const txn = await Transaction.findOne({ orderId: razorpay_order_id, purpose: 'CUSTOM_BRAND_FEE' });
    if (!txn) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (String(txn.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const request = await CustomBrandedRequest.findOne({ orderId: razorpay_order_id, partnerId: req.user._id });
    // Already verified (client retried after success) — return the request.
    if (txn.status === 'SUCCESS' && request && request.paymentStatus === 'Paid') {
      return res.status(200).json({ success: true, message: 'Payment already verified.', data: request });
    }

    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      txn.status = 'FAILED';
      txn.paymentId = razorpay_payment_id;
      txn.signature = razorpay_signature;
      await txn.save();
      return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
    }

    txn.paymentId = razorpay_payment_id;
    txn.signature = razorpay_signature;
    txn.status = 'SUCCESS';
    await txn.save();

    if (!request) {
      return res.status(404).json({ success: false, message: 'Linked request not found. Contact support.' });
    }
    request.paymentId = razorpay_payment_id;
    request.paymentStatus = 'Paid';
    request.status = 'Active';
    request.amount = CBR_PRICE_INR;
    request.paymentMethod = 'RAZORPAY';
    await request.save();

    // Set User brandingStatus atomically
    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          brandingStatus: 'paid',
          brandingPaidAt: new Date(),
          brandingAmount: CBR_PRICE_INR,
        },
      }
    );

    notifySubscription(request, req.user, txn);
    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully.',
      data: request,
      status: 'paid',
    });
  } catch (err) {
    console.error('[customBrandedReport] verifyPayment error:', err);
    return res.status(500).json({ success: false, message: 'Payment verification failed.' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/partner/custom-branded-report/assets
// Body: { logoUrl, brandColors, companyName, tagline, contactPhone, contactEmail, notes }
// Saves assets and transitions status to 'onboarding'
// ---------------------------------------------------------------------------
async function submitBrandAssets(req, res) {
  try {
    const partnerId = req.user._id;
    const user = await User.findById(partnerId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.brandingStatus === 'not_purchased') {
      return res.status(403).json({
        success: false,
        message: 'Please purchase the AI Custom Branded Report before submitting assets.',
      });
    }

    const {
      logoUrl,
      brandColors,
      companyName,
      tagline,
      contactPhone,
      contactEmail,
      notes,
    } = req.body;

    const existingDetails = user.brandingDetails || {};
    const updatedDetails = {
      ...existingDetails,
      logoUrl: logoUrl !== undefined ? String(logoUrl).trim() : existingDetails.logoUrl,
      brandColors: Array.isArray(brandColors) ? brandColors : existingDetails.brandColors,
      companyName: companyName !== undefined ? String(companyName).trim() : existingDetails.companyName,
      tagline: tagline !== undefined ? String(tagline).trim() : existingDetails.tagline,
      contactPhone: contactPhone !== undefined ? String(contactPhone).trim() : existingDetails.contactPhone,
      contactEmail: contactEmail !== undefined ? String(contactEmail).trim() : existingDetails.contactEmail,
      notes: notes !== undefined ? String(notes).trim() : existingDetails.notes,
      submittedAt: new Date(),
      revisionsUsed: existingDetails.revisionsUsed || 0,
      revisionNotes: existingDetails.revisionNotes || [],
    };

    // Transition status to 'onboarding' if currently 'paid'
    const nextStatus = user.brandingStatus === 'active' ? 'active' : 'onboarding';

    user.brandingDetails = updatedDetails;
    user.brandingStatus = nextStatus;
    await user.save();

    await CustomBrandedRequest.updateMany(
      { partnerId, paymentStatus: 'Paid' },
      { $set: { brandingDetails: updatedDetails } }
    );

    return res.json({
      success: true,
      message: 'Brand assets submitted successfully. Our design team will configure your report.',
      data: {
        status: nextStatus,
        brandingDetails: updatedDetails,
      },
    });
  } catch (err) {
    console.error('[customBrandedReport] submitBrandAssets error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit brand assets.' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/partner/custom-branded-report/request-revision
// Body: { revisionNotes }
// Up to 2 free revisions allowed.
// ---------------------------------------------------------------------------
async function requestRevision(req, res) {
  try {
    const partnerId = req.user._id;
    const user = await User.findById(partnerId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.brandingStatus !== 'active' && user.brandingStatus !== 'onboarding') {
      return res.status(400).json({
        success: false,
        message: 'Revisions can only be requested for paid or active branding.',
      });
    }

    const { revisionNotes } = req.body;
    if (!revisionNotes || !String(revisionNotes).trim()) {
      return res.status(400).json({ success: false, message: 'Revision instructions are required.' });
    }

    const details = user.brandingDetails || {};
    const used = Number(details.revisionsUsed || 0);

    if (used >= 2) {
      return res.status(400).json({
        success: false,
        message: 'All 2 complimentary revision rounds have been used. Contact support for additional changes.',
      });
    }

    const newUsed = used + 1;
    const notesList = [...(details.revisionNotes || []), String(revisionNotes).trim()];

    user.brandingDetails = {
      ...details,
      revisionsUsed: newUsed,
      revisionNotes: notesList,
    };
    user.brandingStatus = 'onboarding';
    await user.save();

    await CustomBrandedRequest.updateMany(
      { partnerId, paymentStatus: 'Paid' },
      {
        $set: {
          'brandingDetails.revisionsUsed': newUsed,
          'brandingDetails.revisionNotes': notesList,
        },
      }
    );

    return res.json({
      success: true,
      message: `Revision request submitted (${newUsed}/2 used). Our designer will review within 1–2 working days.`,
      data: {
        revisionsUsed: newUsed,
        revisionsRemaining: 2 - newUsed,
        status: 'onboarding',
      },
    });
  } catch (err) {
    console.error('[customBrandedReport] requestRevision error:', err);
    return res.status(500).json({ success: false, message: 'Failed to request revision.' });
  }
}

// ---------------------------------------------------------------------------
// Legacy free endpoint — now closed. The one-time fee must be paid via
// /pay/wallet or /order + /verify before a request can become Active.
// ---------------------------------------------------------------------------
async function createRequest(req, res) {
  return res.status(402).json({
    success: false,
    code: 'PAYMENT_REQUIRED',
    message: `A one-time fee of ₹${CBR_PRICE_INR.toLocaleString('en-IN')} is required. Pay with wallet credits or Razorpay.`,
    price: CBR_PRICE_INR,
  });
}

// ---------------------------------------------------------------------------
// GET /api/partner/custom-branded-report
// Returns the partner's request (Paid Active preferred, else resumable
// Pending/Unpaid skeleton) or null. Paid requests render the status view;
// unpaid skeletons let the UI resume payment.
// ---------------------------------------------------------------------------
async function getRequest(req, res) {
  try {
    const partnerId = req.user._id;

    const request = await CustomBrandedRequest.findOne({ partnerId })
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({ success: true, data: request || null });
  } catch (err) {
    console.error('[customBrandedReport] getRequest error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch request status.' });
  }
}

module.exports = {
  createRequest,
  getRequest,
  getBrandingStatus,
  getQuote,
  payWithWallet,
  createOrder,
  verifyPayment,
  submitBrandAssets,
  requestRevision,
};
