const express = require("express");
const dotenv = require("dotenv");
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

// Connect Database
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Default Route
app.get("/", (req, res) => {
  res.json({
    message: "VerifyHub Backend Running",
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/auth/credit", creditRoutes);

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
