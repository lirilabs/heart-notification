/**
 * api/send-notification.js
 *
 * Manual / on-demand FCM send.
 * POST { token, title, body, imageUrl?, clickAction?, data? }
 */

export const config = { runtime: "nodejs" };

import { initFirebase } from "../lib/firebase.js";
import { sendFcmToTokens } from "../lib/notifications.js";

initFirebase();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method Not Allowed" });

  const { token, title, body, imageUrl, clickAction, data = {} } = req.body ?? {};

  if (!token || !title || !body)
    return res
      .status(400)
      .json({ success: false, error: "token, title, and body are required" });

  try {
    const tokens = Array.isArray(token) ? token : [token];
    const result = await sendFcmToTokens(tokens, {
      title,
      body,
      imageUrl,
      data: { ...(clickAction ? { click_action: clickAction } : {}), ...data },
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("❌ FCM ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}/**
 * api/send-notification.js
 *
 * Manual / on-demand FCM send.
 * POST { token, title, body, imageUrl?, clickAction?, data? }
 */

export const config = { runtime: "nodejs" };

import { initFirebase } from "../lib/firebase.js";
import { sendFcmToTokens } from "../lib/notifications.js";

initFirebase();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method Not Allowed" });

  const { token, title, body, imageUrl, clickAction, data = {} } = req.body ?? {};

  if (!token || !title || !body)
    return res
      .status(400)
      .json({ success: false, error: "token, title, and body are required" });

  try {
    const tokens = Array.isArray(token) ? token : [token];
    const result = await sendFcmToTokens(tokens, {
      title,
      body,
      imageUrl,
      data: { ...(clickAction ? { click_action: clickAction } : {}), ...data },
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("❌ FCM ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
