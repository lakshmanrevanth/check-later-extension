// Tiny Firebase client over REST (no bundler needed in the extension).
// Auth: anonymous Firebase Auth. Data: Firestore REST v1.
import { firebaseConfig } from './shared/config.js';
import { generateCode, cleanUsername, DEFAULT_CATEGORIES, buildItem, cleanUrl } from './shared/core.js';

const KEY = firebaseConfig.apiKey;
const DOCS = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

// ---------- Auth ----------
let tokenPromise = null;

async function fetchToken() {
  const { auth } = await chrome.storage.local.get('auth');
  if (auth && auth.expiresAt > Date.now() + 60_000) return auth.idToken;

  let next = null;
  if (auth?.refreshToken) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
    });
    if (res.ok) {
      const j = await res.json();
      next = { idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
    }
  }
  if (!next) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!res.ok) throw new Error(await errorText(res, 'Could not reach Firebase Auth. Is Anonymous sign-in enabled?'));
    const j = await res.json();
    next = { idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: j.expiresIn };
  }
  const saved = { idToken: next.idToken, refreshToken: next.refreshToken, expiresAt: Date.now() + Number(next.expiresIn) * 1000 };
  await chrome.storage.local.set({ auth: saved });
  return saved.idToken;
}

function getToken() {
  tokenPromise ??= fetchToken().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function errorText(res, fallback) {
  try {
    const j = await res.json();
    return j?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(`${DOCS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(await errorText(res, `Request failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Firestore value encoding ----------
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}

export const toFields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toValue(v)]));

export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}

export const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));

const fromDoc = (doc) => ({ id: doc.name.split('/').pop(), ...fromFields(doc.fields) });

// ---------- Spaces ----------
export async function getSpace(code) {
  const doc = await call(`/spaces/${code}`);
  return doc ? fromDoc(doc) : null;
}

export async function createSpace(username) {
  const name = cleanUsername(username);
  if (name.length < 2) throw new Error('Name must be at least 2 characters.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await call(`/spaces?documentId=${code}`, {
        method: 'POST',
        body: { fields: toFields({ username: name, createdAt: new Date(), categories: DEFAULT_CATEGORIES }) },
      });
      return { code, username: name, categories: DEFAULT_CATEGORIES };
    } catch (e) {
      if (e.status !== 409) throw e; // 409 = code already taken, try another
    }
  }
  throw new Error('Could not create a code. Try again.');
}

// ---------- Items ----------
export async function addItem(code, fields) {
  const now = new Date();
  const item = { ...buildItem(fields), createdAt: now, updatedAt: now };
  const doc = await call(`/spaces/${code}/items`, { method: 'POST', body: { fields: toFields(item) } });
  return fromDoc(doc);
}

export async function findByUrl(code, url) {
  const rows = await call(`/spaces/${code}:runQuery`, {
    method: 'POST',
    body: {
      structuredQuery: {
        from: [{ collectionId: 'items' }],
        where: { fieldFilter: { field: { fieldPath: 'url' }, op: 'EQUAL', value: { stringValue: cleanUrl(url) } } },
        limit: 1,
      },
    },
  });
  const hit = (rows || []).find((r) => r.document);
  return hit ? fromDoc(hit.document) : null;
}

export async function recentItems(code, n = 5) {
  const res = await call(`/spaces/${code}/items?orderBy=createdAt%20desc&pageSize=${n}`);
  return (res?.documents || []).map(fromDoc);
}
