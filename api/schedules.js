import admin from "firebase-admin";

export const config = { runtime: "nodejs" };

/* ── Firebase init ── */
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
}

const db = admin.firestore();
const SCHEDULE_DOC = "config/schedules";

/* ── Auth helper ── */
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret set → open (dev mode)
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${secret}`;
}

/* ════════════════════════════════════════════════════
   GET  /api/schedules
   Returns current schedule slots from Firestore.

   Response shape:
   {
     slots: [
       { id: "slot_1", label: "Morning",   utcHour: 6,  utcMinute: 30, enabled: true  },
       { id: "slot_2", label: "Afternoon", utcHour: 11, utcMinute: 0,  enabled: true  },
       { id: "slot_3", label: "Evening",   utcHour: 14, utcMinute: 30, enabled: false },
       { id: "slot_4", label: "Night",     utcHour: 17, utcMinute: 0,  enabled: false }
     ],
     timezone: "Asia/Kolkata"   // display TZ for the UI — actual firing is always UTC
   }
════════════════════════════════════════════════════ */
async function handleGet(req, res) {
  const snap = await db.doc(SCHEDULE_DOC).get();

  if (!snap.exists) {
    // Return sensible defaults (12:00, 15:00, 18:00, 21:00 IST = 6:30, 9:30, 12:30, 15:30 UTC)
    const defaults = {
      slots: [
        { id: "slot_1", label: "Morning",   utcHour: 6,  utcMinute: 30, enabled: true  },
        { id: "slot_2", label: "Afternoon", utcHour: 9,  utcMinute: 30, enabled: false },
        { id: "slot_3", label: "Evening",   utcHour: 12, utcMinute: 30, enabled: false },
        { id: "slot_4", label: "Night",     utcHour: 15, utcMinute: 30, enabled: false },
      ],
      timezone: "Asia/Kolkata",
    };
    return res.status(200).json({ success: true, ...defaults });
  }

  return res.status(200).json({ success: true, ...snap.data() });
}

/* ════════════════════════════════════════════════════
   POST /api/schedules
   Save schedule slots to Firestore.

   Body shape:
   {
     slots: [
       { id: "slot_1", label: "Morning",   utcHour: 6,  utcMinute: 30, enabled: true  },
       ...up to 4 slots
     ],
     timezone: "Asia/Kolkata"
   }
════════════════════════════════════════════════════ */
async function handlePost(req, res) {
  if (!isAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  const { slots, timezone } = req.body ?? {};

  if (!Array.isArray(slots) || slots.length === 0)
    return res.status(400).json({ error: "slots array is required" });

  if (slots.length > 4)
    return res.status(400).json({ error: "Maximum 4 slots allowed" });

  // Validate each slot
  for (const s of slots) {
    if (typeof s.utcHour !== "number" || s.utcHour < 0 || s.utcHour > 23)
      return res.status(400).json({ error: `Invalid utcHour in slot ${s.id}` });
    if (typeof s.utcMinute !== "number" || s.utcMinute < 0 || s.utcMinute > 59)
      return res.status(400).json({ error: `Invalid utcMinute in slot ${s.id}` });
  }

  const payload = {
    slots,
    timezone: timezone ?? "Asia/Kolkata",
    updatedAt: new Date().toISOString(),
  };

  await db.doc(SCHEDULE_DOC).set(payload, { merge: true });

  return res.status(200).json({ success: true, saved: payload });
}

/* ── Router ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET")  return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return res.status(405).json({ error: "Method Not Allowed" });
}
