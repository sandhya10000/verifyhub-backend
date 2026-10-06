const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const User = require('../models/User');
const { sendMail } = require('../utils/sendMail');

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
// POST /api/partner/custom-branded-report
// Body: { email, phone }
// ---------------------------------------------------------------------------
exports.createRequest = async (req, res) => {
  try {
    const partnerId = req.user._id;

    // Prevent duplicate active requests
    const existing = await CustomBrandedRequest.findOne({
      partnerId,
      status: { $in: ['Active', 'Pending'] },
    }).lean();

    if (existing) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'You already have an active custom branded report request.',
        data: existing,
      });
    }

    const { email, phone } = req.body;

    // Basic server-side validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    // Accept optional +91 prefix; digits must be 10
    const digitsOnly = String(phone || '').replace(/^\+91/, '').replace(/\D/g, '');
    if (!digitsOnly || digitsOnly.length !== 10) {
      return res.status(400).json({ success: false, message: 'A valid 10-digit Indian mobile number is required.' });
    }

    const newRequest = new CustomBrandedRequest({
      partnerId,
      email: email.trim().toLowerCase(),
      phone: digitsOnly,
      status: 'Active',
    });

    await newRequest.save();

    // Fire-and-forget team notification
    const partner = req.user; // already populated by auth middleware
    notifyTeam(newRequest, partner);

    return res.status(201).json({ success: true, data: newRequest });
  } catch (err) {
    console.error('[customBrandedReport] createRequest error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit request. Please try again.' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/partner/custom-branded-report
// Returns the most recent active/pending request for this partner, or null.
// ---------------------------------------------------------------------------
exports.getRequest = async (req, res) => {
  try {
    const partnerId = req.user._id;

    const request = await CustomBrandedRequest.findOne({
      partnerId,
      status: { $in: ['Active', 'Pending'] },
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: request || null });
  } catch (err) {
    console.error('[customBrandedReport] getRequest error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch request status.' });
  }
};
