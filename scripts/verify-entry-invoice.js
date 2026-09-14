import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PizZip from "pizzip";
import {
  assignInvoiceNumber,
  buildFullInvoiceNumber,
  buildInvoiceNumber,
  canHaveInvoice,
  fillBillInvoiceDocx,
  getBookingPublicNumber,
  resolveFullInvoiceScope,
  resolveInvoiceScope,
} from "../src/utils/billInvoicePdf.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const bookingId = "00000000000000002dd5249a";
const booking = {
  _id: bookingId,
  invoiceSequence: 0,
  pickupDate: "2026-09-01",
  pickupTime: "10:00",
  returnDate: "2026-09-04",
  returnTime: "10:00",
  bookedDailyRate: 89,
  bookedChargePerExtraKm: 0.35,
  bookedCarCategory: "suv",
  extraMileageKm: 40,
  extraMileageCharge: 14,
  checkInMileage: 12000,
  checkOutMileage: 12640,
  serviceSnapshots: [
    {
      serviceId: "svc1",
      name: "Child Seat",
      dailyRate: 10,
      chargeType: "per_day",
      quantity: 1,
    },
  ],
  billEntries: [
    {
      _id: "e1",
      title: "Vehicle Rental",
      description: "3 day rental",
      amount: 267,
      entryType: "charge",
      source: "system",
      systemKey: "rental",
      status: "unpaid",
    },
    {
      _id: "e2",
      title: "Child Seat",
      amount: 30,
      entryType: "charge",
      source: "system",
      systemKey: "service:svc1",
      status: "unpaid",
    },
    {
      _id: "e3",
      title: "Check-In Payment",
      amount: 50,
      entryType: "payment",
      source: "manual",
      status: "paid",
    },
    {
      _id: "e4",
      title: "Extra Mileage",
      description: "Overage charge at check-out",
      amount: 14,
      entryType: "charge",
      source: "system",
      systemKey: "extra_mileage",
      status: "unpaid",
    },
    {
      _id: "e5",
      title: "Check-Out Payment",
      amount: 45.55,
      entryType: "payment",
      source: "manual",
      status: "paid",
    },
    {
      _id: "e6",
      title: "Fuel refill",
      description: "Check-in Full Tank to Check-out 3/4 Tank",
      amount: 25,
      entryType: "charge",
      source: "manual",
      phase: "check_out",
      status: "paid",
      taxAmount: 1.25,
      totalAmount: 26.25,
    },
  ],
};

assert(getBookingPublicNumber(booking) === "2DD5249A", "public booking number should be last 8 chars");
assert(buildInvoiceNumber(booking, 1) === "2DD5249A-1", "first invoice number format");

const rentalCharge = booking.billEntries[0];
const childSeatCharge = booking.billEntries[1];
const checkInPayment = booking.billEntries[2];
const extraMileageCharge = booking.billEntries[3];
const checkOutPayment = booking.billEntries[4];
const fuelCharge = booking.billEntries[5];

assignInvoiceNumber(booking, rentalCharge);
assignInvoiceNumber(booking, childSeatCharge);
assignInvoiceNumber(booking, checkInPayment);
assignInvoiceNumber(booking, extraMileageCharge);
assignInvoiceNumber(booking, checkOutPayment);
assignInvoiceNumber(booking, checkInPayment);

assert(!canHaveInvoice(extraMileageCharge), "extra mileage is on the check-out invoice, not its own");
assert(!canHaveInvoice(fuelCharge), "checkout-phase charges are on the check-out invoice, not their own");
assert(rentalCharge.invoiceNumber === "2DD5249A-1", "first billing entry is invoice 1");
assert(childSeatCharge.invoiceNumber === "2DD5249A-2", "second billing entry is invoice 2");
assert(checkInPayment.invoiceNumber === "2DD5249A-3", "payment keeps its own invoice number");
assert(extraMileageCharge.invoiceNumber === "2DD5249A-4", "extra mileage can still receive a number if assigned");
assert(checkInPayment.invoiceNumber === "2DD5249A-3", "updating the same entry keeps the invoice number");
assert(booking.invoiceSequence === 5, "checkout-phase fuel does not consume an invoice number");

