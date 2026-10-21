// Right-click menus + keyboard quick-save.
import { addItem } from './lib/api.js';
import { getSession } from './lib/session.js';
import { suggestCategory, isSavableUrl } from './lib/shared/core.js';

const ROOT = 'checklater';
const AUTO = 'auto';

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const session = await getSession();
  const contexts = ['page', 'link', 'selection', 'image', 'video'];

  chrome.contextMenus.create({ id: ROOT, title: 'Send to CheckLater', contexts });
  if (!session) {
    chrome.contextMenus.create({ id: 'signin', parentId: ROOT, title: 'Sign in first…', contexts });
    return;
  }
  chrome.contextMenus.create({ id: AUTO, parentId: ROOT, title: '⚡ Smart category', contexts });
  chrome.contextMenus.create({ id: 'sep', parentId: ROOT, type: 'separator', contexts });
  for (const c of session.categories) {
    chrome.contextMenus.create({ id: `cat:${c.id}`, parentId: ROOT, title: `${c.emoji} ${c.name}`, contexts });
  }
}

// Serialize rebuilds so overlapping calls don't create duplicate menu ids.
let menuChain = Promise.resolve();
const queueRebuild = () => (menuChain = menuChain.then(rebuildMenus).catch(console.error));

chrome.runtime.onInstalled.addListener(queueRebuild);
chrome.runtime.onStartup.addListener(queueRebuild);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.session) queueRebuild();
});

function flash(text, color, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (title) chrome.action.setTitle({ title });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Send to CheckLater' });
  }, 3000);
}

const openPopup = () => chrome.action.openPopup?.()?.catch(() => {});

async function save({ url, title, note, categoryId }) {
  const session = await getSession();
  if (!session) {
    flash('!', '#d93025', 'Open CheckLater and sign in first');
    openPopup();
    return;
  }
  if (!isSavableUrl(url)) {
    flash('!', '#d93025', 'This page cannot be saved');
    return;
  }
  const category = categoryId && categoryId !== AUTO ? categoryId : suggestCategory(url, session.categories);
  try {
    await addItem(session.code, { url, title, note, category, source: 'extension' });
    const cat = session.categories.find((c) => c.id === category);
    flash('✓', '#1e8e3e', `Saved to ${cat ? cat.name : 'CheckLater'}`);
  } catch (e) {
    console.error(e);
    flash('!', '#d93025', `Save failed: ${e.message}`);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'signin') {
    openPopup();
    return;
  }
  const categoryId = String(info.menuItemId).replace(/^cat:/, '');
  const selection = info.selectionText?.trim();

  if (info.linkUrl) {
    save({ url: info.linkUrl, title: selection || info.linkUrl, note: tab?.title ? `From: ${tab.title}` : '', categoryId });
  } else if (info.srcUrl && (info.mediaType === 'image' || info.mediaType === 'video')) {
    save({ url: info.srcUrl, title: `${info.mediaType} from ${tab?.title || 'page'}`, note: tab?.url ? `From: ${tab.url}` : '', categoryId });
  } else {
    save({ url: tab?.url, title: tab?.title, note: selection ? `“${selection.slice(0, 1500)}”` : '', categoryId });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'quick-save') return;
  const active = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (active) save({ url: active.url, title: active.title, categoryId: AUTO });
});
