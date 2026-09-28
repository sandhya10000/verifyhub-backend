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
console.log("=================================");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const creditRoutes = require("./routes/credit");
const paymentRoutes = require("./routes/payment");

const aiAnalyzerRoutes = require("./routes/aiAnalyzerRoutes");
const adminRoutes = require("./routes/adminRoutes");
const ticketRoutes = require("./routes/ticketRoutes");

// Connect Database
connectDB();

// Seed default pricing (insert-only — never overwrites admin edits)
const Pricing = require("./models/Pricing");
Pricing.updateOne(
  { key: "default" },
  {
    $setOnInsert: {
      ai: { base: 100, gstRate: 18 },
      cibil: { base: 50, gstRate: 18 },
      crif: { base: 50, gstRate: 18 },
      experian: { base: 50, gstRate: 18 },
      equifax: { base: 50, gstRate: 18 },
      minRecharge: 100,
      lowBalanceThreshold: 500,
    },
  },
  { upsert: true },
)
  .then(() => console.log("[Pricing] default config ensured"))
  .catch((err) => console.error("[Pricing] seed failed:", err.message));

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

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
