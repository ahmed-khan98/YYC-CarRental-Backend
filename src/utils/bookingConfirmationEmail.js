import { User } from "../models/user.model.js";
import { Car } from "../models/car.model.js";
import { Location } from "../models/location.model.js";
import {
  generateFullInvoicePdf,
  getBookingPublicNumber,
} from "./billInvoicePdf.js";
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

function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
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

function locationName(location) {
  return location?.name?.trim() || "—";
}

function logEmailError(label, bookingId, err) {
  console.error(label, {
    bookingId: String(bookingId),
    code: err?.code || Number(err?.responseCode) || "unknown",
    message: err?.message,
  });
}

export function buildBookingConfirmationMailOptions({
  booking,
  customer,
  car,
  pickupLocation,
  dropoffLocation,
  invoicePdfBuffer,
}) {
  const smtpFrom = getSmtpFrom();
  const replyTo = getStaffReplyTo();
  const to = normalizeEmail(customer?.email);
  const bookingRef = getBookingPublicNumber(booking);
  const customerName = customer?.name?.trim() || to || "Customer";
  const carName = carDisplayName(car);
  const pickupWhen = formatScheduleDate(booking.pickupDate, booking.pickupTime);
  const dropoffWhen = formatScheduleDate(booking.returnDate, booking.returnTime);
  const pickupName = locationName(pickupLocation);
  const dropoffName = locationName(dropoffLocation);
  const sameLocation =
    pickupLocation &&
    dropoffLocation &&
    String(pickupLocation._id) === String(dropoffLocation._id);
  const totalLabel = formatMoney(booking.totalAmount);

  const locationLines = sameLocation
    ? [`Pickup / drop-off: ${pickupName}`]
    : [`Pickup location: ${pickupName}`, `Drop-off location: ${dropoffName}`];

  const text = [
    "Your booking is confirmed. Thank you for choosing YYC Car Rental.",
    "",
    `Booking reference: ${bookingRef}`,
    `Customer: ${customerName}`,
    `Car: ${carName}`,
    `Pickup: ${pickupWhen}`,
    `Drop-off: ${dropoffWhen}`,
    ...locationLines,
    `Total amount: ${totalLabel}`,
    "",
    "Your invoice is attached as a PDF.",
    "",
    "YYC Car Rental",
  ].join("\n");

  const htmlLocation = sameLocation
    ? `<strong>Pickup / drop-off:</strong> ${escapeHtml(pickupName)}`
    : `<strong>Pickup location:</strong> ${escapeHtml(pickupName)}<br/>
    <strong>Drop-off location:</strong> ${escapeHtml(dropoffName)}`;

  const html = `
    <p>Your booking is confirmed. Thank you for choosing YYC Car Rental.</p>
    <p>
      <strong>Booking reference:</strong> ${escapeHtml(bookingRef)}<br/>
      <strong>Customer:</strong> ${escapeHtml(customerName)}<br/>
      <strong>Car:</strong> ${escapeHtml(carName)}<br/>
      <strong>Pickup:</strong> ${escapeHtml(pickupWhen)}<br/>
      <strong>Drop-off:</strong> ${escapeHtml(dropoffWhen)}<br/>
      ${htmlLocation}<br/>
      <strong>Total amount:</strong> ${escapeHtml(totalLabel)}
    </p>
    <p>Your invoice is attached as a PDF.</p>
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
    subject: "Booking Confirmation — YYC Car Rental",
    text,
    html,
    attachments: [
      {
        filename: `invoice-${bookingRef}.pdf`,
        content: invoicePdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };
}

export async function sendBookingConfirmationEmail(booking) {
  const bookingId = booking?._id;
  try {
    const [customer, car, pickupLocation, dropoffLocation] = await Promise.all([
      User.findById(booking.userId),
      Car.findById(booking.carId),
      Location.findById(booking.pickupLocationId),
      Location.findById(booking.dropoffLocationId),
    ]);

    if (!isValidCustomerEmail(customer?.email)) {
      console.info("Booking confirmation email skipped: customer has no email", {
        bookingId: String(bookingId),
      });
      return { skipped: true, reason: "no_email" };
    }

    const invoicePdfBuffer = await generateFullInvoicePdf(booking);
    const mailOptions = buildBookingConfirmationMailOptions({
      booking,
      customer,
      car,
      pickupLocation,
      dropoffLocation,
      invoicePdfBuffer,
    });

    const info = await sendMail(mailOptions);
    console.info("Booking confirmation email sent:", {
      bookingId: String(bookingId),
      to: mailOptions.to,
      from: mailOptions.from?.address,
      replyTo: mailOptions.replyTo,
      messageId: info?.messageId,
    });
    return { skipped: false, info };
  } catch (err) {
    logEmailError("Booking confirmation email failed:", bookingId, err);
    return { skipped: true, reason: "send_failed" };
  }
}
