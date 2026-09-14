import { User } from "../models/user.model.js";
import { Car } from "../models/car.model.js";
import { getBookingPublicNumber } from "./billInvoicePdf.js";
import { getSmtpFrom, getStaffReplyTo, sendMail } from "./mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const email = normalizeEmail(value);
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
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

function logEmailError(label, bookingId, err) {
  console.error(label, {
    bookingId: String(bookingId),
    code: err?.code || Number(err?.responseCode) || "unknown",
    message: err?.message,
  });
}

export function buildCheckInAgreementMailOptions({
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
  const pickupWhen = formatScheduleDate(booking.pickupDate, booking.pickupTime);
  const dropoffWhen = formatScheduleDate(booking.returnDate, booking.returnTime);

  const text = [
    "Check-in is complete. Thank you for choosing YYC Car Rental.",
    "",
    `Booking reference: ${bookingRef}`,
    `Customer: ${customerName}`,
    `Car: ${carName}`,
    `Pickup: ${pickupWhen}`,
    `Drop-off: ${dropoffWhen}`,
    "",
    "Your rental agreement is attached as a PDF.",
    "",
    "YYC Car Rental",
  ].join("\n");

  const html = `
    <p>Check-in is complete. Thank you for choosing YYC Car Rental.</p>
    <p>
      <strong>Booking reference:</strong> ${escapeHtml(bookingRef)}<br/>
      <strong>Customer:</strong> ${escapeHtml(customerName)}<br/>
      <strong>Car:</strong> ${escapeHtml(carName)}<br/>
      <strong>Pickup:</strong> ${escapeHtml(pickupWhen)}<br/>
      <strong>Drop-off:</strong> ${escapeHtml(dropoffWhen)}
    </p>
    <p>Your rental agreement is attached as a PDF.</p>
    <p>YYC Car Rental</p>
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
    subject: `Check-In Agreement — YYC Car Rental`,
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
      console.info("Check-in agreement email skipped: missing PDF", {
        bookingId: String(bookingId),
      });
      return { skipped: true, reason: "no_pdf" };
    }

    const [customer, car] = await Promise.all([
      User.findById(booking.userId),
      Car.findById(booking.carId),
    ]);

    if (!isValidCustomerEmail(customer?.email)) {
      console.info("Check-in agreement email skipped: customer has no email", {
        bookingId: String(bookingId),
      });
      return { skipped: true, reason: "no_email" };
    }

    const mailOptions = buildCheckInAgreementMailOptions({
      booking,
      customer,
      car,
      pdfBuffer,
    });

    const info = await sendMail(mailOptions);
    console.info("Check-in agreement email sent:", {
      bookingId: String(bookingId),
      to: mailOptions.to,
      from: mailOptions.from?.address,
      replyTo: mailOptions.replyTo,
      messageId: info?.messageId,
    });
    return { skipped: false, info };
  } catch (err) {
    logEmailError("Check-in agreement email failed:", bookingId, err);
    return { skipped: true, reason: "send_failed" };
  }
}
