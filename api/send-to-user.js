/**
 * api/send-to-user.js
 *
 * Sends the personalized notification to ONE specific user.
 * POST { uid: string }
 */
export const config = { runtime: "nodejs" };

import { initFirebase } from "../lib/firebase.js";
import { processUser } from "../lib/notifications.js";

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method Not Allowed" });

  // ── Init Firebase inside the handler — never at module load ──
  try {
    initFirebase();
  } catch (err) {
    console.error("❌ Firebase init failed:", err.message);
    return res.status(500).json({ success: false, error: `Firebase init failed: ${err.message}` });
  }

  const { uid } = req.body ?? {};
  if (!uid)
    return res.status(400).json({ success: false, error: "uid is required" });

  try {
    const result = await processUser(uid);
    const ok = result.status === "ok" || result.status === "partial";
    return res.status(ok ? 200 : 422).json({ success: ok, result });
  } catch (err) {
    console.error("❌ send-to-user error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
