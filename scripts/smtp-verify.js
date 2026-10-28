/**
 * smtp-verify.js
 * Standalone script: verifies SMTP configuration, tests live connection,
 * and sends a single test email to SMTP_USER.
 *
 * Usage: node scripts/smtp-verify.js
 * Never prints credentials or OTPs.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { getSmtpStatus, verifySmtpConnection, getTransporter } = require("../src/utils/emailService");

async function main() {
  console.log("\n=== SMTP Configuration Check ===");

  const status = getSmtpStatus();
  const fields = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"];
  fields.forEach((key) => {
    const val = process.env[key]?.trim();
    console.log(`  ${key}: ${val ? "PRESENT" : "MISSING"}`);
  });

  if (!status.isConfigured) {
    console.error(`\n[FAIL] SMTP is not configured. Missing: ${status.missing.join(", ")}`);
    process.exit(1);
  }

  console.log("\n=== SMTP Connection Verification ===");
  const result = await verifySmtpConnection();

  if (!result.success) {
    console.error(`[FAIL] ${result.message}`);
    console.error(`       Error code: ${result.code}`);
    process.exit(1);
  }

  console.log(`[PASS] ${result.message}`);

  // Send a test email to the configured SMTP_USER address
  const recipient = process.env.SMTP_USER.trim();
  console.log(`\n=== Sending Test Email to ${recipient.replace(/(.{3}).*(@)/, "$1***$2")} ===`);

  try {
    const transporter = getTransporter();
    const from = process.env.EMAIL_FROM?.trim() || recipient;

    const info = await transporter.sendMail({
      from,
      to: recipient,
      subject: "DevOps Platform — SMTP Test Email",
      text: [
        "This is an automated test message from the DevOps Learning Platform.",
        "",
        "If you received this email, your SMTP configuration is working correctly.",
        "",
        "You can now register and receive OTP verification emails.",
        "",
        "— DevOps Learning Platform",
      ].join("\n"),
      html: `
        <div style="font-family:sans-serif;padding:24px;background:#0f172a;color:#f8fafc;border-radius:12px;max-width:480px">
          <h2 style="color:#4F46E5;margin-top:0">✅ SMTP Test Successful</h2>
          <p>This is an automated test message from the <strong>DevOps Learning Platform</strong>.</p>
          <p>If you received this email, your SMTP configuration is working correctly and OTP verification emails will be delivered.</p>
          <p style="color:#0D9488;font-size:13px">— DevOps Learning Platform</p>
        </div>
      `,
    });

    if (info.rejected && info.rejected.length > 0) {
      console.error(`[FAIL] Recipient was rejected by SMTP server: ${info.rejected.join(", ")}`);
      process.exit(1);
    }

    console.log(`[PASS] Test email accepted by SMTP server.`);
    console.log(`       Message ID : ${info.messageId}`);
    console.log(`       Accepted   : ${info.accepted.map(a => a.replace(/(.{3}).*(@)/, "$1***$2")).join(", ")}`);
    console.log(`\n✅ SMTP is fully operational. OTP emails will be delivered.\n`);
  } catch (err) {
    console.error(`[FAIL] Failed to send test email: ${err.message}`);
    console.error(`       Error code: ${err.code || "UNKNOWN"}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
