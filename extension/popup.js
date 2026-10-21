import { isConfigured, WEB_APP_URL } from './lib/shared/config.js';
import { normalizeCode, suggestCategory, isSavableUrl, faviconFor, timeAgo, getDomain } from './lib/shared/core.js';
import { getSpace, createSpace, addItem, findByUrl, recentItems } from './lib/api.js';
import { getSession, setSession, clearSession } from './lib/session.js';

const $ = (id) => document.getElementById(id);
const views = ['viewSetup', 'viewAuth', 'viewMain', 'viewSaved'];
const show = (id) => views.forEach((v) => ($(v).hidden = v !== id));

let session = null;
let tab = null;
let selectedCat = null;

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/PERMISSION_DENIED/i.test(m)) return 'Permission denied. Did you deploy firestore.rules?';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'You seem to be offline.';
  return m;
}

// ---------- Auth view ----------
function initAuth() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('formSignin').hidden = t.dataset.tab !== 'signin';
      $('formSignup').hidden = t.dataset.tab !== 'signup';
      showError($('authError'), '');
    }),
  );

  $('codeInput').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    e.target.value = raw.match(/.{1,4}/g)?.join('-') || '';
  });

  $('formSignin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = normalizeCode($('codeInput').value);
    if (!code) return showError($('authError'), 'That code doesn’t look right. It has 12 letters and numbers.');
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const space = await getSpace(code);
      if (!space) return showError($('authError'), 'No space found for that code.');
      await setSession({ code, username: space.username, categories: space.categories });
      await enterMain();
    } catch (err) {
      showError($('authError'), friendly(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('formSignup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const space = await createSpace($('nameInput').value);
      await setSession(space);
      $('formSignup').hidden = true;
      document.querySelector('.tabs').hidden = true;
      $('newCodeValue').textContent = space.code;
      $('newCode').hidden = false;
      showError($('authError'), '');
    } catch (err) {
      showError($('authError'), friendly(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('newCodeDone').addEventListener('click', enterMain);
}

// ---------- Main view ----------
function renderCategories() {
  const wrap = $('categories');
  wrap.replaceChildren(
    ...session.categories.map((c) => {
      const b = document.createElement('button');
      b.className = 'cat';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === selectedCat));
      b.textContent = `${c.emoji} ${c.name}`;
      b.addEventListener('click', () => {
        selectedCat = c.id;
        renderCategories();
      });
      return b;
    }),
  );
}

async function renderRecent() {
  try {
    const items = await recentItems(session.code, 5);
    $('recentWrap').hidden = items.length === 0;
    $('recent').replaceChildren(
      ...items.map((it) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = isSavableUrl(it.url) ? it.url : '#';
        a.target = '_blank';
        const img = Object.assign(document.createElement('img'), { src: it.favicon || '', width: 16, height: 16, alt: '' });
        const span = Object.assign(document.createElement('span'), { textContent: it.title || it.url });
        const small = Object.assign(document.createElement('small'), { textContent: timeAgo(it.createdAt) });
        a.append(img, span, small);
        li.append(a);
        return li;
      }),
    );
  } catch {
    $('recentWrap').hidden = true;
  }
}

async function enterMain() {
  session = await getSession();
  show('viewMain');
  $('codeChip').hidden = false;
  $('codeChip').textContent = session.code;
  $('whoami').textContent = session.username;
  $('openApp').href = WEB_APP_URL;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const ok = isSavableUrl(url);
  $('titleInput').value = tab?.title || '';
  $('pageUrl').textContent = ok ? getDomain(url) + new URL(url).pathname : 'This page can’t be saved';
  $('pageIcon').src = tab?.favIconUrl || faviconFor(url);
  $('saveBtn').disabled = !ok;

  selectedCat = suggestCategory(url, session.categories);
  renderCategories();
  renderRecent();

  // Pull the latest categories (they may have been edited on another device).
  getSpace(session.code)
    .then(async (space) => {
      if (!space) return;
      const changed = JSON.stringify(space.categories) !== JSON.stringify(session.categories);
      if (changed) {
        session.categories = space.categories;
        await setSession(session);
        if (!session.categories.some((c) => c.id === selectedCat)) selectedCat = suggestCategory(url, session.categories);
        renderCategories();
      }
    })
    .catch(() => {});

  if (ok) {
    findByUrl(session.code, url)
      .then((hit) => {
        if (!hit) return;
        $('dupHint').textContent = `Already saved ${timeAgo(hit.createdAt)}${hit.status === 'done' ? ' (marked done)' : ''}. Saving again adds a new entry.`;
        $('dupHint').hidden = false;
      })
      .catch(() => {});
  }
}

async function save() {
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  showError($('saveError'), '');
  try {
    await addItem(session.code, {
      url: tab.url,
      title: $('titleInput').value,
      note: $('noteInput').value,
      category: selectedCat,
      source: 'extension',
    });
    const cat = session.categories.find((c) => c.id === selectedCat);
    $('savedMsg').textContent = `Saved to ${cat ? `${cat.emoji} ${cat.name}` : 'CheckLater'}`;
    show('viewSaved');
    setTimeout(() => window.close(), 1100);
  } catch (e) {
    showError($('saveError'), friendly(e));
    btn.disabled = false;
    btn.textContent = 'Save to CheckLater';
  }
}

// ---------- Boot ----------
$('saveBtn').addEventListener('click', save);
$('noteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
});
$('codeChip').addEventListener('click', async () => {
  await navigator.clipboard.writeText(session.code);
  $('codeChip').textContent = 'Copied!';
  setTimeout(() => ($('codeChip').textContent = session.code), 1200);
});
$('signOut').addEventListener('click', async () => {
  if (!confirm('Unlink this browser? Your saved links stay safe under your code.')) return;
  await clearSession();
  location.reload();
});

(async () => {
  if (!isConfigured()) return show('viewSetup');
  initAuth();
  if (await getSession()) await enterMain();
  else show('viewAuth');
})();