const postChallan = {
  _id: "e7",
  title: "Traffic challan",
  amount: 80,
  entryType: "charge",
  source: "manual",
  status: "unpaid",
  createdAt: "2026-09-10T12:00:00.000Z",
};
booking.billEntries.push(postChallan);
assignInvoiceNumber(booking, postChallan);
assert(postChallan.invoiceNumber === "2DD5249A-6", "new charge gets the next invoice number");
booking.billEntries.pop();
booking.invoiceSequence = 5;
delete postChallan.invoiceNumber;

const car = { year: 2024, make: "Toyota", model: "RAV4", category: "suv", licensePlate: "ABC-123", color: "White" };
const rental = resolveInvoiceScope(booking, rentalCharge, { car });
const checkIn = resolveInvoiceScope(booking, checkInPayment, { car });
const checkOut = resolveInvoiceScope(booking, checkOutPayment, { car });

assert(rental.kind === "single", "rental invoice is only that charge");
assert(rental.lines.length === 1 && /rental/i.test(rental.lines[0].description), "rental invoice has rental line");
assert(checkIn.kind === "check_in", "check-in payment opens the check-in invoice");
assert(checkIn.lines.some((line) => /rental/i.test(line.description)), "check-in invoice includes rental");
assert(checkIn.lines.some((line) => line.description === "Child Seat"), "check-in invoice includes services");
assert(!checkIn.lines.some((line) => /fuel/i.test(line.description)), "check-in invoice excludes fuel");
assert(checkIn.paymentReceived === 50, "check-in invoice records amount paid");
assert(!checkIn.lines.some((line) => /Paid at check-in/i.test(line.description)), "check-in invoice does not list payment as a table row");
assert(checkIn.amountDue === checkIn.totalAmount - 50, "check-in due is remaining after payment");
assert(checkOut.kind === "check_out", "check-out payment opens the check-out invoice");
assert(checkOut.lines.some((line) => /mileage/i.test(line.description)), "check-out invoice includes extra KM");
assert(checkOut.lines.some((line) => /fuel/i.test(line.description)), "check-out invoice includes checkout charges");
assert(!checkOut.lines.some((line) => /Paid at check-out/i.test(line.description)), "check-out invoice does not list payment as a table row");
assert(checkOut.checkOutPaid === 45.55, "check-out invoice records amount paid");
assert(checkOut.previousBalance === checkIn.amountDue, "check-out carries unpaid check-in balance");
assert(checkOut.paymentReceived >= 45.55, "check-out invoice records cash paid at return");
assert(
  checkOut.amountDue === Math.max(0, Math.round((checkOut.totalAmount - checkOut.paymentReceived) * 100) / 100),
  "check-out due is remaining after payment",
);

const staleCheckOutSnap = {
  ...booking,
  checkOutBillSnapshot: {
    capturedAt: "2026-09-04T09:00:00.000Z",
    entries: [
      { title: "Extra Mileage", amount: 14, entryType: "charge", systemKey: "extra_mileage", status: "unpaid" },
    ],
  },
};
const staleCheckOut = resolveInvoiceScope(staleCheckOutSnap, checkOutPayment, { car });
assert(staleCheckOut.checkOutPaid === 45.55, "stale checkout snapshot without payment still reads live Check-Out Payment");
assert(!staleCheckOut.lines.some((line) => /Paid at check-out/i.test(line.description)), "stale checkout snapshot does not list payment as a table row");
assert(staleCheckOut.lines.some((line) => /fuel/i.test(line.description)), "incomplete checkout snapshot still includes live fuel");
assert(staleCheckOut.lines.some((line) => /mileage/i.test(line.description)), "incomplete checkout snapshot still includes extra KM");

const postScope = resolveInvoiceScope(
  { ...booking, billEntries: [...booking.billEntries, postChallan] },
  postChallan,
  { car },
);
assert(postScope.kind === "single", "added charge is its own invoice");
assert(postScope.lines.length === 1 && postScope.lines[0].description === "Traffic challan", "charge invoice is only that charge");

