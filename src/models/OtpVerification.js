const mongoose = require("mongoose");

const otpVerificationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // Automatic TTL deletion when expiresAt is reached
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    lastSentAt: {
      type: Date,
      default: Date.now,
    },
    isConsumed: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to quickly find active, unconsumed OTPs for an email
otpVerificationSchema.index({ email: 1, isConsumed: 1 });

const OtpVerification = mongoose.model(
  "OtpVerification",
  otpVerificationSchema
);

module.exports = OtpVerification;
