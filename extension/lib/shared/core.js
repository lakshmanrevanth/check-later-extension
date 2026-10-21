// Shared logic used by both the web app and the Chrome extension.
// Canonical copy lives in /shared — `npm run sync` copies it to extension/lib/shared.

// ---------- Space codes ----------
// 32-char alphabet without look-alikes (no 0/O, 1/I). 12 chars ≈ 60 bits: unguessable.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

// Accepts messy input ("abcd efgh-jkmn", lowercase, spaces) and returns XXXX-XXXX-XXXX or null.
export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 12) return null;
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  return CODE_RE.test(code) ? code : null;
}

export const isValidCode = (code) => CODE_RE.test(code || '');

export function cleanUsername(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}

// ---------- Categories ----------
export const DEFAULT_CATEGORIES = [
  { id: 'read', name: 'Read', emoji: '📖' },
  { id: 'watch', name: 'Watch', emoji: '🎬' },
  { id: 'work', name: 'Work', emoji: '💼' },
  { id: 'shopping', name: 'Shopping', emoji: '🛒' },
  { id: 'docs', name: 'Docs', emoji: '📄' },
  { id: 'other', name: 'Other', emoji: '📌' },
];

// Smart categorisation: domain → default category id.
const DOMAIN_RULES = [
  [/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|netflix\.com|twitch\.tv|primevideo\.com|hotstar\.com|tiktok\.com)$/, 'watch'],
  [/(^|\.)(amazon\.[a-z.]+|flipkart\.com|ebay\.[a-z.]+|etsy\.com|myntra\.com|aliexpress\.com|walmart\.com|meesho\.com|ajio\.com)$/, 'shopping'],
  [/(^|\.)(docs\.google\.com|drive\.google\.com|notion\.so|notion\.site|dropbox\.com|figma\.com|onedrive\.live\.com|sharepoint\.com|scribd\.com)$/, 'docs'],
  [/(^|\.)(github\.com|gitlab\.com|atlassian\.net|linear\.app|slack\.com|linkedin\.com|stackoverflow\.com|trello\.com)$/, 'work'],
  [/(^|\.)(medium\.com|substack\.com|dev\.to|wikipedia\.org|news\.ycombinator\.com|reddit\.com|hashnode\.dev|nytimes\.com|bbc\.co\.uk|theguardian\.com)$/, 'read'],
];

export function suggestCategory(url, categories = DEFAULT_CATEGORIES) {
  const ids = new Set(categories.map((c) => c.id));
  const domain = getDomain(url);
  let guess = /\.pdf($|\?)/i.test(url || '') ? 'docs' : null;
  if (!guess) for (const [re, id] of DOMAIN_RULES) if (re.test(domain)) { guess = id; break; }
  if (guess && ids.has(guess)) return guess;
  if (ids.has('read') && guess === null) return 'read';
  return categories[0]?.id || 'other';
}

export function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `cat-${Date.now()}`;
}

// ---------- URLs ----------
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[),.;!?]+$/, '') : null;
}

export function isSavableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Strip tracking params so the same article saved twice is detected as a duplicate.
export function cleanUrl(url) {
  try {
    const u = new URL(url.trim());
    [...u.searchParams.keys()].forEach((k) => {
      if (/^(utm_|fbclid$|gclid$|igshid$|mc_|ref_src$|si$)/i.test(k)) u.searchParams.delete(k);
    });
    return u.toString();
  } catch {
    return String(url || '').trim();
  }
}

export const faviconFor = (url) => {
  const d = getDomain(url);
  return d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : '';
};

// ---------- Items ----------
// Shape of a saved item (timestamps are added by each client).
// remindAt is reserved for the reminder feature (phase 2).
export function buildItem({ url, title, note = '', category, source }) {
  const clean = cleanUrl(url);
  return {
    url: clean,
    title: String(title || getDomain(clean) || clean).trim().slice(0, 300),
    note: String(note || '').trim().slice(0, 2000),
    category: category || 'other',
    domain: getDomain(clean),
    favicon: faviconFor(clean),
    source: source || 'web',
    status: 'unread',
    pinned: false,
    remindAt: null,
  };
}

export function timeAgo(date) {
  if (!date) return 'just now';
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  const units = [[60, 'm'], [24, 'h'], [7, 'd'], [4.35, 'w'], [12, 'mo'], [Infinity, 'y']];
  let v = s / 60;
  for (const [step, label] of units) {
    if (v < step) return `${Math.floor(v)}${label} ago`;
    v /= step;
  }
  return '';
}
