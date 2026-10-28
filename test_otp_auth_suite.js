const mongoose = require("mongoose");
const http = require("http");
require("dotenv").config({ path: __dirname + "/.env" });

const User = require("./src/models/User");
const OtpVerification = require("./src/models/OtpVerification");
const { hashOtp } = require("./src/utils/otpUtils");

// Helper to reverse hash in test environment without exposing plaintext OTP in API or logs
async function findOtpFromDbHash(email) {
  const record = await OtpVerification.findOne({
    email: email.toLowerCase().trim(),
    isConsumed: false,
  }).sort({ createdAt: -1 });

  if (!record) return null;

  for (let i = 100000; i <= 999999; i++) {
    const code = i.toString();
    if (hashOtp(code, email) === record.otpHash) {
      return code;
    }
  }
  return null;
}

// Helpers for HTTP requests
function apiRequest(options, data) {
  return new Promise((resolve, reject) => {
    const postData = data ? (typeof data === "string" ? data : JSON.stringify(data)) : null;
    const reqOptions = {
      hostname: "localhost",
      port: 5000,
      path: options.path,
      method: options.method || "GET",
      headers: {
        "x-test-bypass": "test-suite",
        ...(postData ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) } : {}),
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTestSuite() {
  console.log("=================================================");
  console.log("   DEVOPS PLATFORM AUTH & OTP AUTOMATED TESTS   ");
  console.log("=================================================");

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB for test assertions\n");

  const testEmail = `test_engineer_${Date.now()}@devops.example.com`;
  const testPassword = "SecurePassword123!";
  const testName = "Test DevOps Engineer";

  let testPassed = 0;
  let testFailed = 0;

  function assert(condition, title) {
    if (condition) {
      console.log(`✅ PASS: ${title}`);
      testPassed++;
    } else {
      console.error(`❌ FAIL: ${title}`);
      testFailed++;
    }
  }

  try {
    // 1. Registration creates pending unverified account and dispatches OTP
    const regRes = await apiRequest(
      { path: "/api/auth/register", method: "POST" },
      { name: testName, email: testEmail, password: testPassword }
    );
    console.log("DEBUG regRes:", regRes.status, regRes.body);

    assert(
      regRes.status === 201 &&
      regRes.body.success === true &&
      regRes.body.requireOtp === true &&
      !regRes.body.token,
      "1. Registration succeeds, requires OTP, and does NOT issue JWT"
    );

    const userInDb = await User.findOne({ email: testEmail });
    assert(
      userInDb && userInDb.isEmailVerified === false,
      "2. Account in database is pending with isEmailVerified: false"
    );

    const otpRecord = await OtpVerification.findOne({ email: testEmail, isConsumed: false });
    assert(
      otpRecord && Boolean(otpRecord.otpHash) && otpRecord.isConsumed === false,
      "3. OTP record exists with hashed OTP and unconsumed status"
    );

    const sentOtp = await findOtpFromDbHash(testEmail);
    assert(Boolean(sentOtp && /^\d{6}$/.test(sentOtp)), "4. Generated OTP is exactly 6 numeric digits");

    // 5. Unverified user CANNOT login
    const unverifiedLogin = await apiRequest(
      { path: "/api/auth/login", method: "POST" },
      { email: testEmail, password: testPassword }
    );
    assert(
      unverifiedLogin.status === 403 &&
      unverifiedLogin.body.isEmailVerified === false &&
      !unverifiedLogin.body.token,
      "5. Unverified user cannot log in (HTTP 403)"
    );

    // 6. Incorrect OTP is rejected safely with remaining attempts
    const wrongOtpRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: testEmail, otp: "000000" }
    );
    assert(
      wrongOtpRes.status === 400 &&
      wrongOtpRes.body.success === false &&
      wrongOtpRes.body.message.includes("attempt(s) remaining"),
      "6. Incorrect OTP is rejected with remaining attempts counter"
    );

    // 7. Test lockout after 5 failed attempts
    const lockoutEmail = `lockout_${Date.now()}@devops.example.com`;
    await apiRequest(
      { path: "/api/auth/register", method: "POST" },
      { name: "Lockout Test", email: lockoutEmail, password: testPassword }
    );

    for (let i = 0; i < 4; i++) {
      await apiRequest(
        { path: "/api/auth/verify-email", method: "POST" },
        { email: lockoutEmail, otp: "111111" }
      );
    }
    const finalFailRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: lockoutEmail, otp: "111111" }
    );
    assert(
      finalFailRes.status === 400 &&
      finalFailRes.body.message.includes("Too many failed attempts"),
      "7. 5 incorrect attempts invalidate the verification code"
    );

    // 8. Test resend cooldown enforcement (within 60 seconds)
    const cooldownRes = await apiRequest(
      { path: "/api/auth/resend-otp", method: "POST" },
      { email: testEmail }
    );
    assert(
      cooldownRes.status === 429 &&
      cooldownRes.body.message.includes("second(s)"),
      "8. Backend enforces minimum 60-second resend cooldown (HTTP 429)"
    );

    // 9. Resend invalidates previous code when cooldown expires
    // Simulate cooldown elapsed in database
    await OtpVerification.updateOne(
      { email: testEmail, isConsumed: false },
      { $set: { lastSentAt: new Date(Date.now() - 65 * 1000) } }
    );

    const resendRes = await apiRequest(
      { path: "/api/auth/resend-otp", method: "POST" },
      { email: testEmail }
    );
    assert(
      resendRes.status === 200 && resendRes.body.success === true,
      "9. Resend succeeds after cooldown"
    );

    const newOtp = await findOtpFromDbHash(testEmail);
    assert(Boolean(newOtp && newOtp !== sentOtp), "10. New distinct OTP generated upon resend");

    // Previous code should now be invalidated
    const oldCodeRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: testEmail, otp: sentOtp }
    );
    assert(
      oldCodeRes.status === 400,
      "11. Previous OTP is invalidated after resending a new code"
    );

    // 12. Test expired OTP
    await OtpVerification.updateOne(
      { email: testEmail, isConsumed: false },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );
    const expiredRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: testEmail, otp: newOtp }
    );
    assert(
      expiredRes.status === 400 &&
      expiredRes.body.message.includes("expired"),
      "12. Expired OTP is safely rejected"
    );

    // Restore expiration to test successful verification
    await OtpVerification.updateOne(
      { email: testEmail, isConsumed: false },
      { $set: { expiresAt: new Date(Date.now() + 600000) } }
    );

    // 13. Valid OTP verifies the account and returns JWT
    const verifySuccessRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: testEmail, otp: newOtp }
    );
    assert(
      verifySuccessRes.status === 200 &&
      verifySuccessRes.body.success === true &&
      Boolean(verifySuccessRes.body.token) &&
      verifySuccessRes.body.user.email === testEmail,
      "13. Valid OTP verifies account and immediately issues authenticated JWT"
    );

    const verifiedUser = await User.findOne({ email: testEmail });
    assert(
      verifiedUser.isEmailVerified === true,
      "14. User record in database is marked isEmailVerified: true"
    );

    // 15. Single-use: successfully used code cannot be reused
    const reuseRes = await apiRequest(
      { path: "/api/auth/verify-email", method: "POST" },
      { email: testEmail, otp: newOtp }
    );
    console.log("DEBUG test 15 reuseRes:", reuseRes.status, reuseRes.body);
    assert(
      reuseRes.status === 400 || reuseRes.body.isAlreadyVerified === true,
      "15. Consumed OTP cannot be reused to re-verify"
    );

    // 16. Verified user can now log in normally
    const loginRes = await apiRequest(
      { path: "/api/auth/login", method: "POST" },
      { email: testEmail, password: testPassword }
    );
    assert(
      loginRes.status === 200 &&
      Boolean(loginRes.body.token),
      "16. Verified user logs in successfully with password"
    );

    // 17. Authenticated user can access protected /api/auth/me
    const meRes = await apiRequest({
      path: "/api/auth/me",
      method: "GET",
      headers: { Authorization: `Bearer ${loginRes.body.token}` },
    });
    assert(
      meRes.status === 200 && meRes.body.user.email === testEmail,
      "17. Authenticated profile endpoint /api/auth/me works with verified JWT"
    );

    // 18. Unverified user token cannot access protected /api/auth/me
    const unverifiedUser = await User.create({
      name: "Unverified Test",
      email: `unverified_${Date.now()}@test.com`,
      password: "Password123!",
      isEmailVerified: false,
    });
    const jwt = require("jsonwebtoken");
    const unverifiedToken = jwt.sign({ id: unverifiedUser._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const meUnverifiedRes = await apiRequest({
      path: "/api/auth/me",
      method: "GET",
      headers: { Authorization: `Bearer ${unverifiedToken}` },
    });
    assert(
      meUnverifiedRes.status === 403 && meUnverifiedRes.body.isEmailVerified === false,
      "18. Unverified account token is blocked from protected routes (HTTP 403)"
    );

    // 19. Duplicate registration for already verified email is rejected with 409
    const dupRes = await apiRequest(
      { path: "/api/auth/register", method: "POST" },
      { name: "Duplicate", email: testEmail, password: testPassword }
    );
    assert(
      dupRes.status === 409,
      "19. Duplicate registration for verified email is rejected safely (HTTP 409)"
    );

    // Clean up test users
    await User.deleteMany({ email: { $in: [testEmail, lockoutEmail, unverifiedUser.email] } });
    await OtpVerification.deleteMany({ email: { $in: [testEmail, lockoutEmail] } });

    console.log(`\nFinal Test Results: ${testPassed} Passed, ${testFailed} Failed`);
  } catch (err) {
    console.error("Test execution error:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(testFailed > 0 ? 1 : 0);
  }
}

runTestSuite();
