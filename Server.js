const dotenv = require("dotenv");
dotenv.config(); // MUST be first — env vars must be available before any other module reads them

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const path = require("path");
dotenv.config();

console.log(
  "[DIGI] Token Status:",
  process.env.DIGI_API_TOKEN ? "FOUND" : "MISSING",
);
// Presence only (never values): CIBIL/Digi signing needs all three.
// A missing/empty var here fails fast instead of surfacing as a
// provider "Authentication failed" at request time.
console.log(
  "[DIGI] CIBIL config:",
  `baseUrl=${process.env.DIGI_BASE_URL ? "SET" : "MISSING"}`,
  `partnerId=${process.env.DIGI_PARTNER_ID ? `SET(${(process.env.DIGI_PARTNER_ID || "").trim().length} chars)` : "MISSING"}`,
  `secretKey=${process.env.DIGI_SECRET_KEY ? `SET(${(process.env.DIGI_SECRET_KEY || "").trim().length} chars)` : "MISSING"}`,
);
console.log("=================================");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const creditRoutes = require("./routes/credit");
const paymentRoutes = require("./routes/payment");

const aiAnalyzerRoutes = require("./routes/aiAnalyzerRoutes");
const adminRoutes = require("./routes/adminRoutes");
const ticketRoutes = require("./routes/ticketRoutes");
const partnerRoutes = require("./routes/partnerRoutes");
const rcRoutes = require("./routes/rc");
const gstRoutes = require("./routes/gst");

// Connect Database
connectDB();

// Seed default pricing (insert-only — never overwrites admin edits)
// + one-way migration: older docs (e.g. the v1 flat-price shape without
// `plans`) get the missing sections backfilled, existing values untouched.
const Pricing = require("./models/Pricing");
const PRICING_DEFAULTS = {
  plans: {
    startup: { recharge: 200, cibil: 120, experian: 95, crif: 95, equifax: 85, cibilFailed: 90 },
    starter: { recharge: 1000, cibil: 110, experian: 85, crif: 85, equifax: 80, cibilFailed: 80 },
    growth: { recharge: 5000, cibil: 90, experian: 65, crif: 65, equifax: 60, cibilFailed: 70 },
    pro: { recharge: 10000, cibil: 80, experian: 50, crif: 55, equifax: 50, cibilFailed: 60 },
    enterprise: { recharge: 25000, cibil: 65, experian: 35, crif: 45, equifax: 40, cibilFailed: 50 },
  },
  ai: { base: 100, gstRate: 18 },
  otherFailedCharge: { base: 30, gstRate: 0 },
  minRecharge: 200,
  lowBalanceThreshold: 500,
  lowBalanceAlertIntervalDays: 7,
};
Pricing.updateOne({ key: "default" }, { $setOnInsert: PRICING_DEFAULTS }, { upsert: true })
  .then(async () => {
    // Backfill sections AND individual plan rows missing from pre-existing docs
    const doc = await Pricing.findOne({ key: "default" }).lean();
    if (doc) {
      const missing = {};
      for (const [k, v] of Object.entries(PRICING_DEFAULTS)) {
        if (k === "plans") {
          for (const [tier, row] of Object.entries(v)) {
            if (!doc.plans || doc.plans[tier] === undefined || doc.plans[tier] === null) {
              missing[`plans.${tier}`] = row;
            }
          }
        } else if (doc[k] === undefined || doc[k] === null) {
          missing[k] = v;
        }
      }
      // v1 docs stored flat per-product prices (ai/cibil/...) with no plans —
      // keep them untouched; just ensure the v2 sections exist.
      if (Object.keys(missing).length > 0) {
        await Pricing.updateOne({ key: "default" }, { $set: missing });
        console.log("[Pricing] migrated missing sections:", Object.keys(missing).join(", "));
      }
    }
    console.log("[Pricing] default config ensured");
  })
  .catch((err) => console.error("[Pricing] seed failed:", err.message));

// One-time index repair: older builds created reportId_1 WITHOUT sparse,
// so every null-reportId row collides. Mongoose won't alter an existing
// index in place, so drop it explicitly and recreate sparse+unique.
// Recharge rows (reportId null) are then skipped by the index entirely.
const Transaction = require("./models/Transaction");
Transaction.collection
  .dropIndex("reportId_1")
  .catch(() => {})
  .then(() => Transaction.collection.createIndex({ reportId: 1 }, { unique: true, sparse: true }))
  .then(() => console.log("[DB] reportId_1 sparse unique index ensured"))
  .catch((err) => console.error("[DB] reportId index ensure failed:", err.message));

const app = express();

// Middleware
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      // Local frontend
      "http://localhost:5173",

      // VerifyHub frontend
      "https://verifyhub.in",
      "https://www.verifyhub.in",
"https://staging.verifyhub.in"
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },

  credentials: true,

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],

  exposedHeaders: ["Content-Range", "X-Content-Range"],
};

app.use(cors(corsOptions));
app.use(express.json());

// =========================
// SERVE UPLOADED FILES
// =========================

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// AI bureau uploads live under ./uploads/ai-analysis, inside the served
// uploads tree. The /ai-uploads alias below points at the same dir as a
// fallback. The /uploads line above is untouched.
const { UPLOAD_DIR: AI_UPLOAD_DIR } = require("./config/uploadConfig");
app.use("/ai-uploads", express.static(AI_UPLOAD_DIR));
console.log("[AI] upload dir:", AI_UPLOAD_DIR, "(served at /uploads/ai-analysis)");
// Default Route
app.get("/", (req, res) => {
  res.json({
    message: "VerifyHub Backend Running",
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/credit", creditRoutes);
app.use("/api", paymentRoutes);
app.use("/api/ai-analyzer", aiAnalyzerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/partner", partnerRoutes);
app.use("/api/rc", rcRoutes);
app.use("/api/gst", gstRoutes);

// Low-balance mail sweep (cron-only): daily + once shortly after boot.
// Per-user dedup (max once per lowBalanceAlertIntervalDays) lives in the service.
const { runLowBalanceAlerts } = require("./services/lowBalanceAlert.service");
const LOW_BALANCE_SWEEP_MS = Number(process.env.LOW_BALANCE_SWEEP_MS) || 24 * 60 * 60 * 1000;
setTimeout(() => runLowBalanceAlerts().catch((e) => console.error("[low-balance] startup run failed:", e.message)), 30 * 1000);
setInterval(() => runLowBalanceAlerts().catch((e) => console.error("[low-balance] sweep failed:", e.message)), LOW_BALANCE_SWEEP_MS);

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
