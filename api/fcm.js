import admin from "firebase-admin";

/* ======================================================
   FORCE NODE RUNTIME (REQUIRED)
====================================================== */
export const config = {
  runtime: "nodejs",
};

/* ======================================================
   FIREBASE ADMIN INIT (SAFE SINGLETON)
====================================================== */
if (!admin.apps.length) {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    throw new Error("Missing Firebase Admin environment variables");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

/* ======================================================
   API HANDLER
====================================================== */
export default async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
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
        success: false,
        error: "token, title, and body are required",
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
            "mutable-content": 1,
          },
        },
        fcmOptions: {
          ...(imageUrl ? { image: imageUrl } : {}),
        },
      },
    };

    const messageId = await admin.messaging().send(message);

    return res.status(200).json({
      success: true,
      messageId,
    });

  } catch (err) {
    console.error("FCM ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
