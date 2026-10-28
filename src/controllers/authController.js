const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const OtpVerification = require("../models/OtpVerification");
const {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  OTP_EXPIRY_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
} = require("../utils/otpUtils");
const { sendOtpEmail } = require("../utils/emailService");

// Helper function to issue platform JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

/**
 * @desc    Register a new user & dispatch email verification OTP
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 1. Validate mandatory fields
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide name, email, and password",
      });
    }

    // 2. Validate password length
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long",
      });
    }

    // 3. Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // 4. Check for existing account
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser && existingUser.isEmailVerified) {
      return res.status(409).json({
        success: false,
        message: "An account with this email address already exists",
      });
    }

    // Step 2: Create or prepare the pending, unverified account safely
    let user;
    if (existingUser && !existingUser.isEmailVerified) {
      existingUser.name = name.trim();
      existingUser.password = password; // Will be re-hashed by pre-save hook
      user = await existingUser.save();
    } else {
      user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password,
        isEmailVerified: false,
        authProvider: "local",
      });
    }

    // Step 3: Generate and persist the hashed OTP
    const otp = generateOtp();
    const otpHash = hashOtp(otp, normalizedEmail);

    // Invalidate previous unconsumed OTPs for this email
    await OtpVerification.updateMany(
      { email: normalizedEmail, isConsumed: false },
      { $set: { isConsumed: true } }
    );

    const otpRecord = await OtpVerification.create({
      email: normalizedEmail,
      otpHash,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
      lastSentAt: new Date(),
      isConsumed: false,
    });

    // Step 4: Attempt to send the OTP email
    try {
      await sendOtpEmail(normalizedEmail, otp);
    } catch (emailErr) {
      console.error("Email delivery failed during registration:", emailErr.message);

      // Invalidate the unsent OTP record so an un-delivered code cannot linger
      await OtpVerification.updateOne(
        { _id: otpRecord._id },
        { $set: { isConsumed: true } }
      );

      const isConfigError = emailErr.code === "SMTP_NOT_CONFIGURED";
      return res.status(isConfigError ? 503 : 500).json({
        success: false,
        code: emailErr.code || "EMAIL_DELIVERY_FAILED",
        message: isConfigError
          ? "Email delivery service is not configured on the server. Please configure SMTP_HOST, SMTP_USER, and SMTP_PASS in server/.env."
          : `Failed to deliver verification email: ${emailErr.message}. Please check your email or try again.`,
        email: normalizedEmail,
        canRetry: true,
      });
    }

    // Step 5: Return success only when the email send operation succeeds
    return res.status(201).json({
      success: true,
      message: "Verification code sent to your email. Please verify your account.",
      email: normalizedEmail,
      requireOtp: true,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(", "),
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "An account with this email address already exists",
      });
    }

    console.error("Registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during registration",
    });
  }
};

/**
 * @desc    Verify email address using 6-digit OTP
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
const verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Please provide both email and 6-digit verification code",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanOtp = otp.toString().trim();

    if (!/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({
        success: false,
        message: "Verification code must be exactly 6 numeric digits",
      });
    }

    // 1. Locate user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No account found for this email address",
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "This account is already verified. Please sign in.",
        isAlreadyVerified: true,
      });
    }

    // 2. Find active, unconsumed OTP record
    const otpRecord = await OtpVerification.findOne({
      email: normalizedEmail,
      isConsumed: false,
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: "No active verification code found. Please request a new code.",
      });
    }

    // 3. Check expiration
    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({
        success: false,
        message: "Verification code has expired. Please request a new code.",
      });
    }

    // 4. Check maximum attempts limit
    if (otpRecord.attempts >= MAX_ATTEMPTS) {
      return res.status(400).json({
        success: false,
        message: "Too many failed attempts. This code is invalidated. Please request a new code.",
      });
    }

    // 5. Constant-time hash verification
    const isValid = verifyOtpHash(cleanOtp, normalizedEmail, otpRecord.otpHash);

    if (!isValid) {
      // Increment attempt counter atomically
      const updatedRecord = await OtpVerification.findByIdAndUpdate(
        otpRecord._id,
        { $inc: { attempts: 1 } },
        { returnDocument: "after" }
      );

      const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - updatedRecord.attempts);

      if (attemptsRemaining === 0) {
        return res.status(400).json({
          success: false,
          message: "Too many failed attempts. This code is invalidated. Please request a new code.",
        });
      }

      return res.status(400).json({
        success: false,
        message: `Invalid verification code. ${attemptsRemaining} attempt(s) remaining.`,
      });
    }

    // 6. Atomically mark OTP as consumed to prevent concurrent race conditions
    const consumed = await OtpVerification.findOneAndUpdate(
      { _id: otpRecord._id, isConsumed: false },
      { $set: { isConsumed: true } },
      { returnDocument: "after" }
    );

    if (!consumed) {
      return res.status(400).json({
        success: false,
        message: "Verification code has already been used.",
      });
    }

    // 7. Mark user account as verified
    user.isEmailVerified = true;
    await user.save();

    // 8. Invalidate any remaining OTP records for this email
    await OtpVerification.updateMany(
      { email: normalizedEmail, isConsumed: false },
      { $set: { isConsumed: true } }
    );

    // 9. Issue signed JWT for immediate session start
    const token = generateToken(user._id);

    return res.status(200).json({
      success: true,
      message: "Email verified successfully",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Email verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during email verification",
    });
  }
};

/**
 * @desc    Resend OTP verification code with rate limiting & cooldown
 * @route   POST /api/auth/resend-otp
 * @access  Public
 */
