import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}

function requiredEnvironment(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
}

export function firebaseApp(): FirebaseApp {
  if (getApps().length > 0) return getApp();
  return initializeApp({
    apiKey: requiredEnvironment("NEXT_PUBLIC_FIREBASE_API_KEY", process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
    authDomain: requiredEnvironment("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    projectId: requiredEnvironment("NEXT_PUBLIC_FIREBASE_PROJECT_ID", process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: requiredEnvironment("NEXT_PUBLIC_FIREBASE_APP_ID", process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
  });
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

export function firebaseFirestore(): Firestore {
  return getFirestore(firebaseApp());
}

export function firebaseFunctions(): Functions {
  return getFunctions(firebaseApp(), process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION ?? "asia-south1");
}
