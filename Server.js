const dotenv = require("dotenv");
dotenv.config(); // MUST be first — env vars must be available before any other module reads them

const express = require("express");
const cors = require("cors");
dotenv.config();

console.log("=================================");
console.log(
  "[ENV] RSFINTECH_API_KEY:",
  process.env.RSFINTECH_API_KEY ? "FOUND" : "MISSING",
);
console.log(
  "[ENV] RSFINTECH_BASE_URL:",
  process.env.RSFINTECH_BASE_URL || "MISSING",
);
console.log("=================================");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const creditRoutes = require("./routes/credit");

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

// Default Route
app.get("/", (req, res) => {
  res.json({
    message: "VerifyHub Backend Running",
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/credit", creditRoutes);

app.use("/api/ai-analyzer", aiAnalyzerRoutes);

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
