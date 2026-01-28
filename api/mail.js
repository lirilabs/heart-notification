import admin from "firebase-admin";
import nodemailer from "nodemailer";

/* ======================================================
   Firebase Admin Initialization (SAFE)
====================================================== */
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  } catch (e) {
    console.error("Firebase init error:", e);
  }
}

/* ======================================================
   SMTP Transport (SAFE)
====================================================== */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD, // MUST have NO spaces
  },
});

/* ======================================================
   API Handler (SERVERLESS SAFE)
====================================================== */
export default async function handler(req, res) {
  /* -------- CORS -------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET allowed" });
  }

  try {
    /* -------- SAFE URL PARSING -------- */
    const baseUrl = `https://${process.env.VERCEL_URL || "localhost"}`;
    const parsedUrl = new URL(req.url, baseUrl);

    const uid = parsedUrl.searchParams.get("uid");
    const title = parsedUrl.searchParams.get("title");
    const content = parsedUrl.searchParams.get("content");

    if (!uid || !title || !content) {
      return res.status(400).json({
        error: "uid, title and content are required",
      });
    }

    /* -------- Firebase User -------- */
    const user = await admin.auth().getUser(uid);

    if (!user?.email) {
      return res.status(400).json({
        error: "User does not have an email",
      });
    }

    /* -------- Send Email -------- */
    await transporter.sendMail({
      from: `"Heart❣️" <${process.env.SMTP_EMAIL}>`,
      to: user.email,
      subject: title,
      text: content,
      html: `<p>${content.replace(/\n/g, "<br/>")}</p>`,
    });

    return res.status(200).json({
      success: true,
      uid,
      email: user.email,
      message: "Email sent successfully",
    });

  } catch (err) {
    console.error("MAIL FUNCTION CRASH:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
