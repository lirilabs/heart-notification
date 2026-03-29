import admin from "firebase-admin";

/* ======================================================
   FORCE NODE RUNTIME (VERCEL)
====================================================== */
export const config = { runtime: "nodejs" };

/* ======================================================
   FIREBASE ADMIN INIT
====================================================== */
if (!admin.apps.length) {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY)
    throw new Error("Missing Firebase Admin ENV vars");

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

const CONCURRENCY   = Number(process.env.FCM_CONCURRENCY ?? 20);
const SCHEDULE_DOC  = "config/schedules";
const WINDOW_MINS   = 28; // match window around scheduled time (just under 30min cron gap)

/* ======================================================
   SCHEDULE CHECK
   Reads slots from Firestore. Returns the matching slot
   if current UTC time falls within WINDOW_MINS of it.
====================================================== */
async function getMatchingSlot() {
  const snap = await db.doc(SCHEDULE_DOC).get();

  // Default: one slot at 06:30 UTC (12:00 IST)
  const { slots = [{ id: "slot_1", utcHour: 6, utcMinute: 30, enabled: true }] } =
    snap.exists ? snap.data() : {};

  const now     = new Date();
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();

  for (const slot of slots) {
    if (!slot.enabled) continue;
    const slotMins = (slot.utcHour ?? 0) * 60 + (slot.utcMinute ?? 0);
    const diff     = Math.abs(nowMins - slotMins);
    // Also handle midnight wrap (e.g. slot at 00:00, cron fires at 23:45)
    const diffWrapped = Math.min(diff, 1440 - diff);
    if (diffWrapped <= WINDOW_MINS) return slot;
  }

  return null; // no slot matches right now
}