const eTransferCharge = {
  _id: "e8",
  title: "Parking ticket",
  description: "Downtown parkade",
  amount: 40,
  entryType: "charge",
  source: "manual",
  status: "unpaid",
  paidVia: "e_transfer",
};
const depositCharge = {
  _id: "e9",
  title: "Cleaning fee",
  amount: 50,
  entryType: "charge",
  source: "manual",
  status: "paid",
  paidVia: "deposit",
};
const eTransferScope = resolveInvoiceScope(
  { ...booking, billEntries: [...booking.billEntries, eTransferCharge] },
  eTransferCharge,
  { car },
);
assert(
  /Customer to pay by e-transfer/i.test(eTransferScope.lines[0].detail ?? ""),
  "e-transfer charge invoice notes customer must e-transfer",
);
assert(
  eTransferScope.paymentNotes.some((note) => /e-transfer/i.test(note)),
  "e-transfer charge invoice footer mentions e-transfer",
);
const depositScope = resolveInvoiceScope(
  { ...booking, billEntries: [...booking.billEntries, depositCharge] },
  depositCharge,
  { car },
);
assert(
  /Paid from security deposit/i.test(depositScope.lines[0].detail ?? ""),
  "pre-authorized charge invoice notes payment from deposit",
);
assert(
  depositScope.paymentNotes.some((note) => /security deposit/i.test(note)),
  "pre-authorized charge invoice footer mentions deposit",
);
const fullWithMethods = resolveFullInvoiceScope(
  { ...booking, billEntries: [...booking.billEntries, eTransferCharge, depositCharge] },
  { car },
);
assert(
  fullWithMethods.lines.some((line) => /e-transfer/i.test(line.detail ?? "")),
  "full invoice repeats e-transfer note on that line",
);
assert(
  fullWithMethods.lines.some((line) => /security deposit/i.test(line.detail ?? "")),
  "full invoice repeats deposit note on that line",
);

const full = resolveFullInvoiceScope(booking, { car });
assert(full.kind === "full", "full invoice kind");
assert(full.lines.some((line) => /rental/i.test(line.description)), "full invoice includes rental");
assert(full.lines.some((line) => line.description === "Child Seat"), "full invoice includes additional services");
assert(full.lines.some((line) => /mileage/i.test(line.description)), "full invoice includes extra KM");
assert(full.lines.some((line) => line.description === "Fuel refill"), "full invoice includes additional charges");
assert(full.paymentReceived === 121.8, "full invoice counts payments plus unpaid remainder of paid charges");
assert(buildFullInvoiceNumber(booking) === "2DD5249A-ALL", "full invoice number is suffix-ALL");

const adminMatched = {
  _id: bookingId,
  pickupDate: "2026-09-08",
  pickupTime: "10:00",
  returnDate: "2026-09-08",
  returnTime: "18:00",
  bookedDailyRate: 35,
  extraMileageKm: 20,
  extraMileageCharge: 4,
  billEntries: [
    { _id: "r1", title: "Sedan Rental", amount: 35, entryType: "charge", source: "system", systemKey: "rental", status: "unpaid" },
    { _id: "s1", title: "Child Seat", amount: 7, entryType: "charge", source: "system", systemKey: "service:svc1", status: "unpaid" },
    { _id: "s2", title: "Extra Driver", amount: 20, entryType: "charge", source: "system", systemKey: "service:svc2", status: "unpaid" },
    { _id: "m1", title: "Extra Mileage", amount: 4, entryType: "charge", source: "system", systemKey: "extra_mileage", status: "unpaid" },
    { _id: "f1", title: "Fuel refill", amount: 25, entryType: "charge", source: "manual", status: "paid", taxAmount: 1.25, totalAmount: 26.25 },
    { _id: "p1", title: "out of province fine", amount: 50, entryType: "charge", source: "manual", status: "paid", taxAmount: 2.5, totalAmount: 52.5 },
    { _id: "pay1", title: "Check-In Payment", amount: 50, entryType: "payment", source: "manual", status: "paid" },
    { _id: "pay2", title: "Check-Out Payment", amount: 45.55, entryType: "payment", source: "manual", status: "paid" },
  ],
};
const fullMatched = resolveFullInvoiceScope(adminMatched, { car: { category: "sedan" } });
assert(fullMatched.totalAmount === 148.05, "full invoice total matches admin 148.05");
assert(fullMatched.paymentReceived === 148.05, "paid must not double-count fuel already in checkout payment");
assert(fullMatched.amountDue === 0 && fullMatched.status === "paid", "fully collected bill is Paid with $0 due");