const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Please provide your email address",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Locate user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      // Safe generic message to reduce account enumeration
      return res.status(200).json({
        success: true,
        message: "If an account exists with this email, a new verification code has been sent.",
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "This account is already verified. Please sign in.",
      });
    }

    // 2. Check 60-second resend cooldown
    const latestOtp = await OtpVerification.findOne({
      email: normalizedEmail,
    }).sort({ createdAt: -1 });

    if (latestOtp && latestOtp.lastSentAt) {
      const elapsedMs = Date.now() - latestOtp.lastSentAt.getTime();
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${remainingSeconds} second(s) before requesting another code.`,
          retryAfter: remainingSeconds,
        });
      }
    }

    // 3. Generate new OTP and hash
    const otp = generateOtp();
    const otpHash = hashOtp(otp, normalizedEmail);

    // 4. Send email
    try {
      await sendOtpEmail(normalizedEmail, otp);
    } catch (emailErr) {
      console.error("Resend OTP email delivery failed:", emailErr.message);
      return res.status(500).json({
        success: false,
        message:
          emailErr.code === "SMTP_NOT_CONFIGURED"
            ? "Email delivery service is not configured on the server."
            : "Failed to send verification email. Please try again later.",
      });
    }

    // 5. Invalidate previous codes
    await OtpVerification.updateMany(
      { email: normalizedEmail, isConsumed: false },
      { $set: { isConsumed: true } }
    );

    // 6. Create new active OTP record
    await OtpVerification.create({
      email: normalizedEmail,
      otpHash,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
      lastSentAt: new Date(),
      isConsumed: false,
    });

    return res.status(200).json({
      success: true,
      message: "A new verification code has been sent to your email.",
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during OTP resend",
    });
  }
};

/**
 * @desc    Authenticate user & get token (requires verified email)
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Validate mandatory fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide both email and password",
      });
    }

    // 2. Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // 3. Find user and explicitly include password
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // 4. Generic 401 error if user not found (prevents account enumeration)
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // 5. Handle account registered via Google OAuth without local password
    if (!user.password && user.googleId) {
      return res.status(400).json({
        success: false,
        message: "This account was created with Google Sign-In. Please sign in with Google.",
      });
    }

    // 6. Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // 7. Check if account is verified
    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        message: "Your email address is not verified. Please verify your email before signing in.",
        isEmailVerified: false,
        email: user.email,
      });
    }

    // 8. Issue signed JWT
    const token = generateToken(user._id);

    // 9. Return safe user data and token
    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during login",
    });
  }
};

/**
 * @desc    Get currently authenticated user's safe profile
 * @route   GET /api/auth/me
 * @access  Private (Requires Bearer token)
 */
const getMe = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error fetching user profile",
    });
  }
};

/**
 * @desc    Authenticate with Google ID token
 * @route   POST /api/auth/google
 * @access  Public
 */
const googleLogin = async (req, res) => {
  try {
    const idToken = req.body.idToken || req.body.credential || req.body.token;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google ID token is required",
      });
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return res.status(500).json({
        success: false,
        message: "Google authentication is not configured on the server",
      });
    }

    // Verify Google ID token using official Google Auth Library
    const client = new OAuth2Client(googleClientId);
    let payload;

    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: googleClientId,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired Google token",
      });
    }

    if (!payload || !payload.email) {
      return res.status(400).json({
        success: false,
        message: "Unable to retrieve user information from Google",
      });
    }

    if (!payload.email_verified) {
      return res.status(401).json({
        success: false,
        message: "Google email address is not verified",
      });
    }

    const normalizedEmail = payload.email.toLowerCase().trim();

    // Find existing user by verified email
    let user = await User.findOne({ email: normalizedEmail });

    if (user) {
      let needsSave = false;
      if (!user.googleId) {
        user.googleId = payload.sub;
        needsSave = true;
      }
      if (!user.avatar && payload.picture) {
        user.avatar = payload.picture;
        needsSave = true;
      }
      // Trusted Google verified identity marks email as verified
      if (!user.isEmailVerified) {
        user.isEmailVerified = true;
        needsSave = true;
      }
      if (needsSave) {
        await user.save();
      }
    } else {
      user = await User.create({
        name: payload.name || normalizedEmail.split("@")[0],
        email: normalizedEmail,
        googleId: payload.sub,
        avatar: payload.picture || "",
        authProvider: "google",
        isEmailVerified: true, // Trusted verified Google email
      });
    }

    // Issue platform JWT
    const token = generateToken(user._id);

    return res.status(200).json({
      success: true,
      message: "Google sign-in successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Google login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during Google authentication",
    });
  }
};

module.exports = {
  register,
  verifyEmail,
  resendOtp,
  login,
  getMe,
  googleLogin,
};
