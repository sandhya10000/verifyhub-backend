const dotenv = require("dotenv");
dotenv.config(); // MUST be first — env vars must be available before any other module reads them

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const aiAnalyzerRoutes = require("./routes/aiAnalyzerRoutes");

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
app.use("/api/ai-analyzer", aiAnalyzerRoutes);

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
