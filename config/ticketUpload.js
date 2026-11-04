'use strict';
// Multer upload for support-ticket image attachments.
// Image-only (PNG/JPG/WebP), max 5 MB per file, up to 3 files per request.
// Stored under uploads/tickets/ and served at /uploads/tickets/... by Server.js.
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const TICKET_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'tickets');
fs.mkdirSync(TICKET_UPLOAD_DIR, { recursive: true });

const MAX_FILES = 3;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TICKET_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `ticket-${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function ticketFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error('Only PNG, JPG or WebP images can be attached.'));
  }
  cb(null, true);
}

const ticketUpload = multer({
  storage,
  fileFilter: ticketFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_FILES },
});

// Wraps multer so upload errors come back as a 400 with the reason, not a 500.
function attachImages(req, res, next) {
  ticketUpload.array('attachments', MAX_FILES)(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be 5 MB or smaller'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `You can attach up to ${MAX_FILES} images`
          : err.message || 'Invalid attachment';
      return res.status(400).json({ success: false, message });
    }
    next();
  });
}

// Converts multer's req.files into the subdocument shape stored on the ticket.
function toAttachments(files) {
  return (files || []).map((f) => ({
    url: `/uploads/tickets/${f.filename}`,
    filename: f.originalname,
    mimeType: f.mimetype,
    size: f.size,
  }));
}

module.exports = { attachImages, toAttachments, TICKET_UPLOAD_DIR, MAX_FILES };
