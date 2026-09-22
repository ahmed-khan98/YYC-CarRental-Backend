import crypto from "node:crypto";
import nodemailer from "nodemailer";

// Google Workspace SMTP (set in server/.env):
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=587
// SMTP_SECURE=false
// SMTP_USER=booking@yyccarrental.com
// SMTP_PASS=Google App Password (not the normal Google login password)
// SMTP_FROM=booking@yyccarrental.com
// CONTACT_TO=booking@yyccarrental.com

const DEFAULT_STAFF_INBOX = "booking@yyccarrental.com";
const DEFAULT_CONTACT_TO = DEFAULT_STAFF_INBOX;
const DEFAULT_SMTP_PORT = 465;
const GOOGLE_SMTP_HOST = "smtp.gmail.com";
const SMTP_PLACEHOLDER_PASSES = new Set([
  "your_email_password",
  "changeme",
  "change-me",
  "your_password",
  "password",
]);

function sanitizeEnvValue(raw) {
  if (raw == null) return "";
  let value = String(raw).replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).replace(/\r/g, "").trim();
  }
  return value;
}

function smtpEnv(name) {
  return sanitizeEnvValue(process.env[name]);
}

export function getContactTo() {
  return smtpEnv("CONTACT_TO") || DEFAULT_CONTACT_TO;
}

export function getSmtpConfigIssue() {
  if (!smtpEnv("SMTP_HOST") || !smtpEnv("SMTP_USER")) {
    return "Contact form email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in server/.env.";
  }
  const pass = smtpEnv("SMTP_PASS");
  if (!pass) {
    return "SMTP_PASS is missing in server/.env.";
  }
  if (SMTP_PLACEHOLDER_PASSES.has(pass.toLowerCase())) {
    return "SMTP password is still the placeholder. Set SMTP_PASS in server/.env.";
  }
  return null;
}

export function isSmtpConfigured() {
  return getSmtpConfigIssue() == null;
}

function getSmtpPort() {
  const port = Number(smtpEnv("SMTP_PORT") || DEFAULT_SMTP_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_SMTP_PORT;
}

function getSmtpSecure(port) {
  // Port 465 is implicit SSL — do not use STARTTLS / requireTLS
  if (port === 465) return true;
  // Port 587 is STARTTLS — secure must be false
  if (port === 587) return false;
  const raw = smtpEnv("SMTP_SECURE").toLowerCase();
  return raw === "true" || raw === "1";
}

function shouldRequireTls(port, secure) {
  if (secure) return false;
  if (port === 587) return true;
  const raw = smtpEnv("SMTP_REQUIRE_TLS").toLowerCase();
  if (raw === "false" || raw === "0") return false;
  return true;
}

function smtpUser() {
  const user = smtpEnv("SMTP_USER");
  return user.includes("@") ? user.toLowerCase() : user;
}

function extractBareAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const angle = raw.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : raw).trim();
  if (!address.includes("@") || /\s/.test(address)) return "";
  return address;
}

function getFromAddress() {
  return (
    extractBareAddress(smtpEnv("SMTP_FROM")) ||
    extractBareAddress(smtpUser()) ||
    DEFAULT_STAFF_INBOX
  );
}

export function getSmtpFrom() {
  return getFromAddress();
}

/** Staff inbox for customer replies on booking / check-in mail. Not the visitor. */
export function getStaffReplyTo() {
  return extractBareAddress(smtpEnv("SMTP_FROM")) || DEFAULT_STAFF_INBOX;
}

/**
 * Shared Nodemailer send for booking / check-in / check-out / bill emails.
 * Do not change this path for contact-form delivery.
 */
export async function sendMail(mailOptions) {
  const configIssue = getSmtpConfigIssue();
  if (configIssue) {
    const error = new Error(configIssue);
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }

  const recipients = listAddresses(mailOptions?.to);
  if (!recipients.length || recipients.some((address) => !isValidEmailAddress(address))) {
    const error = new Error("Invalid recipient email address");
    error.code = "INVALID_RECIPIENT";
    throw error;
  }
  if (recipients.some((address) => !isDeliverableEmailAddress(address))) {
    const error = new Error(`Can't send mail — recipient domain is not deliverable: ${recipients.join(", ")}`);
    error.code = "EMAIL_UNDELIVERABLE";
    throw error;
  }

  try {
    const transporter = getTransporter();
    return await transporter.sendMail(mailOptions);
  } catch (err) {
    if (isUndeliverableEmailError(err)) {
      const error = new Error(err?.message || "Recipient email was rejected");
      error.code = "EMAIL_UNDELIVERABLE";
      throw error;
    }
    throw err;
  }
}

