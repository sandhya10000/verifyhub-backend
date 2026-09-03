const dotenv = require("dotenv");
dotenv.config(); // MUST be first — env vars must be available before any other module reads them

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

// Connect Database
connectDB();

const app = express();

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      // Local frontend
      "http://localhost:5173",

      // VerifyHub frontend
      "https://verifyhub.in",
      "https://www.verifyhub.in",
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

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
