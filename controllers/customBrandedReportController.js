const crypto = require('crypto');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { CBR_PRICE_INR } = require('../models/Pricing');
const { sendMail } = require('../utils/sendMail');

function razorpayClient() {
  // eslint-disable-next-line global-require
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ---------------------------------------------------------------------------
// Helper — send internal notification to team when a new request arrives
// ---------------------------------------------------------------------------
async function notifyTeam(request, partner) {
  const teamEmail = process.env.TEAM_NOTIFICATION_EMAIL || process.env.SMTP_USER;
  if (!teamEmail) return; // silent — no team inbox configured

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
      <h2 style="margin:0 0 8px;color:#0f172a">New Custom Branded Report Request</h2>
      <p style="color:#64748b;margin:0 0 20px">A partner has requested a custom branded report. Please contact them within 1–2 working days.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Request ID</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${request.requestId}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Partner ID</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${partner.partner_id || partner._id}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Partner Name</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${partner.name}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Email</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${request.email}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Phone</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${request.phone}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Amount paid</td><td style="padding:6px 0;font-weight:700;color:#0f172a">₹${Number(request.amount || CBR_PRICE_INR).toLocaleString('en-IN')} (${request.paymentMethod || '—'})</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:14px">Submitted</td><td style="padding:6px 0;font-weight:700;color:#0f172a">${new Date(request.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
      </table>
      <p style="margin-top:20px;color:#94a3b8;font-size:12px">This is an automated notification from the VerifyHub partner portal.</p>
    </div>
  `;

  try {
    await sendMail({
      to: teamEmail,
      subject: `[VerifyHub] New Custom Branded Report Request — ${request.requestId} (${partner.name})`,
      html,
    });
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[customBrandedReport] team notification failed:', err.message);
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
  return CustomBrandedRequest.findOne({
    partnerId,
    $or: [
      { status: 'Active', paymentStatus: 'Paid' },
      { status: { $in: ['Active', 'Pending'] }, paymentStatus: 'Paid' },
    ],
  }).lean();
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

    // Atomic guard — balance can never go negative under concurrency.
    const debit = await User.updateOne(
      { _id: partnerId, walletBalance: { $gte: CBR_PRICE_INR } },
      { $inc: { walletBalance: -CBR_PRICE_INR } },
    );
    if (debit.modifiedCount === 0) {
      const me = await User.findById(partnerId).select('walletBalance').lean();
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
        description: 'Custom Branded Report one-time fee (wallet)',
      }),
      // Remove any stale unpaid skeleton so only the paid request remains.
      CustomBrandedRequest.deleteMany({ partnerId, paymentStatus: 'Unpaid' }),
    ]);

    // Lost a double-submit race (two debits in flight)? Refund this one and
    // return the winner instead of creating a second Active request.
    const raced = await findBlockingRequest(partnerId);
    if (raced) {
      await User.updateOne({ _id: partnerId }, { $inc: { walletBalance: CBR_PRICE_INR } });
      txn.status = 'REFUNDED';
      txn.description = 'Custom Branded Report one-time fee (wallet) — refunded: duplicate request';
      await txn.save();
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'You already have an active custom branded report request. Duplicate charge refunded.',
        data: raced,
      });
    }

    const newRequest = new CustomBrandedRequest({
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

    notifyTeam(newRequest, req.user);
    const me = await User.findById(partnerId).select('walletBalance').lean();
    return res.status(201).json({
      success: true,
      data: newRequest,
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

    notifyTeam(request, req.user);
    return res.status(200).json({ success: true, message: 'Payment verified successfully.', data: request });
  } catch (err) {
    console.error('[customBrandedReport] verifyPayment error:', err);
    return res.status(500).json({ success: false, message: 'Payment verification failed.' });
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
  getQuote,
  payWithWallet,
  createOrder,
  verifyPayment,
};