export function isSmtpUnreachableError(err) {
  const code = String(err?.code || "");
  return (
    code === "ESOCKET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNECTION" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND"
  );
}

function isSocketError(err) {
  return isSmtpUnreachableError(err);
}

function getContactBcc() {
  return smtpEnv("CONTACT_BCC");
}

const VISITOR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_DELIVERABLE_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
  "invalid",
  "test",
]);

let sharedTransporter;

export function isValidEmailAddress(value) {
  const email = String(value || "").trim();
  return email.length > 0 && email.length <= 254 && VISITOR_EMAIL_RE.test(email);
}

export function isDeliverableEmailAddress(value) {
  if (!isValidEmailAddress(value)) return false;
  const domain = String(value).trim().split("@")[1]?.toLowerCase() || "";
  if (!domain || NON_DELIVERABLE_DOMAINS.has(domain)) return false;
  return !/\.(example|test|invalid|localhost)$/i.test(domain);
}

export function isUndeliverableEmailError(err) {
  const code = String(err?.code || "");
  const responseCode = Number(err?.responseCode);
  const text = String(err?.message || err?.response || "");
  return (
    code === "EENVELOPE" ||
    code === "EMESSAGE" ||
    code === "EMAIL_UNDELIVERABLE" ||
    code === "INVALID_RECIPIENT" ||
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 552 ||
    responseCode === 553 ||
    /recipients were rejected/i.test(text) ||
    /mailbox unavailable/i.test(text) ||
    /user unknown/i.test(text) ||
    /account or domain may not exist/i.test(text)
  );
}

function normalizeVisitorEmail(value) {
  return String(value || "").trim();
}

function isValidVisitorEmail(value) {
  return isValidEmailAddress(normalizeVisitorEmail(value));
}

export function logCustomerEmailFailure(label, extra, err) {
  const payload = {
    ...extra,
    code: err?.code || Number(err?.responseCode) || "unknown",
    message: err?.message,
  };
  if (isUndeliverableEmailError(err)) {
    console.warn(`${label} skipped: invalid or rejected recipient`, payload);
    return { skipped: true, reason: "undeliverable" };
  }
  console.error(`${label} failed:`, payload);
  return { skipped: true, reason: "send_failed" };
}

function getMailDomain() {
  const source = getFromAddress() || getContactTo() || smtpUser();
  const at = source.lastIndexOf("@");
  return at > 0 ? source.slice(at + 1).toLowerCase() : "yyccarrental.com";
}

function listAddresses(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      const raw = typeof item === "string" ? item : item?.address || "";
      const angle = String(raw).match(/<([^>]+)>/);
      return (angle ? angle[1] : raw).trim().toLowerCase();
    })
    .filter(Boolean);
}

function resetTransporter() {
  if (!sharedTransporter) return;
  try {
    sharedTransporter.close();
  } catch {
    // ignore close errors on a broken socket
  }
  sharedTransporter = null;
}

function getTransporter() {
  if (sharedTransporter) return sharedTransporter;

  const port = getSmtpPort();
  const secure = getSmtpSecure(port);
  const options = {
    host: smtpEnv("SMTP_HOST"),
    port,
    secure,
    auth: {
      user: smtpUser(),
      pass: smtpEnv("SMTP_PASS"),
    },
    authMethod: "LOGIN",
  };

  if (shouldRequireTls(port, secure)) {
    options.requireTLS = true;
  }

  sharedTransporter = nodemailer.createTransport(options);
  sharedTransporter.on("error", (err) => {
    console.error("SMTP connection error:", err?.code || err?.message || err);
    resetTransporter();
  });
  return sharedTransporter;
}