const party = {
  bookingRef: `#${getBookingPublicNumber(booking)}`,
  reservationSuffix: getBookingPublicNumber(booking),
  customerName: "Jane Driver",
  customerEmail: "jane@example.com",
  customerPhone: "4035550100",
  billedToAddress: "123 Main St, Calgary",
  vehicleLabel: "2024 Toyota RAV4",
  vehiclePlate: "ABC-123",
  vehicleColor: "White",
  vehicleVin: "JTMRB3FV0ND123456",
  pickupLabel: "YYC Airport — Sep 1, 2026 10:00 AM",
  returnLabel: "YYC Airport — Sep 4, 2026 10:00 AM",
  durationDays: "3",
  includedKm: "450",
};

const templatePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/bill-invoice-template.docx",
);
const templateBuffer = await fs.readFile(templatePath);

function invoicePlainText(docxBuffer) {
  const zip = new PizZip(docxBuffer);
  const xml = zip.file("word/document.xml").asText();
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(" ");
}

const rentalDocx = fillBillInvoiceDocx(templateBuffer, {
  ...party,
  ...rental,
  invoiceNumber: rentalCharge.invoiceNumber,
  issuedAt: new Date("2026-09-01T12:00:00Z"),
});
const checkInDocx = fillBillInvoiceDocx(templateBuffer, {
  ...party,
  ...checkIn,
  invoiceNumber: checkInPayment.invoiceNumber,
  issuedAt: new Date("2026-09-01T12:00:00Z"),
  odometerOut: "131330",
  fuelLevelOut: "Full Tank",
});
const checkOutDocx = fillBillInvoiceDocx(templateBuffer, {
  ...party,
  ...checkOut,
  invoiceNumber: checkOutPayment.invoiceNumber,
  issuedAt: new Date("2026-09-04T12:00:00Z"),
});
const postDocx = fillBillInvoiceDocx(templateBuffer, {
  ...party,
  ...postScope,
  invoiceNumber: "2DD5249A-6",
  issuedAt: new Date("2026-09-10T12:00:00Z"),
});
const fullDocx = fillBillInvoiceDocx(templateBuffer, {
  ...party,
  ...full,
  invoiceNumber: buildFullInvoiceNumber(booking),
  issuedAt: new Date("2026-09-04T12:00:00Z"),
});
const rentalText = invoicePlainText(rentalDocx);
const checkInText = invoicePlainText(checkInDocx);
const checkOutText = invoicePlainText(checkOutDocx);
const postText = invoicePlainText(postDocx);

