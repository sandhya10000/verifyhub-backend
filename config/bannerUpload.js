'use strict';
// Multer upload for the admin-editable Add Funds banner (Admin → Banners).
// Image-only, stored under uploads/banners/ (served at /uploads/... by
// Server.js). Single banner — each upload gets a unique name; the old file
// is deleted by the banner controller on replace/revert.
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const BANNER_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'banners');
fs.mkdirSync(BANNER_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BANNER_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `add-funds-${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function bannerFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error('Only PNG, JPG or WebP images are supported.'));
  }
  cb(null, true);
}

const bannerUpload = multer({
  storage,
  fileFilter: bannerFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = { bannerUpload, BANNER_UPLOAD_DIR };
