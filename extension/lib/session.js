// The linked space for this browser, stored in chrome.storage.local.
import { DEFAULT_CATEGORIES } from './shared/core.js';

export async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null; // { code, username, categories }
}

export async function setSession(session) {
  await chrome.storage.local.set({
    session: { code: session.code, username: session.username, categories: session.categories || DEFAULT_CATEGORIES },
  });
}

export async function clearSession() {
  await chrome.storage.local.remove('session');
}