/* ======================================================
   USER COLLECTION — paginated fetch
====================================================== */
async function getAllUsers(batchSize = 500) {
  const users = []; // { uid, tokens:[], topic }
  let lastDoc = null;

  while (true) {
    let q = db.collection("users").limit(batchSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    snap.docs.forEach((d) => {
      const data = d.data();
      const rawToken = data?.fcmToken;
      if (!rawToken) return;
      const tokens = Array.isArray(rawToken)
        ? rawToken.filter(Boolean)
        : [rawToken].filter(Boolean);
      if (!tokens.length) return;
      const topic = data?.personalizedCategory;
      if (!topic) return;
      users.push({ uid: d.id, tokens, topic });
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < batchSize) break;
  }

  return users;
}

/* ======================================================
   DUPLICATE DEVICE DEDUPLICATION

   Problem: A user may uninstall + reinstall the app,
   or use two devices. Firestore might have stale tokens.
   More critically: two *different* user accounts can share
   the same physical device (e.g. family sharing, QA tester).
   Sending to the same FCM token twice → duplicate notification.

   Solution:
   1. Build a map of token → first-seen uid
   2. For each user, keep only tokens NOT already claimed
      by a previously processed user
   3. Users whose ALL tokens are duplicates get skipped
      (the device already gets one notification via its owner)
   4. Also deduplicate tokens WITHIN a single user's array
====================================================== */
function deduplicateUsers(users) {
  const tokenOwner = new Map(); // token → uid of first claimer
  const dedupedUsers = [];

  for (const user of users) {
    // Deduplicate within the user's own token list first
    const uniqueOwn = [...new Set(user.tokens)];

    // Keep only tokens not already claimed by another user
    const freshTokens = uniqueOwn.filter((t) => {
      if (tokenOwner.has(t)) return false; // duplicate — skip
      tokenOwner.set(t, user.uid);
      return true;
    });

    if (freshTokens.length === 0) {
      // All tokens are duplicates — this device will already receive
      // a notification via the user who first claimed those tokens
      dedupedUsers.push({ ...user, tokens: [], skip: true, skipReason: "duplicate_device" });
    } else {
      dedupedUsers.push({ ...user, tokens: freshTokens, skip: false });
    }
  }

  return dedupedUsers;
}

/* ======================================================
   PROMPT FETCH — random prompt for a topic
====================================================== */
async function getPrompt(topic) {
  const snap = await db
    .collection("prompts")
    .where("category", "==", topic)
    .get();

  if (snap.empty) return { error: `no_prompt_for_topic:${topic}` };

  const docSnap = snap.docs[Math.floor(Math.random() * snap.docs.length)];
  const doc     = docSnap.data();

  const title   = doc?.title ?? topic;
  const rawText = doc?.promptText ?? doc?.body ?? null;
  if (!rawText) return { error: "prompt_body_empty" };

  const preview = rawText.slice(0, 120);
  const body    = rawText.length > 120
    ? (preview.lastIndexOf(" ") > 60
        ? preview.slice(0, preview.lastIndexOf(" "))
        : preview) + "…"
    : rawText;

  // ✅ No imageBase64 — FCM 4 KB limit. App fetches image from Firestore on tap via promptId.
  const extra = {
    promptId:    docSnap.id          ?? "",
    category:    doc?.category       ?? topic,
    authorName:  doc?.authorName     ?? "",
    authorPhoto: doc?.authorPhoto    ?? "",
    promptText:  rawText.slice(0, 300),
  };

  return { title, body, imageUrl: doc?.imageUrl ?? null, extra };
}

/* ======================================================
   FCM SEND — one or multicast
====================================================== */
async function sendFcm(tokens, { title, body, imageUrl, extra = {} }) {
  const baseMessage = {
    notification: { title, body, ...(imageUrl ? { image: imageUrl } : {}) },
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
   PROCESS ONE USER
====================================================== */
async function processUser({ uid, tokens, topic }) {
  try {
    const prompt = await getPrompt(topic);
    if (prompt.error) return { uid, status: "skipped", reason: prompt.error };

    const fcmResult = await sendFcm(tokens, prompt);

    const status =
      fcmResult.success.length > 0
        ? fcmResult.failed.length > 0 ? "partial" : "ok"
        : "failed";

    // Audit log (non-critical)
    await db
      .collection(`users/${uid}/notificationLog`)
      .add({
        sentAt:       new Date().toISOString(),
        topic,
        title:        prompt.title,
        body:         prompt.body,
        status,
        successCount: fcmResult.success.length,
        failCount:    fcmResult.failed.length,
        tokenCount:   tokens.length,
      })
      .catch(() => {});

    return { uid, status, topic, ...fcmResult };
  } catch (err) {
    return { uid, status: "error", reason: err.message };
  }
}

/* ======================================================
   API HANDLER — called by Vercel cron every 30 minutes
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

  /* ── Check if any schedule slot matches right now ── */
  // ?force=1 bypasses the time-window check (used by the console's "Run Now" button)
  const force = req.query?.force === "1" || req.body?.force === true;

  let matchedSlot;
  if (force) {
    matchedSlot = { id: "manual", label: "Manual Trigger", utcHour: -1, utcMinute: -1 };
    console.log("⚡  Force flag set — bypassing schedule window check");
  } else {
    matchedSlot = await getMatchingSlot();
  }

  if (!matchedSlot) {
    console.log(`⏭  ${new Date().toISOString()} — no slot matches, skipping`);
    return res.status(200).json({
      success: true,
      fired: false,
      message: "No scheduled slot matches current time",
    });
  }

  console.log(`⏰  Slot matched: ${matchedSlot.label ?? matchedSlot.id} (${matchedSlot.utcHour}:${String(matchedSlot.utcMinute).padStart(2,"0")} UTC)`);

  const stats = {
    slot:      matchedSlot.id,
    slotLabel: matchedSlot.label ?? matchedSlot.id,
    startedAt: new Date().toISOString(),
    total: 0, deduped: 0, ok: 0, partial: 0, skipped: 0, failed: 0, errors: 0,
  };

  try {
    /* 1. Fetch all valid users */
    const rawUsers   = await getAllUsers();
    stats.total      = rawUsers.length;
    console.log(`👥  Raw users with tokens: ${rawUsers.length}`);

    /* 2. Deduplicate devices */
    const dedupedUsers     = deduplicateUsers(rawUsers);
    const skippedDuplicates = dedupedUsers.filter(u => u.skip);
    stats.deduped = skippedDuplicates.length;
    console.log(`🔁  Duplicate devices skipped: ${skippedDuplicates.length}`);

    const toSend = dedupedUsers.filter(u => !u.skip);
    console.log(`📤  Sending to ${toSend.length} unique devices`);

    /* 3. Process in concurrent batches */
    for (let i = 0; i < toSend.length; i += CONCURRENCY) {
      const batch   = toSend.slice(i, i + CONCURRENCY);
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

    // Skipped duplicates count into stats
    stats.skipped += skippedDuplicates.length;
    stats.finishedAt = new Date().toISOString();
    console.log("📊  Stats:", stats);

    return res.status(200).json({ success: true, fired: true, stats });
  } catch (err) {
    console.error("❌  Cron fatal error:", err);
    return res.status(500).json({ success: false, error: err.message, stats });
  }
}
