import { User } from "../models/user.model.js";
import { getBookingPublicNumber } from "./billInvoicePdf.js";
import { resolveBillEntryTotalAmount } from "./billing.js";
import {
  getSmtpFrom,
  getStaffReplyTo,
  isDeliverableEmailAddress,
  logCustomerEmailFailure,
  sendMail,
} from "./mailer.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidCustomerEmail(value) {
  return isDeliverableEmailAddress(normalizeEmail(value));
}

function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function sanitizeFilename(name) {
  const raw = String(name || "attachment").trim() || "attachment";
  return raw.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
}

function paymentMethodExplanation(entry, remainingDeposit) {
  if (entry?.paidVia === "deposit") {
    const remaining =
      remainingDeposit != null && Number.isFinite(Number(remainingDeposit))
        ? ` Remaining security deposit: ${formatMoney(remainingDeposit)}.`
        : "";
    return `This bill was charged from your $800 security deposit.${remaining}`;
  }
  return "This invoice is unpaid. Please pay by e-transfer.";
}

function chargeDescription(entry) {
  const text = String(entry?.description || "").trim();
  return text || "Please see the attached invoice for details.";
}

export function buildBillingChargeMailOptions({
  booking,
  customer,
  entry,
  pdfBuffer,
  remainingDeposit,
  attachment,
}) {
  const smtpFrom = getSmtpFrom();
  const replyTo = getStaffReplyTo();
  const to = normalizeEmail(customer?.email);
  const bookingRef = getBookingPublicNumber(booking);
  const customerName = customer?.name?.trim() || to || "Customer";
  const title = String(entry?.title || "Additional charge").trim();
  const totalLabel = formatMoney(resolveBillEntryTotalAmount(entry));
  const explanation = paymentMethodExplanation(entry, remainingDeposit);
  const body = chargeDescription(entry);

  const text = [
    `Hello ${customerName},`,
    "",
    `A charge has been added to booking ${bookingRef}.`,
    `Amount (including tax): ${totalLabel}`,
    `Payment: ${explanation}`,
    "",
    body,
    "",
    "The invoice for this charge is attached.",
    "",
    "YYC Car Rental",
    "booking@yyccarrental.com",
  ].join("\n");

  const html = `
    <p>Hello ${escapeHtml(customerName)},</p>
    <p>A charge has been added to booking <strong>${escapeHtml(bookingRef)}</strong>.</p>
    <p>
      <strong>Amount (including tax):</strong> ${escapeHtml(totalLabel)}<br/>
      <strong>Payment:</strong> ${escapeHtml(explanation)}
    </p>
    <p>${escapeHtml(body).replace(/\n/g, "<br/>")}</p>
    <p>The invoice for this charge is attached.</p>
    <p>YYC Car Rental<br/>booking@yyccarrental.com</p>
  `;

  const attachments = [];
  if (attachment?.content) {
    attachments.push({
      filename: sanitizeFilename(attachment.filename || attachment.name || "attachment"),
      content: attachment.content,
      contentType: attachment.contentType || "application/octet-stream",
    });
  }
  if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
    attachments.push({
      filename: `invoice-${entry?.invoiceNumber || bookingRef}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    });
  }

  return {
    from: {
      name: "YYC Car Rental",
      address: smtpFrom,
    },
    to,
    replyTo,
    headers: {
      "Reply-To": replyTo,
    },
    subject: title,
    text,
    html,
    attachments,
  };
}

export async function sendBillingChargeEmail({
  booking,
  entry,
  pdfBuffer,
  remainingDeposit,
  attachment,
}) {
  const bookingId = booking?._id;
  try {
    const customer = await User.findById(booking.userId);

    if (!isValidCustomerEmail(customer?.email)) {
      console.info("Billing charge email skipped: invalid or undeliverable customer email", {
        bookingId: String(bookingId),
        email: customer?.email || null,
      });
      return { skipped: true, reason: "no_email" };
    }

    const mailOptions = buildBillingChargeMailOptions({
      booking,
      customer,
      entry,
      pdfBuffer,
      remainingDeposit,
      attachment,
    });

    const info = await sendMail(mailOptions);
    console.info("Billing charge email sent:", {
      bookingId: String(bookingId),
      to: mailOptions.to,
      from: mailOptions.from?.address,
      replyTo: mailOptions.replyTo,
      messageId: info?.messageId,
      paidVia: entry?.paidVia,
    });
    return { skipped: false, info };
  } catch (err) {
    return logCustomerEmailFailure("Billing charge email", { bookingId: String(bookingId) }, err);
  }
}
