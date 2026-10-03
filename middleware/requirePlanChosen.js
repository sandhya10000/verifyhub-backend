// DISABLED in single-plan mode: single plan auto-applies to everyone, so no
// plan selection is ever required. Kept (not deleted) for multi-plan restore.
// TODO(multi-plan-restore): re-attach to report routes in routes/credit.js + aiAnalyzerRoutes.js.
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
