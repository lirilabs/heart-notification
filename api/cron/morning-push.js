/**
 * api/cron/morning-push.js
 *
 * Vercel Cron Job — runs every day at 06:30 UTC (12:00 PM IST).
 * Declare in vercel.json:
 *   { "crons": [{ "path": "/api/cron/morning-push", "schedule": "30 6 * * *" }] }
 */
export const config = { runtime: "nodejs" };

import { initFirebase } from "../../lib/firebase.js";
import { getAllUserIds, processUser } from "../../lib/notifications.js";

const CONCURRENCY = Number(process.env.FCM_CONCURRENCY ?? 20);

export default async function handler(req, res) {
  // ── Security ──
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  // ── Init Firebase inside the handler ──
  try {
    initFirebase();
  } catch (err) {
    console.error("❌ Firebase init failed:", err.message);
    return res.status(500).json({ success: false, error: `Firebase init failed: ${err.message}` });
  }

  console.log(`⏰  Morning push started at ${new Date().toISOString()}`);

  const stats = {
    startedAt: new Date().toISOString(),
    total: 0,
    ok: 0,
    partial: 0,
    skipped: 0,
    failed: 0,
    errors: 0,
  };

  try {
    const uids = await getAllUserIds();
    stats.total = uids.length;
    console.log(`👥  Found ${uids.length} users`);

    for (let i = 0; i < uids.length; i += CONCURRENCY) {
      const batch = uids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((uid) => processUser(uid)));

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

      console.log(
        `  ✔ Batch ${Math.ceil((i + CONCURRENCY) / CONCURRENCY)} done` +
        ` (${Math.min(i + CONCURRENCY, uids.length)}/${uids.length})`
      );
    }

    stats.finishedAt = new Date().toISOString();
    console.log("📊  Stats:", stats);
    return res.status(200).json({ success: true, stats });
  } catch (err) {
    console.error("❌  Cron fatal error:", err);
    return res.status(500).json({ success: false, error: err.message, stats });
  }
}
