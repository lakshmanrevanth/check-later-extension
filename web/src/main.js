import QRCode from 'qrcode';
import { isConfigured } from '@shared/config.js';
import {
  DEFAULT_CATEGORIES, normalizeCode, suggestCategory, extractUrl, isSavableUrl,
  cleanUrl, getDomain, faviconFor, timeAgo, slugify,
} from '@shared/core.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['viewSetup', 'viewLoading', 'viewWelcome', 'viewApp'];
const show = (id) => VIEWS.forEach((v) => ($(v).hidden = v !== id));

const SESSION_KEY = 'checklater.session';
const PENDING_SHARE_KEY = 'checklater.pendingShare';

const state = {
  session: null, // { code, username }
  categories: DEFAULT_CATEGORIES,
  items: [],
  filter: 'all',
  view: 'unread',
  q: '',
  unsubs: [],
};

// ---------- Helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeHref = (url) => (isSavableUrl(url) ? url : '#');
const UNCATEGORIZED = { id: '__none', name: 'Uncategorized', emoji: '❔' };
const catOf = (item) => state.categories.find((c) => c.id === item.category) || UNCATEGORIZED;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

let toastTimer;
function toast(msg, action) {
  $('toastMsg').textContent = msg;
  const btn = $('toastAction');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      $('toast').hidden = true;
      action.run();
    };
  }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), action ? 5000 : 2500);
}

function friendly(e) {
  const m = String(e?.code || e?.message || e);
  if (/permission/i.test(m)) return 'Permission denied. Check that firestore.rules are deployed.';
  if (/unavailable|offline|network/i.test(m)) return 'You seem to be offline. Try again when connected.';
  if (/admin-restricted|operation-not-allowed/i.test(m)) return 'Enable Anonymous sign-in in Firebase Authentication.';
  return e?.message || m;
}

// ---------- Share target & deep links ----------
// Android "Share → CheckLater" opens /share?title=&text=&url= (see manifest.webmanifest).
function captureIncoming() {
  const url = new URL(location.href);
  let pendingCode = null;
  if (url.pathname === '/share') {
    const shared = {
      title: url.searchParams.get('title') || '',
      text: url.searchParams.get('text') || '',
      url: url.searchParams.get('url') || '',
    };
    sessionStorage.setItem(PENDING_SHARE_KEY, JSON.stringify(shared));
  }
  if (url.searchParams.get('code')) pendingCode = normalizeCode(url.searchParams.get('code'));
  if (url.pathname !== '/' || url.search) history.replaceState(null, '', '/');
  return pendingCode;
}

function takePendingShare() {
  const raw = sessionStorage.getItem(PENDING_SHARE_KEY);
  sessionStorage.removeItem(PENDING_SHARE_KEY);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const link = (isSavableUrl(s.url) && s.url) || extractUrl(s.text) || extractUrl(s.title) || '';
  // Apps often send "Some caption https://link". The caption (minus the link) becomes the note.
  const rest = s.text.replace(link, '').trim();
  return {
    url: link,
    title: s.title && s.title !== link ? s.title : '',
    note: rest && rest !== s.title ? rest : '',
  };
}

