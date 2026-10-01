const jwt = require("jsonwebtoken");
const User = require("../models/User");

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");

    // Token is valid but the account no longer exists (deleted user, wrong
    // database, or stale token). Fail fast with 401 instead of letting
    // every controller crash on `req.user._id`.
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Account no longer exists. Please log in again.",
      });
    }

    // Deactivated partners are blocked immediately on every request —
    // existing tokens stop working as soon as the admin suspends them.
    if (req.user.isActive === false) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_DEACTIVATED",
        message: "Your account has been deactivated. Please contact support.",
      });
    }

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid Token",
    });
  }
};

module.exports = auth;
