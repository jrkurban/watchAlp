import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getStorage } from "firebase/storage";
import config from "../../firebase-applet-config.json";

// Initialize Firebase
const app = initializeApp(config);

export const db = getFirestore(app, config.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);

// Authenticate anonymously
export const initAuth = async () => {
  try {
    await signInAnonymously(auth);
  } catch (error) {
    console.error("Firebase auth error:", error);
  }
};
