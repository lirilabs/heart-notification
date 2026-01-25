import admin from "firebase-admin";
import dotenv from "dotenv";

/* ======================================================
   Load Environment Variables
====================================================== */
dotenv.config();

/* ======================================================
   Validate Environment Variables (Fail Fast)
====================================================== */
if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !process.env.FIREBASE_PRIVATE_KEY
) {
  throw new Error("❌ Missing Firebase environment variables");
}

/* ======================================================
   Firebase Admin Initialization (NAMED APP)
====================================================== */
let app;

try {
  app = admin.app("heart-admin");
} catch (e) {
  app = admin.initializeApp(
    {
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    },
    "heart-admin"
  );
}

/* ======================================================
   Debug – Verify Runtime Identity (KEEP TEMPORARILY)
====================================================== */
console.log("🔥 Firebase Admin Loaded:", {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKeyLoaded: !!process.env.FIREBASE_PRIVATE_KEY,
});

/* ======================================================
   FCM API Handler
====================================================== */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const {
      token,
      title,
      body,
      imageUrl,
      clickAction,
      data = {},
    } = req.body || {};

    if (!token || !title || !body) {
      return res.status(400).json({
        error: "token, title and body are required",
      });
    }

    const message = {
      token,

      notification: {
        title,
        body,
        ...(imageUrl ? { image: imageUrl } : {}),
      },

      data: {
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        ...(clickAction ? { click_action: clickAction } : {}),
      },

      android: {
        priority: "high",
        notification: {
          channelId: "default",
          sound: "default",
          ...(imageUrl ? { imageUrl } : {}),
        },
      },

      apns: {
        payload: {
          aps: {
            sound: "default",
            mutableContent: true,
          },
        },
        fcmOptions: {
          ...(imageUrl ? { image: imageUrl } : {}),
        },
      },
    };

    const messageId = await app.messaging().send(message);

    return res.status(200).json({
      success: true,
      messageId,
    });
  } catch (err) {
    console.error("❌ FCM ERROR:", err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
