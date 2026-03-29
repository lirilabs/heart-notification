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
    throw new Error("Missing Firebase Admin ENV vars");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  console.log("🔥 Firebase Admin initialized:", FIREBASE_PROJECT_ID);
}

const db        = admin.firestore();
const messaging = admin.messaging();

const CONCURRENCY = Number(process.env.FCM_CONCURRENCY ?? 20);

/* ======================================================
   HELPERS  (same logic, fully self-contained)
====================================================== */
async function getAllUserIds(batchSize = 500) {
  const uids = [];
  let lastDoc = null;

  while (true) {
    let q = db.collection("users").select().limit(batchSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach((d) => uids.push(d.id));
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < batchSize) break;
  }

  return uids;
}

async function getUserPayload(uid) {
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) return { error: "user_not_found" };

  const data = userSnap.data();

  // fcmToken — string or array field on the user doc
  const rawToken = data?.fcmToken;
  if (!rawToken) return { error: "no_fcm_token" };

  const tokens = Array.isArray(rawToken)
    ? rawToken.filter(Boolean)
    : [rawToken].filter(Boolean);
  if (!tokens.length) return { error: "empty_fcm_token" };

  // personalizedCategory — direct string field on the user doc (NOT a subcollection)
  const topic = data?.personalizedCategory;
  if (!topic) return { error: "no_personalized_category" };

  return { tokens, topic };
}

async function getPrompt(topic) {
  const snap = await db.doc(`prompts/${topic}`).get();
  if (!snap.exists) return { error: `no_prompt_for_topic:${topic}` };

  const data  = snap.data();
  const title = data?.title ?? topic;
  let body = null;

  if (Array.isArray(data?.messages) && data.messages.length) {
    body = data.messages[Math.floor(Math.random() * data.messages.length)];
  } else if (typeof data?.body === "string") {
    body = data.body;
  }

  if (!body) return { error: "prompt_body_empty" };
  return { title, body, imageUrl: data?.imageUrl ?? null };
}

async function sendFcm(tokens, { title, body, imageUrl }) {
  const baseMessage = {
    notification: { title, body, ...(imageUrl ? { image: imageUrl } : {}) },
    data: { sent_at: Date.now().toString() },
    android: {
      priority: "high",
      notification: { channelId: "default", sound: "default", ...(imageUrl ? { imageUrl } : {}) },
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

async function processUser(uid) {
  try {
    const payload = await getUserPayload(uid);
    if (payload.error) return { uid, status: "skipped", reason: payload.error };

    const prompt = await getPrompt(payload.topic);
    if (prompt.error) return { uid, status: "skipped", reason: prompt.error };

    const fcmResult = await sendFcm(payload.tokens, prompt);
    const status =
      fcmResult.success.length > 0
        ? fcmResult.failed.length > 0 ? "partial" : "ok"
        : "failed";

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
      .catch(() => {});

    return { uid, status, topic: payload.topic, ...fcmResult };
  } catch (err) {
    return { uid, status: "error", reason: err.message };
  }
}

/* ======================================================
   API HANDLER
====================================================== */
export default async function handler(req, res) {
  /* ── Security ── */
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${cronSecret}`)
      return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  console.log(`⏰  Morning push started at ${new Date().toISOString()}`);

  const stats = {
    startedAt: new Date().toISOString(),
    total: 0, ok: 0, partial: 0, skipped: 0, failed: 0, errors: 0,
  };

  try {
    const uids   = await getAllUserIds();
    stats.total  = uids.length;
    console.log(`👥  Found ${uids.length} users`);

    for (let i = 0; i < uids.length; i += CONCURRENCY) {
      const batch   = uids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(processUser));

      results.forEach((r) => {
        if (r.status === "fulfilled") {
          const v = r.value;
          if      (v.status === "ok")      stats.ok++;
          else if (v.status === "partial")  stats.partial++;
          else if (v.status === "skipped")  stats.skipped++;
          else if (v.status === "failed")   stats.failed++;
          else                              stats.errors++;
        } else {
          stats.errors++;
          console.error("Unhandled rejection:", r.reason);
        }
      });
    }

    stats.finishedAt = new Date().toISOString();
    console.log("📊  Stats:", stats);
    return res.status(200).json({ success: true, stats });
  } catch (err) {
    console.error("❌  Cron fatal error:", err);
    return res.status(500).json({ success: false, error: err.message, stats });
  }
}
