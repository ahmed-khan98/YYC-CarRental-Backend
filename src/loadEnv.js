import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "../.env") });

// Contact form mailer (POST /api/contact) — SMTP via nodemailer:
// SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
// CONTACT_TO=booking@yyccarrental.com (default inbox)
// SMTP_PASS must be the real cPanel mailbox password — not your_email_password.
// Default 465/SSL. If AUTH 535 persists, try SMTP_PORT=587 and SMTP_SECURE=false.

const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "CONTACT_TO",
  "CONTACT_BCC",
  "SMTP_REQUIRE_TLS",
];

function sanitizeSmtpEnvValue(raw) {
  let value = String(raw).replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).replace(/\r/g, "").trim();
  }
  return value;
}

for (const key of SMTP_ENV_KEYS) {
  if (process.env[key] == null) continue;
  process.env[key] = sanitizeSmtpEnvValue(process.env[key]);
}

// Stable dev defaults so tokens stay valid across server restarts when .env is missing values.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "yyc-dev-jwt-secret";
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = "yyc-dev-refresh-secret";
}
