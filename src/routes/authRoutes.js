const express = require("express");
const router = express.Router();
const {
  register,
  verifyEmail,
  resendOtp,
  login,
  getMe,
  googleLogin,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");
const { createRateLimiter } = require("../middleware/rateLimiter");

// Rate limiters for endpoints
const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many registration attempts. Please try again in 15 minutes.",
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: "Too many login attempts. Please try again in 15 minutes.",
});

const verifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many verification attempts. Please try again in 15 minutes.",
});

const resendLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: "Too many OTP resend attempts. Please try again in 15 minutes.",
});

// Public routes
router.post("/register", registerLimiter, register);
router.post("/verify-email", verifyLimiter, verifyEmail);
router.post("/resend-otp", resendLimiter, resendOtp);
router.post("/login", loginLimiter, login);
router.post("/google", googleLogin);

// Protected routes
router.get("/me", protect, getMe);

module.exports = router;
