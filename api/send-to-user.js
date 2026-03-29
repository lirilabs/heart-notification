/**
 * api/send-to-user.js
 *
 * Sends the personalized morning notification to ONE specific user.
 * Useful for testing, re-sends, or triggered pushes from your app.
 *
 * POST { uid: string }
 */

export const config = { runtime: "nodejs" };

import { initFirebase } from "../lib/firebase.js";
import { processUser } from "../lib/notifications.js";

initFirebase();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method Not Allowed" });

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
