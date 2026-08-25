import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabaseWithUrl, type Database } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";

export const firebaseApp = getApps()[0] ?? initializeApp();

export const firestore = getFirestore(firebaseApp);
firestore.settings({ ignoreUndefinedProperties: true });

export function bridgeRealtimeDatabase(): Database {
  const databaseUrl = process.env.BRIDGE_REALTIME_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("BRIDGE_REALTIME_DATABASE_URL is not configured");
  }
  return getDatabaseWithUrl(databaseUrl, firebaseApp);
}
