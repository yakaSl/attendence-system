import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = getApps()[0] ?? initializeApp();

export const firestore = getFirestore(app);
firestore.settings({ ignoreUndefinedProperties: true });
