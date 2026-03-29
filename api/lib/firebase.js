import admin from "firebase-admin";

export const config = { runtime: "nodejs" };

export function initFirebase() {
  // Already initialized — just return
  if (admin.apps.length > 0) return admin;

  const projectId    = process.env.FIREBASE_PROJECT_ID;
  const clientEmail  = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey   = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      `Missing Firebase env vars. Got: ` +
      `PROJECT_ID=${!!projectId}, CLIENT_EMAIL=${!!clientEmail}, PRIVATE_KEY=${!!privateKey}`
    );
  }

  // Vercel stores the key with literal \n — convert them to real newlines
  const formattedKey = privateKey.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: formattedKey,
    }),
  });

  console.log("🔥 Firebase Admin initialized:", projectId);
  return admin;
}

export function getFirestore() {
  return initFirebase().firestore();
}

export function getMessaging() {
  return initFirebase().messaging();
}
