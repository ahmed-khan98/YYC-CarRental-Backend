// testEmail.js
// Run: node testEmail.js

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "mail.yyccarrental.com",
  port: 465,
  secure: true,
  auth: {
    user: "booking@yyccarrental.com",
    pass: "YycCarRental123++", // ← apna password yahan dalo
  },
});

try {
  await transporter.verify();
  console.log("✓ SMTP connection successful!");

  await transporter.sendMail({
    from: "booking@yyccarrental.com",
    to: "booking@yyccarrental.com",
    subject: "Test Email — Contact Form",
    html: `
      <h2>Test Email</h2>
      <p><b>Full Name:</b> Test User</p>
      <p><b>Email:</b> test@gmail.com</p>
      <p><b>Phone:</b> +1 234 567 8900</p>
      <p><b>Message:</b> This is a test email from contact form.</p>
    `,
  });

  console.log("✓ Test email sent successfully to booking@yyccarrental.com");
} catch (err) {
  console.error("✗ Error:", err.message);
}