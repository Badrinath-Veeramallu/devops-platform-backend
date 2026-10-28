const crypto = require("crypto");

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 5;

/**
 * Generate a cryptographically secure 6-digit numeric OTP
 */
function generateOtp() {
  // crypto.randomInt is cryptographically secure (CSPRNG)
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Compute a secure SHA-256 hash of an OTP with salt
 */
function hashOtp(otp, email) {
  const salt = process.env.OTP_SALT || process.env.JWT_SECRET || "devops_platform_secure_otp_salt";
  return crypto
    .createHash("sha256")
    .update(`${email.toLowerCase().trim()}:${otp}:${salt}`)
    .digest("hex");
}

/**
 * Constant-time comparison between candidate OTP and stored hash
 */
function verifyOtpHash(candidateOtp, email, storedHash) {
  if (!candidateOtp || typeof candidateOtp !== "string" || !storedHash) {
    return false;
  }
  if (!/^\d{6}$/.test(candidateOtp.trim())) {
    return false;
  }

  const candidateHash = hashOtp(candidateOtp.trim(), email);
  const candidateBuf = Buffer.from(candidateHash, "hex");
  const storedBuf = Buffer.from(storedHash, "hex");

  if (candidateBuf.length !== storedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuf, storedBuf);
}

module.exports = {
  OTP_EXPIRY_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
  generateOtp,
  hashOtp,
  verifyOtpHash,
};
