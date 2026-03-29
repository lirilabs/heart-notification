import admin from "firebase-admin";

export const config = { runtime: "nodejs" };

let initialized = false;

export function initFirebase() {
  if (initialized || admin.apps.length > 0) return admin;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "Missing Firebase ENV vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  initialized = true;
  console.log("🔥 Firebase Admin initialized:", FIREBASE_PROJECT_ID);
  return admin;
}

export function getFirestore() {
  return initFirebase().firestore();
}

export function getMessaging() {
  return initFirebase().messaging();
}