assert(rentalText.includes("TOTAL"), "invoice total label is TOTAL");
assert(!/TOTAL\s*DUE/i.test(rentalText), "invoice no longer says TOTAL DUE");
assert(rentalText.includes("INVOICE"), "heading is INVOICE");
assert(!rentalText.includes("RENTAL INVOICE"), "old RENTAL INVOICE heading is gone");
assert(rentalText.includes("2DD5249A-1"), "rental invoice number is 1");
assert(/SUV Rental|Vehicle Rental/.test(rentalText), "rental invoice includes rental");
assert(!rentalText.includes("Fuel refill"), "rental invoice excludes fuel");
assert(!rentalText.includes("Administrative Fees"), "admin fees row is removed");
assert(!/SECURITY\s*DEPOSIT/i.test(rentalText), "security deposit row is removed from invoice");
assert(postText.includes("2DD5249A-6"), "added charge invoice number is 6");
assert(postText.includes("Traffic challan"), "charge invoice has only that charge");
assert(!postText.includes("Fuel refill"), "charge invoice excludes other charges");
assert(checkInText.includes("2DD5249A-3"), "check-in invoice number is in the template");
assert(checkInText.includes("Child Seat"), "check-in invoice includes services");
assert(/Paid:/.test(checkInText), "check-in invoice shows amount paid");
assert(!checkInText.includes("Paid at check-in"), "check-in invoice does not list payment as a table row");
assert(checkInText.includes("Balance due"), "check-in invoice shows remaining due");
assert(!checkInText.includes("This invoice paid"), "check-in invoice does not use payment-only wording");
assert(!checkInText.includes("Fuel refill"), "check-in invoice excludes checkout charges");
function assertWordXmlBalanced(xml, label) {
  const tags = ["w:tbl", "w:tr", "w:tc", "w:p"];
  for (const tag of tags) {
    const openPrefix = `<${tag}`;
    const closeTag = `</${tag}>`;
    let opens = 0;
    let closes = 0;
    let pos = 0;
    while (pos < xml.length) {
      const idx = xml.indexOf(openPrefix, pos);
      if (idx < 0) break;
      const ch = xml[idx + openPrefix.length];
      if (ch === " " || ch === ">" || ch === "/") {
        const gt = xml.indexOf(">", idx);
        if (gt >= 0 && !xml.slice(idx, gt + 1).endsWith("/>")) opens += 1;
        pos = (gt >= 0 ? gt : idx) + 1;
      } else {
        pos = idx + openPrefix.length;
      }
    }
    pos = 0;
    while (pos < xml.length) {
      const idx = xml.indexOf(closeTag, pos);
      if (idx < 0) break;
      closes += 1;
      pos = idx + closeTag.length;
    }
    assert(opens === closes, `${label} has balanced ${tag} (${opens} open / ${closes} close)`);
  }
}
function assertNoInvoiceSignatureBlock(docx, message) {
  const xml = new PizZip(docx).file("word/document.xml").asText();
  assertWordXmlBalanced(xml, message);
  assert(!xml.includes("<w:t>Print Full Name</w:t>"), `${message}: Print Full Name removed`);
  assert(!xml.includes("<w:t>Renter Signature</w:t>"), `${message}: Renter Signature removed`);
}
assertNoInvoiceSignatureBlock(checkInDocx, "check-in invoice");
assertNoInvoiceSignatureBlock(fullDocx, "full statement");
assert(!checkInText.includes("Renter Signature"), "invoice does not include renter signature label");
assert(!checkInText.includes("Print Full Name"), "invoice does not include print full name label");
assert(!checkInText.includes("Renter initials"), "invoice does not include renter initials line");
assert(!checkInText.includes("condition confirmed"), "invoice does not include condition-confirmed initials");
assert(!/YYC Car Rental Rep/i.test(checkInText), "invoice does not include YYC Car Rental Rep initials");
assert(!checkInText.includes("Representative"), "invoice does not include representative signature label");
function invoiceOdometerHeaders(docx) {
  const xml = new PizZip(docx).file("word/document.xml").asText();
  const pos = xml.indexOf("<w:t>Odometer Out</w:t>");
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const rowEnd = xml.indexOf("</w:tr>", pos);
  return [...xml.slice(rowStart, rowEnd + 7).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]);
}
assert(
  invoiceOdometerHeaders(checkInDocx).join("|") ===
    "Odometer Out|Fuel Level Out|Odometer In|Fuel Level In",
  "invoice odometer/fuel columns are Out then In",
);
function invoiceOdometerValues(docx) {
  const xml = new PizZip(docx).file("word/document.xml").asText();
  const pos = xml.indexOf("<w:t>Odometer Out</w:t>");
  const headerEnd = xml.indexOf("</w:tr>", pos);
  const rowStart = xml.indexOf("<w:tr", headerEnd);
  const rowEnd = xml.indexOf("</w:tr>", rowStart);
  return [...xml.slice(rowStart, rowEnd + 7).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) =>
    match[1].trim(),
  );
}
const odometerValues = invoiceOdometerValues(checkInDocx);
assert(odometerValues[0] === "131330", "odometer out value stays in the first column");
assert(odometerValues[1] === "Full Tank", "fuel out value sits beside odometer out");
assert(checkOut.paymentNotes.some((note) => /Paid at check-out/i.test(note)), "check-out invoice footer notes the check-out payment");
assert(checkOutText.includes("Paid at check-out"), "check-out invoice footer lists the check-out payment");
assert(/Paid:/.test(checkOutText), "check-out invoice shows amount paid");
assert(checkOutText.includes("Balance due"), "check-out invoice shows remaining due");
assert(checkOutText.includes("Extra Mileage"), "check-out invoice includes extra KM");
assert(checkOutText.includes("Fuel refill"), "check-out invoice includes checkout charges");
assert(!checkOutText.includes("This invoice paid"), "check-out invoice does not use payment-only wording");

console.log("OK invoice numbers", {
  rental: rentalCharge.invoiceNumber,
  checkIn: checkInPayment.invoiceNumber,
  checkOut: checkOutPayment.invoiceNumber,
});
console.log("OK scopes", {
  rentalLines: rental.lines.map((line) => line.description),
  checkInLines: checkIn.lines.map((line) => line.description),
  checkOutLines: checkOut.lines.map((line) => line.description),
  checkOutPaid: checkOut.checkOutPaid,
  checkOutDue: checkOut.amountDue,
});
console.log("OK template fill");
