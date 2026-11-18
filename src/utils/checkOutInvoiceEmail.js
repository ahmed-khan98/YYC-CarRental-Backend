import { User } from "../models/user.model.js";
import { logger } from "./logger.js";
import { Car } from "../models/car.model.js";
import { getBookingPublicNumber } from "./billInvoicePdf.js";
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

function carDisplayName(car) {
  if (!car) return "Vehicle";
  return `${car.year} ${car.make} ${car.model}`.trim();
}

export function buildCheckOutInvoiceMailOptions({
  booking,
  customer,
  car,
  pdfBuffer,
}) {
  const smtpFrom = getSmtpFrom();
  const replyTo = getStaffReplyTo();
  const to = normalizeEmail(customer?.email);
  const bookingRef = getBookingPublicNumber(booking);
  const customerName = customer?.name?.trim() || to || "Customer";
  const carName = carDisplayName(car);

  const text = [
    `Hi ${customerName},`,
    "",
    `Thank you for completing the drop off process of ${carName}.`,
    "",
    "Please find the attached Invoice containing the trip & charges details.",
    "",
    "Note: We will contact you if we receive complaint or ticket during your trip booking.",
    "",
    "Best Regards,",
    "YYC Car Rental.",
  ].join("\n");

  const html = `
    <p>Hi ${escapeHtml(customerName)},</p>
    <p>Thank you for completing the drop off process of ${escapeHtml(carName)}.</p>
    <p>Please find the attached Invoice containing the trip &amp; charges details.</p>
    <p>Note: We will contact you if we receive complaint or ticket during your trip booking.</p>
    <p>Best Regards,<br/>YYC Car Rental.</p>
  `;

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
    subject: `Drop-off Completed – Booking Reference# ${bookingRef}`,
    text,
    html,
    attachments: [
      {
        filename: `invoice-checkout-${bookingRef}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };
}

export async function sendCheckOutInvoiceEmail(booking, pdfBuffer) {
  const bookingId = booking?._id;
  try {
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
      logger.info("Check-out invoice email skipped: missing PDF", {
        bookingId: String(bookingId),
      });
      return { skipped: true, reason: "no_pdf" };
    }

    const [customer, car] = await Promise.all([
      User.findById(booking.userId),
      Car.findById(booking.carId),
    ]);

    if (!isValidCustomerEmail(customer?.email)) {
      logger.info("Check-out invoice email skipped: invalid or undeliverable customer email", {
        bookingId: String(bookingId),
        email: customer?.email || null,
      });
      return { skipped: true, reason: "no_email" };
    }

    const mailOptions = buildCheckOutInvoiceMailOptions({
      booking,
      customer,
      car,
      pdfBuffer,
    });

    const info = await sendMail(mailOptions);
    logger.info("Check-out invoice email sent:", {
      bookingId: String(bookingId),
      to: mailOptions.to,
      from: mailOptions.from?.address,
      replyTo: mailOptions.replyTo,
      messageId: info?.messageId,
    });
    return { skipped: false, info };
  } catch (err) {
    return logCustomerEmailFailure("Check-out invoice email", { bookingId: String(bookingId) }, err);
  }
}
