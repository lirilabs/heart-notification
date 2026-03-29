import admin from "firebase-admin";

/* ======================================================
   FORCE NODE RUNTIME (VERCEL)
====================================================== */
export const config = { runtime: "nodejs" };

/* ======================================================
   FIREBASE ADMIN INIT
====================================================== */
if (!admin.apps.length) {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      `Missing Firebase Admin ENV vars. Got: ` +
        `PROJECT_ID=${!!FIREBASE_PROJECT_ID}, ` +
        `CLIENT_EMAIL=${!!FIREBASE_CLIENT_EMAIL}, ` +
        `PRIVATE_KEY=${!!FIREBASE_PRIVATE_KEY}`
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  console.log("🔥 Firebase Admin initialized:", FIREBASE_PROJECT_ID);
}

const db        = admin.firestore();
const messaging = admin.messaging();

/* ======================================================
   HELPERS
====================================================== */

/**
 * users/{uid} → fcmToken + personalizedCategory (both are fields on the doc)
 */
async function getUserPayload(uid) {
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) return { error: "user_not_found" };

  const data = userSnap.data();

  const rawToken = data?.fcmToken;
  if (!rawToken) return { error: "no_fcm_token" };

  const tokens = Array.isArray(rawToken)
    ? rawToken.filter(Boolean)
    : [rawToken].filter(Boolean);
  if (!tokens.length) return { error: "empty_fcm_token" };

  const topic = data?.personalizedCategory;
  if (!topic) return { error: "no_personalized_category" };

  return { tokens, topic };
}

/**
 * prompts — query by category, pick a random doc.
 *
 * FIX: imageBase64 is NO LONGER included in the FCM data payload.
 * FCM has a 4 KB hard limit on the data object. Base64 images are
 * typically 50–300 KB, which causes "Android message is too big".
 *
 * Instead, we send promptId so the app can fetch the full prompt
 * (including images) from Firestore after the user taps the notification.
 */
async function getPrompt(topic) {
  const snap = await db
    .collection("prompts")
    .where("category", "==", topic)
    .get();

  if (snap.empty) return { error: `no_prompt_for_topic:${topic}` };

  const docs = snap.docs;
  const docSnap = docs[Math.floor(Math.random() * docs.length)];
  const doc  = docSnap.data();

  // Title
  const title = doc?.title ?? topic;

  // Body preview — first ~120 chars of promptText
  const rawText = doc?.promptText ?? doc?.body ?? null;
  if (!rawText) return { error: "prompt_body_empty" };

  const preview = rawText.slice(0, 120);
  const body = rawText.length > 120
    ? (preview.lastIndexOf(" ") > 60
        ? preview.slice(0, preview.lastIndexOf(" "))
        : preview) + "…"
    : rawText;

  // ✅ FIX: imageBase64 removed — never send base64 in FCM data payload.
  // The app should load images from Firestore using promptId after tap.
  const extra = {
    promptId:    docSnap.id       ?? doc?.id ?? "",
    category:    doc?.category    ?? topic,
    authorName:  doc?.authorName  ?? "",
    authorPhoto: doc?.authorPhoto ?? "",
    // promptText kept for quick preview on notification tap (short is fine)
    // but truncate to keep payload safely under 4 KB
    promptText:  rawText.slice(0, 300),
  };

  // imageUrl must be a public https:// URL (not base64) for FCM notification image
  return { title, body, imageUrl: doc?.imageUrl ?? null, extra };
}

/** Send FCM to one or more device tokens */
async function sendFcm(tokens, { title, body, imageUrl, extra = {} }) {
  const baseMessage = {
    notification: {
      title,
      body,
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: {
      sent_at: Date.now().toString(),
      ...Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [k, String(v)])
      ),
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
      payload: { aps: { sound: "default", "mutable-content": 1 } },
      ...(imageUrl ? { fcmOptions: { image: imageUrl } } : {}),
    },
  };

  if (tokens.length === 1) {
    const messageId = await messaging.send({ ...baseMessage, token: tokens[0] });
    return { success: [{ token: tokens[0], messageId }], failed: [] };
  }

  const result = await messaging.sendEachForMulticast({ ...baseMessage, tokens });
  const success = [], failed = [];
  result.responses.forEach((r, i) => {
    if (r.success) success.push({ token: tokens[i], messageId: r.messageId });
    else           failed.push({ token: tokens[i], error: r.error?.message });
  });
  return { success, failed };
}

/* ======================================================
   API HANDLER
====================================================== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method Not Allowed" });

  const { uid } = req.body ?? {};
  if (!uid)
    return res.status(400).json({ success: false, error: "uid is required" });

  try {
    /* 1 + 2 — token + topic */
    const payload = await getUserPayload(uid);
    if (payload.error)
      return res.status(422).json({
        success: false,
        result: { uid, status: "skipped", reason: payload.error },
      });

    console.log(`📨 uid=${uid} topic=${payload.topic} tokens=${payload.tokens.length}`);

    /* 3 — prompt */
    const prompt = await getPrompt(payload.topic);
    if (prompt.error)
      return res.status(422).json({
        success: false,
        result: { uid, status: "skipped", reason: prompt.error },
      });

    /* 4 — FCM send */
    const fcmResult = await sendFcm(payload.tokens, prompt);

    const status =
      fcmResult.success.length > 0
        ? fcmResult.failed.length > 0 ? "partial" : "ok"
        : "failed";

    /* 5 — audit log */
    await db
      .collection(`users/${uid}/notificationLog`)
      .add({
        sentAt:       new Date().toISOString(),
        topic:        payload.topic,
        title:        prompt.title,
        body:         prompt.body,
        status,
        successCount: fcmResult.success.length,
        failCount:    fcmResult.failed.length,
      })
      .catch((e) => console.warn("⚠️ Audit log failed (non-critical):", e.message));

    const ok = status === "ok" || status === "partial";
    return res.status(ok ? 200 : 422).json({
      success: ok,
      result: { uid, status, topic: payload.topic, ...fcmResult },
    });

  } catch (err) {
    console.error("❌ send-to-user error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
