// Blocks report pulls while the partner still owes a plan selection
// (pendingPlanChoice set by wallet top-ups, cleared by /plan/activate).
// Must run AFTER auth so req.user is populated. Admins are exempt.
const requirePlanChosen = (req, res, next) => {
  try {
    if (req.user?.role === "admin") return next();
    if (req.user?.pendingPlanChoice === true) {
      return res.status(403).json({
        success: false,
        code: "PLAN_REQUIRED",
        message: "Please select a plan on Recharge Plans before pulling reports.",
      });
    }
    next();
  } catch (err) {
    console.error("requirePlanChosen Error:", err);
    next();
  }
};

module.exports = requirePlanChosen;
