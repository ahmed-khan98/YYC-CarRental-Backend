import { User } from "../models/user.model.js";
import { logger } from "./logger.js";
import { Car } from "../models/car.model.js";
import { Location } from "../models/location.model.js";
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

function formatTimeForDisplay(timeStr) {
  if (!timeStr) return "";
  const raw = String(timeStr).trim();
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (h24) {
    const hours = Number(h24[1]);
    const minutes = h24[2];
    const period = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    return `${hour12}:${minutes} ${period}`;
  }
  return raw;
}

function formatScheduleDate(dateStr, timeStr) {
  if (!dateStr) return "—";
  const normalized =
    dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) : String(dateStr).slice(0, 10);
  const [y, m, d] = normalized.split("-").map(Number);
  if (!y || !m || !d) return String(dateStr);
  const date = new Date(y, m - 1, d);
  const formatted = date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return timeStr ? `${formatted} ${formatTimeForDisplay(timeStr)}` : formatted;
}

function carDisplayName(car) {
  if (!car) return "Vehicle";
  return `${car.year} ${car.make} ${car.model}`.trim();
}

export function buildCheckInAgreementMailOptions({
  booking,
  customer,
  car,
  dropoffLocation,
  pdfBuffer,
}) {
  const smtpFrom = getSmtpFrom();
  const replyTo = getStaffReplyTo();
  const to = normalizeEmail(customer?.email);
  const bookingRef = getBookingPublicNumber(booking);
  const customerName = customer?.name?.trim() || to || "Customer";
  const carName = carDisplayName(car);
  const dropoffWhen = formatScheduleDate(booking.returnDate, booking.returnTime);
  const dropoffName = dropoffLocation?.name?.trim() || "—";

  const text = [
    `Hi ${customerName},`,
    "",
    `Thank you for completing the check-in process of ${carName}. Please find the attached rental agreement and invoice document.`,
    "",
    "Kindly return the vehicle on below specified Location, Date & Time.",
    "",
    `Booking Reference: ${bookingRef}`,
    `Drop Off Location: ${dropoffName}`,
    `Drop Off Date & Time: ${dropoffWhen}`,
    "",
    "Drive Safe & Enjoy your trip.",
    "",
    "Best Regards,",
    "YYC Car Rental.",
  ].join("\n");

  const html = `
    <p>Hi ${escapeHtml(customerName)},</p>
    <p>Thank you for completing the check-in process of ${escapeHtml(carName)}. Please find the attached rental agreement and invoice document.</p>
    <p>Kindly return the vehicle on below specified Location, Date &amp; Time.</p>
    <p>
      <strong>Booking Reference:</strong> ${escapeHtml(bookingRef)}<br/>
      <strong>Drop Off Location:</strong> ${escapeHtml(dropoffName)}<br/>
      <strong>Drop Off Date &amp; Time:</strong> ${escapeHtml(dropoffWhen)}
    </p>
    <p>Drive Safe &amp; Enjoy your trip.</p>
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
    subject: `Check-in Completed – Booking Reference# ${bookingRef}`,
    text,
    html,
    attachments: [
      {
        filename: `agreement-${bookingRef}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };
}

export async function sendCheckInAgreementEmail(booking, pdfBuffer) {
  const bookingId = booking?._id;
  try {
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
      logger.info("Check-in agreement email skipped: missing PDF", {
        bookingId: String(bookingId),
      });
      return { skipped: true, reason: "no_pdf" };
    }

    const [customer, car, dropoffLocation] = await Promise.all([
      User.findById(booking.userId),
      Car.findById(booking.carId),
      Location.findById(booking.dropoffLocationId),
    ]);

    if (!isValidCustomerEmail(customer?.email)) {
      logger.info("Check-in agreement email skipped: invalid or undeliverable customer email", {
        bookingId: String(bookingId),
        email: customer?.email || null,
      });
      return { skipped: true, reason: "no_email" };
    }

    const mailOptions = buildCheckInAgreementMailOptions({
      booking,
      customer,
      car,
      dropoffLocation,
      pdfBuffer,
    });

    const info = await sendMail(mailOptions);
    logger.info("Check-in agreement email sent:", {
      bookingId: String(bookingId),
      to: mailOptions.to,
      from: mailOptions.from?.address,
      replyTo: mailOptions.replyTo,
      messageId: info?.messageId,
    });
    return { skipped: false, info };
  } catch (err) {
    return logCustomerEmailFailure("Check-in agreement email", { bookingId: String(bookingId) }, err);
  }
}
