// Data layer for the web app (Firebase JS SDK, realtime + offline cache).
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, orderBy, onSnapshot, getDocFromServer, runTransaction,
  addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { firebaseConfig } from '@shared/config.js';
import { generateCode, cleanUsername, DEFAULT_CATEGORIES, buildItem } from '@shared/core.js';

let db;
let auth;

export async function initFirebase() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
}

const spaceRef = (code) => doc(db, 'spaces', code);
const itemsRef = (code) => collection(db, 'spaces', code, 'items');

// ---------- Spaces ----------
export async function fetchSpace(code) {
  const snap = await getDocFromServer(spaceRef(code));
  return snap.exists() ? snap.data() : null;
}

export async function createSpace(username) {
  const name = cleanUsername(username);
  if (name.length < 2) throw new Error('Name must be at least 2 characters.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const created = await runTransaction(db, async (tx) => {
      const snap = await tx.get(spaceRef(code));
      if (snap.exists()) return false;
      tx.set(spaceRef(code), { username: name, createdAt: serverTimestamp(), categories: DEFAULT_CATEGORIES });
      return true;
    });
    if (created) return { code, username: name };
  }
  throw new Error('Could not create a code. Try again.');
}

export function watchSpace(code, cb, onError) {
  return onSnapshot(spaceRef(code), (snap) => cb(snap.exists() ? snap.data() : null), onError);
}

export function setCategories(code, categories) {
  return updateDoc(spaceRef(code), { categories });
}

// ---------- Items ----------
export function watchItems(code, cb, onError) {
  const q = query(itemsRef(code), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const items = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: 'estimate' });
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(),
          pendingSync: d.metadata.hasPendingWrites,
        };
      });
      cb(items, { fromCache: snap.metadata.fromCache });
    },
    onError,
  );
}

export function addItem(code, fields) {
  return addDoc(itemsRef(code), {
    ...buildItem(fields),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function updateItem(code, id, patch) {
  return updateDoc(doc(itemsRef(code), id), { ...patch, updatedAt: serverTimestamp() });
}

export function deleteItem(code, id) {
  return deleteDoc(doc(itemsRef(code), id));
}

// Used by "Undo" after a delete: put the exact item back with its original id.
export function restoreItem(code, item) {
  const { id, pendingSync, createdAt, ...rest } = item;
  return setDoc(doc(itemsRef(code), id), { ...rest, createdAt, updatedAt: serverTimestamp() });
}

export async function moveItems(code, ids, category) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    ids.slice(i, i + 400).forEach((id) => batch.update(doc(itemsRef(code), id), { category, updatedAt: serverTimestamp() }));
    await batch.commit();
  }
}
