import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  User,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  Firestore,
  doc,
  getDocFromServer,
  getFirestore,
} from 'firebase/firestore';
import appletConfig from '../../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

const envApiKey = import.meta.env.VITE_FIREBASE_API_KEY;
const envProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const envAuthDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
const envStorageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
const envMessagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
const envAppId = import.meta.env.VITE_FIREBASE_APP_ID;
const envDatabaseId = import.meta.env.VITE_FIREBASE_DATABASE_ID;

const useEnvConfig = Boolean(envApiKey && envProjectId);

export const activeFirebaseConfig = useEnvConfig
  ? {
      apiKey: envApiKey,
      authDomain: envAuthDomain || `${envProjectId}.firebaseapp.com`,
      projectId: envProjectId,
      storageBucket: envStorageBucket || `${envProjectId}.firebasestorage.app`,
      messagingSenderId: envMessagingSenderId || '',
      appId: envAppId || '',
      firestoreDatabaseId: envDatabaseId || '(default)',
    }
  : {
      ...appletConfig,
      firestoreDatabaseId:
        envDatabaseId || appletConfig.firestoreDatabaseId || '(default)',
    };

export const isFirebaseConfigured = Boolean(
  activeFirebaseConfig.apiKey &&
    activeFirebaseConfig.projectId &&
    activeFirebaseConfig.projectId !== 'remixed-project-id'
);

let appInstance: FirebaseApp | null = null;
let dbInstance: Firestore | null = null;
let authInstance: Auth | null = null;

if (isFirebaseConfigured) {
  appInstance = initializeApp(activeFirebaseConfig);
  // If databaseId is "(default)" or empty, pass "(default)" or activeFirebaseConfig.firestoreDatabaseId
  dbInstance = getFirestore(
    appInstance,
    activeFirebaseConfig.firestoreDatabaseId
  );
  authInstance = getAuth(appInstance);
}

export const app = appInstance;
export const db = dbInstance;
export const auth = authInstance;

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  if (!db) return false;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    // Permission denied on test/connection confirms connectivity to Firestore server
    return true;
  }
}

export async function signInWithGooglePilot(): Promise<User> {
  if (!auth) {
    throw new Error(
      'Firebase não está configurado. O aplicativo continuará operando no Piloto Local.'
    );
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOutPilot(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

export function subscribeToPilotAuth(
  callback: (user: User | null) => void
): () => void {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}
