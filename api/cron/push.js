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

/* 
  WINDOW_MINS: The max duration AFTER a scheduled time that a cron will pick it up.
  Set to 35 min to ensure a cron running every 30 minutes never misses a slot, 
  while strictly preventing early triggers.
*/
const WINDOW_MINS   = 35; 

/* ======================================================
   SCHEDULE CHECK (IMPROVED & FIXED)
   Strictly fires ONLY if time has arrived. Uses Firestore
   state to guarantee exactly 1 execution per day avoiding spam.
====================================================== */
async function getMatchingSlot() {
  const snap = await db.doc(SCHEDULE_DOC).get();
  if (!snap.exists) return { slot: null };

  const data = snap.data();
  const slots = data.slots || [];

  const now       = new Date();
  const todayStr  = now.toISOString().split("T")[0]; // UTC Date
  const nowMins   = now.getUTCHours() * 60 + now.getUTCMinutes();

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot.enabled) continue;

    const slotMins = (slot.utcHour ?? 0) * 60 + (slot.utcMinute ?? 0);
    
    // Calculate minutes passed SINCE scheduled time
    let minsPassed = nowMins - slotMins;
    if (minsPassed < -720) minsPassed += 1440; // wrap over midnight

    // Only fire if the scheduled time HAS COMPLETELY ARRIVED, and isn't too old
    if (minsPassed >= 0 && minsPassed <= WINDOW_MINS) {
      
      // ✅ Critical fix: ensure we haven't already fired this slot today
      if (slot.lastFiredDate === todayStr) {
        console.log(`⏱️ Slot ${slot.id} already fired today (${todayStr}), skipping duplicate.`);
        continue;
      }

      // Mark slot as fired today so subsequent crons don't duplicate it
      slots[i].lastFiredDate = todayStr;
      
      // We return both so it updates the database immediately tracking the fire
      return { slot, slotsArrayToSave: slots }; 
    }
  }

  return { slot: null };
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
====================================================== */
function deduplicateUsers(users) {
  const tokenOwner = new Map(); // token → uid of first claimer
  const dedupedUsers = [];

  for (const user of users) {
    const uniqueOwn = [...new Set(user.tokens)];
    const freshTokens = uniqueOwn.filter((t) => {
      if (tokenOwner.has(t)) return false; 
      tokenOwner.set(t, user.uid);
      return true;
    });

    if (freshTokens.length === 0) {
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
   API HANDLER — called by Vercel cron
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
  const force = req.query?.force === "1" || req.body?.force === true;

  let matchedSlot;
  let slotsToUpdate = null;

  if (force) {
    matchedSlot = { id: "manual", label: "Manual Trigger", utcHour: -1, utcMinute: -1 };
    console.log("⚡  Force flag set — bypassing schedule window check");
  } else {
    // Rely on updated and strict logic
    const resSlot = await getMatchingSlot();
    matchedSlot = resSlot.slot;
    slotsToUpdate = resSlot.slotsArrayToSave;
  }

  if (!matchedSlot) {
    console.log(`⏭  ${new Date().toISOString()} — no slot matches, skipping`);
    return res.status(200).json({
      success: true,
      fired: false,
      message: "No scheduled slot matches current time",
    });
  }

  // ✅ Immediately log the "fired" state to the database to avert double triggers
  if (slotsToUpdate) {
    await db.doc(SCHEDULE_DOC).update({ slots: slotsToUpdate }).catch(console.error);
  }

  console.log(`⏰  Slot matched: ${matchedSlot.label ?? matchedSlot.id}`);

  const stats = {
    slot:      matchedSlot.id,
    slotLabel: matchedSlot.label ?? matchedSlot.id,
    startedAt: new Date().toISOString(),
    total: 0, deduped: 0, ok: 0, partial: 0, skipped: 0, failed: 0, errors: 0,
  };

  try {
    const rawUsers   = await getAllUsers();
    stats.total      = rawUsers.length;
    console.log(`👥  Raw users with tokens: ${rawUsers.length}`);

    const dedupedUsers     = deduplicateUsers(rawUsers);
    const skippedDuplicates = dedupedUsers.filter(u => u.skip);
    stats.deduped = skippedDuplicates.length;
    console.log(`🔁  Duplicate devices skipped: ${skippedDuplicates.length}`);

    const toSend = dedupedUsers.filter(u => !u.skip);
    console.log(`📤  Sending to ${toSend.length} unique devices`);

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

    stats.skipped += skippedDuplicates.length;
    stats.finishedAt = new Date().toISOString();
    console.log("📊  Stats:", stats);

    return res.status(200).json({ success: true, fired: true, stats });
  } catch (err) {
    console.error("❌  Cron fatal error:", err);
    return res.status(500).json({ success: false, error: err.message, stats });
  }
}