// ---------- Welcome ----------
function initWelcome() {
  document.querySelectorAll('#viewWelcome .seg').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('#viewWelcome .seg').forEach((x) => x.classList.toggle('active', x === t));
      $('formSignin').hidden = t.dataset.tab !== 'signin';
      $('formSignup').hidden = t.dataset.tab !== 'signup';
      setAuthError('');
    }),
  );

  $('codeInput').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    e.target.value = raw.match(/.{1,4}/g)?.join('-') || '';
  });

  $('formSignin').addEventListener('submit', (e) => {
    e.preventDefault();
    signIn($('codeInput').value, e.submitter);
  });

  $('formSignup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const { code, username } = await db.createSpace($('nameInput').value);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ code, username }));
      $('formSignup').hidden = true;
      document.querySelector('#viewWelcome .segmented').hidden = true;
      $('newCodeValue').textContent = code;
      $('newCode').hidden = false;
      setAuthError('');
    } catch (err) {
      setAuthError(friendly(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('newCodeCopy').addEventListener('click', () => copy($('newCodeValue').textContent));
  $('newCodeDone').addEventListener('click', enterApp);
}

function setAuthError(msg) {
  $('authError').textContent = msg;
  $('authError').hidden = !msg;
}

async function signIn(input, btn) {
  const code = normalizeCode(input);
  if (!code) return setAuthError('That code doesn’t look right. It has 12 letters and numbers, like ABCD-EFGH-JKMN.');
  if (btn) btn.disabled = true;
  try {
    const space = await db.fetchSpace(code);
    if (!space) return setAuthError('No space found for that code.');
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, username: space.username }));
    await enterApp();
  } catch (err) {
    setAuthError(friendly(err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- App ----------
async function enterApp() {
  state.session = loadSession();
  if (!state.session) return show('viewWelcome');
  show('viewApp');
  $('accountBtn').textContent = (state.session.username || '?').charAt(0).toUpperCase();

  state.unsubs.forEach((u) => u());
  state.unsubs = [
    db.watchSpace(state.session.code, (space) => {
      if (!space) return; // offline first-load; keep defaults
      state.categories = space.categories?.length ? space.categories : DEFAULT_CATEGORIES;
      if (space.username && space.username !== state.session.username) {
        state.session.username = space.username;
        localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
      }
      render();
    }, (e) => toast(friendly(e))),
    db.watchItems(state.session.code, (items, meta) => {
      state.items = items;
      const dot = $('syncDot');
      const pending = items.some((i) => i.pendingSync);
      dot.className = `sync-dot${!navigator.onLine || meta.fromCache ? ' offline' : pending ? ' pending' : ''}`;
      dot.title = !navigator.onLine ? 'Offline. Changes will sync later.' : pending ? 'Syncing…' : 'Synced';
      render();
    }, (e) => toast(friendly(e))),
  ];

  const share = takePendingShare();
  if (share) openAdd(share);
}

function visibleItems() {
  const q = state.q.trim().toLowerCase();
  return state.items
    .filter((i) => (state.view === 'done' ? i.status === 'done' : i.status !== 'done'))
    .filter((i) => state.filter === 'all' || catOf(i).id === state.filter)
    .filter((i) => !q || `${i.title} ${i.url} ${i.note} ${catOf(i).name}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
}

function renderFilters() {
  const inView = state.items.filter((i) => (state.view === 'done' ? i.status === 'done' : i.status !== 'done'));
  const count = (id) => inView.filter((i) => catOf(i).id === id).length;
  const cats = [...state.categories];
  if (inView.some((i) => catOf(i) === UNCATEGORIZED)) cats.push(UNCATEGORIZED);
  if (state.filter !== 'all' && !cats.some((c) => c.id === state.filter)) state.filter = 'all';

  $('filters').innerHTML = [
    `<button class="chip" data-filter="all" aria-pressed="${state.filter === 'all'}">All<span class="count">${inView.length}</span></button>`,
    ...cats.map(
      (c) =>
        `<button class="chip" data-filter="${esc(c.id)}" aria-pressed="${state.filter === c.id}">${esc(c.emoji)} ${esc(c.name)}<span class="count">${count(c.id)}</span></button>`,
    ),
  ].join('');
}

function renderList() {
  const items = visibleItems();
  $('list').innerHTML = items
    .map((i) => {
      const cat = catOf(i);
      return `<li class="item${i.status === 'done' ? ' done' : ''}${i.pinned ? ' pinned' : ''}" data-id="${esc(i.id)}">
        <button class="check" data-act="toggle" aria-label="${i.status === 'done' ? 'Mark as not done' : 'Mark as done'}"><span>✓</span></button>
        <a class="body" href="${esc(safeHref(i.url))}" target="_blank" rel="noopener noreferrer">
          <div class="meta">
            ${i.favicon ? `<img src="${esc(i.favicon)}" alt="" loading="lazy" />` : ''}
            <span class="domain">${esc(i.domain || getDomain(i.url))}</span>
            <span>· ${esc(timeAgo(i.createdAt))}</span>
            ${state.filter === 'all' ? `<span class="tag">${esc(cat.emoji)} ${esc(cat.name)}</span>` : ''}
            ${i.pinned ? '<span title="Pinned">📌</span>' : ''}
          </div>
          <div class="title">${esc(i.title || i.url)}</div>
          ${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}
        </a>
        <button class="more" data-act="more" aria-label="More actions">⋯</button>
      </li>`;
    })
    .join('');

  const empty = $('empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.innerHTML = state.q
      ? `<div class="big">🔍</div><p>Nothing matches “${esc(state.q)}”.</p>`
      : state.view === 'done'
        ? `<div class="big">🎉</div><p>Nothing marked done yet.</p>`
        : `<div class="big">🔖</div><p><strong>Nothing to check yet.</strong></p>
           <p class="small">Tap <strong>+</strong> to paste a link, share from any app on your phone, or use the Chrome extension.</p>`;
  }
}

function render() {
  renderFilters();
  renderList();
  if ($('accountDialog').open) renderAccount();
}

// ---------- Item actions ----------
const findItem = (id) => state.items.find((i) => i.id === id);

// Writes are not awaited: Firestore applies them locally at once (works offline)
// and syncs in the background. We only surface failures.
const fail = (e) => toast(friendly(e));

function toggleDone(item) {
  const status = item.status === 'done' ? 'unread' : 'done';
  db.updateItem(state.session.code, item.id, { status }).catch(fail);
  if (status === 'done') {
    toast('Marked as done', { label: 'Undo', run: () => db.updateItem(state.session.code, item.id, { status: 'unread' }).catch(fail) });
  }
}

function removeItem(item) {
  db.deleteItem(state.session.code, item.id).catch(fail);
  toast('Deleted', { label: 'Undo', run: () => db.restoreItem(state.session.code, item).catch(fail) });
}

function openItem(item) {
  const d = $('itemDialog');
  $('itemTitle').textContent = item.title || item.url;
  $('itemMeta').textContent = `${item.domain || getDomain(item.url)} · saved ${timeAgo(item.createdAt)} from ${item.source || 'web'}`;

  const actions = [
    ['🔗 Open', () => window.open(safeHref(item.url), '_blank', 'noopener')],
    navigator.share && ['📤 Share', () => navigator.share({ title: item.title, url: item.url }).catch(() => {})],
    ['📋 Copy link', () => copy(item.url)],
    [item.pinned ? '📌 Unpin' : '📌 Pin to top', () => db.updateItem(state.session.code, item.id, { pinned: !item.pinned })],
    [item.status === 'done' ? '↩️ Mark not done' : '✅ Mark done', () => toggleDone(item)],
    ['✏️ Edit', () => openAdd(item, item.id)],
    ['🗑️ Delete', () => removeItem(item), 'danger'],
  ].filter(Boolean);

  $('itemActions').replaceChildren(
    ...actions.map(([label, run, cls]) => {
      const b = document.createElement('button');
      b.className = `btn ${cls || ''}`;
      b.textContent = label;
      b.addEventListener('click', () => {
        d.close();
        Promise.resolve(run()).catch((e) => toast(friendly(e)));
      });
      return b;
    }),
  );

  $('itemCats').replaceChildren(
    ...state.categories.map((c) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.setAttribute('aria-checked', String(c.id === item.category));
      b.textContent = `${c.emoji} ${c.name}`;
      b.addEventListener('click', () => {
        d.close();
        if (c.id === item.category) return;
        db.updateItem(state.session.code, item.id, { category: c.id }).catch(fail);
        toast(`Moved to ${c.name}`);
      });
      return b;
    }),
  );
  d.showModal();
}

// ---------- Add / edit sheet ----------
let addState = { editId: null, category: null, categoryTouched: false };

function renderAddCats() {
  $('addCats').replaceChildren(
    ...state.categories.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === addState.category));
      b.textContent = `${c.emoji} ${c.name}`;
      b.addEventListener('click', () => {
        addState.category = c.id;
        addState.categoryTouched = true;
        renderAddCats();
      });
      return b;
    }),
  );
}

function onAddUrlChange() {
  const url = $('addUrl').value.trim();
  if (!addState.categoryTouched && !addState.editId) {
    addState.category = suggestCategory(url, state.categories);
    renderAddCats();
  }
  const clean = isSavableUrl(url) ? cleanUrl(url) : null;
  const dup = clean && state.items.find((i) => i.url === clean && i.id !== addState.editId);
  $('addDup').hidden = !dup;
  if (dup) $('addDup').textContent = `You saved this ${timeAgo(dup.createdAt)}${dup.status === 'done' ? ' and marked it done' : ''}.`;
}

function openAdd(prefill = {}, editId = null) {
  addState = {
    editId,
    category: prefill.category || suggestCategory(prefill.url || '', state.categories),
    categoryTouched: Boolean(editId),
  };
  $('addTitle').textContent = editId ? 'Edit link' : 'Save a link';
  $('addSubmit').textContent = editId ? 'Save changes' : 'Save';
  $('addUrl').value = prefill.url || '';
  $('addTitleInput').value = prefill.title || '';
  $('addNote').value = prefill.note || '';
  $('addError').hidden = true;
  $('pasteBtn').hidden = !navigator.clipboard?.readText;
  renderAddCats();
  onAddUrlChange();
  $('addDialog').showModal();
  if (!prefill.url) $('addUrl').focus();
}

function submitAdd(e) {
  e.preventDefault();
  let url = $('addUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) url = `https://${url}`;
  if (!isSavableUrl(url)) {
    $('addError').textContent = 'Please enter a valid link (starting with http:// or https://).';
    $('addError').hidden = false;
    return;
  }
  const fields = {
    url,
    title: $('addTitleInput').value.trim(),
    note: $('addNote').value.trim(),
    category: addState.category,
    source: addState.editId ? undefined : sharedFromPhone ? 'share' : 'web',
  };
  $('addDialog').close();
  if (addState.editId) {
    const clean = cleanUrl(url);
    db.updateItem(state.session.code, addState.editId, {
      url: clean,
      title: fields.title || getDomain(clean),
      note: fields.note,
      category: fields.category,
      domain: getDomain(clean),
      favicon: faviconFor(clean),
    }).catch(fail);
    toast('Updated');
  } else {
    db.addItem(state.session.code, fields).catch(fail);
    const cat = state.categories.find((c) => c.id === fields.category);
    toast(`Saved to ${cat ? cat.name : 'CheckLater'}${navigator.onLine ? '' : ' (will sync when online)'}`);
  }
  sharedFromPhone = false;
}

let sharedFromPhone = false;

// ---------- Account sheet ----------
async function renderAccount() {
  const { code, username } = state.session;
  $('accName').textContent = `Hi, ${username}`;
  $('accCode').textContent = code;
  $('accQr').src = await QRCode.toDataURL(`${location.origin}/?code=${code}`, { margin: 1, width: 264 });

  $('catList').replaceChildren(
    ...state.categories.map((c) => {
      const li = document.createElement('li');
      const n = state.items.filter((i) => i.category === c.id).length;
      li.innerHTML = `<span>${esc(c.emoji)}</span><span class="grow">${esc(c.name)}</span><span class="muted small">${n}</span>`;
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete ${c.name}`);
      del.disabled = state.categories.length <= 1;
      del.addEventListener('click', () => deleteCategory(c));
      li.append(del);
      return li;
    }),
  );
  $('installBtn').hidden = !installPrompt;
}

async function addCategory(e) {
  e.preventDefault();
  const name = $('catName').value.trim().slice(0, 30);
  if (!name) return;
  let id = slugify(name);
  while (state.categories.some((c) => c.id === id)) id = `${id}-${Math.floor(Math.random() * 1000)}`;
  const emoji = $('catEmoji').value.trim() || '🏷️';
  try {
    await db.setCategories(state.session.code, [...state.categories, { id, name, emoji }]);
    $('catName').value = '';
    $('catEmoji').value = '';
  } catch (err) {
    toast(friendly(err));
  }
}

async function deleteCategory(cat) {
  const rest = state.categories.filter((c) => c.id !== cat.id);
  const target = rest.find((c) => c.id === 'other') || rest[0];
  const affected = state.items.filter((i) => i.category === cat.id).map((i) => i.id);
  const msg = affected.length
    ? `Delete “${cat.name}”? Its ${affected.length} link(s) will move to ${target.name}.`
    : `Delete “${cat.name}”?`;
  if (!confirm(msg)) return;
  try {
    if (affected.length) await db.moveItems(state.session.code, affected, target.id);
    await db.setCategories(state.session.code, rest);
  } catch (err) {
    toast(friendly(err));
  }
}

function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    username: state.session.username,
    categories: state.categories,
    items: state.items.map(({ pendingSync, ...i }) => i),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `checklater-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy this:', text);
  }
}

function signOut() {
  if (!confirm('Sign out of this device? Your links stay saved under your code.')) return;
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  localStorage.removeItem(SESSION_KEY);
  location.reload();
}

// ---------- PWA install ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

// ---------- Wire up ----------
function wire() {
  $('fab').addEventListener('click', () => openAdd());
  $('accountBtn').addEventListener('click', () => {
    renderAccount();
    $('accountDialog').showModal();
  });
  $('searchInput').addEventListener('input', (e) => {
    state.q = e.target.value;
    renderList();
  });
  document.querySelectorAll('.toolbar .seg').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      document.querySelectorAll('.toolbar .seg').forEach((x) => x.classList.toggle('active', x === b));
      render();
    }),
  );
  $('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    render();
  });
  $('list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const item = findItem(btn.closest('.item').dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'toggle') toggleDone(item);
    if (btn.dataset.act === 'more') openItem(item);
  });

  $('addForm').addEventListener('submit', submitAdd);
  $('addUrl').addEventListener('input', onAddUrlChange);
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const link = extractUrl(text) || text.trim();
      $('addUrl').value = link;
      onAddUrlChange();
    } catch {
      toast('Clipboard access was blocked. Long-press the field to paste.');
    }
  });

  $('accCopy').addEventListener('click', () => copy(state.session.code));
  $('catForm').addEventListener('submit', addCategory);
  $('exportBtn').addEventListener('click', exportJson);
  $('signOutBtn').addEventListener('click', signOut);
  $('installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('installBtn').hidden = true;
  });

  // Close buttons + tap-outside-to-close for every sheet.
  document.querySelectorAll('dialog').forEach((d) => {
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  });

  window.addEventListener('online', render);
  window.addEventListener('offline', render);
}

// ---------- Boot ----------
(async function boot() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (!isConfigured()) return show('viewSetup');

  const pendingCode = captureIncoming();
  sharedFromPhone = Boolean(sessionStorage.getItem(PENDING_SHARE_KEY));
  wire();
  initWelcome();

  try {
    await db.initFirebase();
  } catch (e) {
    show('viewWelcome');
    return setAuthError(friendly(e));
  }

  const session = loadSession();
  if (pendingCode && pendingCode !== session?.code) {
    show('viewWelcome');
    $('codeInput').value = pendingCode;
    return signIn(pendingCode);
  }
  if (session) return enterApp();
  show('viewWelcome');
  if (sharedFromPhone) setAuthError('Sign in first. Your shared link will be saved right after.');
})();
