
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "DevOps Learning Platform API is running",
  });
});

async function startServer() {
  await connectDB();

  // Ensure legacy accounts created before OTP was introduced are preserved as verified
  try {
    const User = require("./models/User");
    await User.updateMany(
      { isEmailVerified: { $exists: false } },
      { $set: { isEmailVerified: true } }
    );
  } catch (migErr) {
    console.error("Migration error preserving legacy users:", migErr);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
