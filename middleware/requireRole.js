// Generic role gate. Usage: requireRole('admin', 'brand_designer')
// Must run after the `auth` middleware (which populates req.user).
const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Access denied. Insufficient role.',
  });
};

module.exports = requireRole;
