import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getSmtpConfigIssue,
  isSmtpAuthFailure,
  sendContactEmail,
} from "../utils/mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimField(value) {
  return typeof value === "string" ? value.trim() : "";
}

const submitContact = asyncHandler(async (req, res) => {
  const fullName = trimField(req.body?.fullName);
  const email = trimField(req.body?.email);
  const phone = trimField(req.body?.phone);
  const message = trimField(req.body?.message);

  if (!fullName) {
    throw new ApiError(400, "Full name is required");
  }
  if (!email) {
    throw new ApiError(400, "Email address is required");
  }
  if (!EMAIL_RE.test(email)) {
    throw new ApiError(400, "Enter a valid email address");
  }
  if (!phone) {
    throw new ApiError(400, "Phone number is required");
  }
  if (phone.replace(/\D/g, "").length < 7) {
    throw new ApiError(400, "Enter a valid phone number");
  }
  if (!message) {
    throw new ApiError(400, "Message is required");
  }
  if (fullName.length > 200 || email.length > 254 || phone.length > 40 || message.length > 5000) {
    throw new ApiError(400, "One or more fields exceed the maximum length");
  }

  const smtpIssue = getSmtpConfigIssue();
  if (smtpIssue) {
    throw new ApiError(503, smtpIssue);
  }

  try {
    await sendContactEmail({ fullName, email, phone, message });
  } catch (err) {
    if (err?.code === "SMTP_NOT_CONFIGURED") {
      throw new ApiError(503, err.message);
    }
    if (err?.code === "INVALID_VISITOR_EMAIL") {
      throw new ApiError(400, "Enter a valid email address");
    }
    console.error(
      "Contact email failed:",
      Number(err?.responseCode) || err?.code || "unknown",
    );
    if (err?.code === "SMTP_REJECTED") {
      throw new ApiError(502, "The mail server did not accept your message. Please try again later.");
    }
    if (isSmtpAuthFailure(err)) {
      throw new ApiError(503, "SMTP authentication failed (535). Check SMTP_USER and SMTP_PASS for the booking@ mailbox.");
    }
    throw new ApiError(500, "Unable to send your message right now. Please try again later.");
  }

  return res.status(200).json(new ApiResponse(200, { success: true, message: "Your message has been sent." }, "Your message has been sent."));
});

export { submitContact };
