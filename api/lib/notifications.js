import { getFirestore, getMessaging } from "./firebase.js";

/* ─────────────────────────────────────────────────────────────
   FIRESTORE PATHS
   users/{uid}                       → { fcmToken: string | string[] }
   users/{uid}/personalizedCategory  → subcollection, first doc has { topic: string }
   prompts/{topic}                   → { title: string, messages: string[] }
                                       OR { title: string, body: string }
───────────────────────────────────────────────────────────────*/

/**
 * Returns all active user UIDs from the top-level users collection.
 */
export async function getAllUserIds(batchSize = 500) {
  const db = getFirestore();
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

/**
 * Reads a single user's FCM token(s) and personalizedCategory topic.
 * Returns null if either is missing (skip that user).
 */
export async function getUserPayload(uid) {
  const db = getFirestore();

  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) return null;

  const userData = userSnap.data();
  const rawToken = userData?.fcmToken;
  if (!rawToken) return null;

  const tokens = Array.isArray(rawToken)
    ? rawToken.filter(Boolean)
    : [rawToken].filter(Boolean);
  if (!tokens.length) return null;

  const catSnap = await db
    .collection(`users/${uid}/personalizedCategory`)
    .limit(1)
    .get();

  if (catSnap.empty) return null;

  const topic = catSnap.docs[0].data()?.topic;
  if (!topic) return null;

  return { uid, tokens, topic };
}

/**
 * Loads a random message from the prompts/{topic} document.
 */
export async function getPromptForTopic(topic) {
  const db = getFirestore();
  const snap = await db.doc(`prompts/${topic}`).get();
  if (!snap.exists) return null;

  const data = snap.data();
  const title = data?.title ?? topic;

  let body = null;
  if (Array.isArray(data?.messages) && data.messages.length) {
    body = data.messages[Math.floor(Math.random() * data.messages.length)];
  } else if (typeof data?.body === "string") {
    body = data.body;
  }

  if (!body) return null;
  return { title, body, imageUrl: data?.imageUrl ?? null };
}

/**
 * Sends an FCM notification to one or more tokens.
 */
export async function sendFcmToTokens(tokens, { title, body, imageUrl, data = {} }) {
  const messaging = getMessaging();

  const baseMessage = {
    notification: {
      title,
      body,
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: Object.fromEntries(
      Object.entries({ ...data, sent_at: Date.now().toString() }).map(([k, v]) => [
        k,
        String(v),
      ])
    ),
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

  const results = { success: [], failed: [] };

  if (tokens.length === 1) {
    try {
      const id = await messaging.send({ ...baseMessage, token: tokens[0] });
      results.success.push({ token: tokens[0], messageId: id });
    } catch (err) {
      results.failed.push({ token: tokens[0], error: err.message });
    }
  } else {
    const res = await messaging.sendEachForMulticast({ ...baseMessage, tokens });
    res.responses.forEach((r, i) => {
      if (r.success) {
        results.success.push({ token: tokens[i], messageId: r.messageId });
      } else {
        results.failed.push({ token: tokens[i], error: r.error?.message });
      }
    });
  }

  return results;
}

/**
 * Processes a single user end-to-end.
 */
export async function processUser(uid) {
  const db = getFirestore();

  try {
    const payload = await getUserPayload(uid);
    if (!payload) return { uid, status: "skipped", reason: "no_token_or_category" };

    const prompt = await getPromptForTopic(payload.topic);
    if (!prompt) return { uid, status: "skipped", reason: `no_prompt_for_topic:${payload.topic}` };

    const fcmResult = await sendFcmToTokens(payload.tokens, prompt);

    const status =
      fcmResult.success.length > 0
        ? fcmResult.failed.length > 0
          ? "partial"
          : "ok"
        : "failed";

    await db
      .collection(`users/${uid}/notificationLog`)
      .add({
        sentAt: new Date().toISOString(),
        topic: payload.topic,
        title: prompt.title,
        body: prompt.body,
        status,
        successCount: fcmResult.success.length,
        failCount: fcmResult.failed.length,
      })
      .catch(() => {});

    return { uid, status, topic: payload.topic, ...fcmResult };
  } catch (err) {
    return { uid, status: "error", reason: err.message };
  }
}