async function sendContactToAdmin(mailOptions) {
  const user = (smtpEnv("CONTACT_SMTP_USER") || smtpUser()).toLowerCase();
  const pass = (smtpEnv("CONTACT_SMTP_PASS") || smtpEnv("SMTP_PASS")).replace(/\s+/g, "");
  const attempts = [
    { host: GOOGLE_SMTP_HOST, port: 587, secure: false },
    { host: GOOGLE_SMTP_HOST, port: 465, secure: true },
  ];
  let lastErr;
  for (const attempt of attempts) {
    const transporter = nodemailer.createTransport({
      host: attempt.host,
      port: attempt.port,
      secure: attempt.secure,
      auth: { user, pass },
      requireTLS: !attempt.secure,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    try {
      const info = await transporter.sendMail(mailOptions);
      console.info("Contact email sent via Google Workspace", {
        host: attempt.host,
        port: attempt.port,
        to: mailOptions.to,
      });
      return info;
    } catch (err) {
      lastErr = err;
      console.warn("Contact Google SMTP failed", {
        host: attempt.host,
        port: attempt.port,
        code: err?.code || err?.responseCode || "unknown",
      });
    } finally {
      try {
        transporter.close();
      } catch {
        // ignore
      }
    }
  }
  throw lastErr;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isSmtpAuthFailure(err) {
  const responseCode = Number(err?.responseCode);
  const text = String(err?.message || err?.response || "");
  return (
    responseCode === 535 ||
    /\b535\b/.test(text) ||
    /incorrect authentication data/i.test(text) ||
    /invalid login/i.test(text) ||
    /authentication failed/i.test(text)
  );
}

export async function sendContactEmail({ fullName, email, phone, message }) {
  const configIssue = getSmtpConfigIssue();
  if (configIssue) {
    const error = new Error(configIssue);
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }

  const visitorEmail = normalizeVisitorEmail(email);
  if (!isValidVisitorEmail(visitorEmail)) {
    const error = new Error("A valid visitor email is required for Reply-To.");
    error.code = "INVALID_VISITOR_EMAIL";
    throw error;
  }

  const to = DEFAULT_CONTACT_TO;
  const smtpAuthUser = smtpUser();
  const fromAddress = getFromAddress();
  const bcc = getContactBcc();
  const subject = `Contact form: ${fullName}`;
  const messageId = `<contact.${Date.now()}.${crypto.randomBytes(8).toString("hex")}@${getMailDomain()}>`;
  const text = [
    "New message from the YYC Car Rental website contact form.",
    "",
    `Full Name: ${fullName}`,
    `Email: ${visitorEmail}`,
    `Phone Number: ${phone}`,
    "",
    "Message:",
    message,
  ].join("\n");

  const html = `
    <p>New message from the YYC Car Rental website contact form.</p>
    <p><strong>Full Name:</strong> ${escapeHtml(fullName)}<br/>
    <strong>Email:</strong> ${escapeHtml(visitorEmail)}<br/>
    <strong>Phone Number:</strong> ${escapeHtml(phone)}</p>
    <p><strong>Message:</strong></p>
    <p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
  `;

  const info = await sendContactToAdmin({
    from: {
      name: "YYC Contact Form",
      address: fromAddress,
    },
    to,
    ...(bcc ? { bcc } : {}),
    replyTo: visitorEmail,
    subject,
    text,
    html,
    messageId,
    date: new Date(),
    envelope: {
      from: smtpAuthUser,
      to: [to, ...(bcc ? [bcc] : [])],
    },
    headers: {
      "X-YYC-Contact-Form": "website",
    },
  });

  const accepted = listAddresses(info.accepted);
  const rejected = listAddresses(info.rejected);
  const pending = listAddresses(info.pending);

  console.info("Contact email sent:", {
    to,
    from: fromAddress,
    messageId: info.messageId || messageId,
    accepted,
    rejected,
    pending,
    response: info.response,
  });

  const toNorm = to.toLowerCase();
  if (rejected.includes(toNorm)) {
    const error = new Error("SMTP did not accept the booking inbox as a recipient.");
    error.code = "SMTP_REJECTED";
    throw error;
  }

  return info;
}
