import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCode, normalizeCode, isValidCode, suggestCategory, extractUrl,
  cleanUrl, buildItem, timeAgo, DEFAULT_CATEGORIES,
} from '../shared/core.js';
import { toFields, fromFields } from '../extension/lib/api.js';

test('generated codes are valid and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.ok(isValidCode(c), c);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test('normalizeCode accepts messy input and rejects bad codes', () => {
  assert.equal(normalizeCode('abcd efgh jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(normalizeCode('ABCD-EFGH-JKMN'), 'ABCD-EFGH-JKMN');
  assert.equal(normalizeCode('ABCD-EFGH-JKM'), null); // too short
  assert.equal(normalizeCode('ABCD-EFGH-JKM0'), null); // 0 is not in the alphabet
  assert.equal(normalizeCode(''), null);
});

test('suggestCategory uses domain rules and falls back safely', () => {
  assert.equal(suggestCategory('https://www.youtube.com/watch?v=1'), 'watch');
  assert.equal(suggestCategory('https://www.amazon.in/dp/x'), 'shopping');
  assert.equal(suggestCategory('https://docs.google.com/document/d/1'), 'docs');
  assert.equal(suggestCategory('https://example.com/file.pdf'), 'docs');
  assert.equal(suggestCategory('https://github.com/a/b'), 'work');
  assert.equal(suggestCategory('https://someblog.example'), 'read');
  // Category list without the guessed id → first category
  assert.equal(suggestCategory('https://youtube.com', [{ id: 'x', name: 'X', emoji: '' }]), 'x');
});

test('extractUrl pulls a link out of shared text', () => {
  assert.equal(extractUrl('Look at this https://youtu.be/abc123, so good!'), 'https://youtu.be/abc123');
  assert.equal(extractUrl('no link here'), null);
});

test('cleanUrl strips tracking params only', () => {
  assert.equal(cleanUrl('https://a.com/p?utm_source=x&id=7&fbclid=1'), 'https://a.com/p?id=7');
});

test('buildItem fills defaults', () => {
  const it = buildItem({ url: 'https://www.github.com/x?utm_medium=y', category: 'work' });
  assert.equal(it.url, 'https://www.github.com/x');
  assert.equal(it.title, 'github.com');
  assert.equal(it.status, 'unread');
  assert.equal(it.remindAt, null);
});

test('timeAgo', () => {
  assert.equal(timeAgo(new Date()), 'just now');
  assert.equal(timeAgo(new Date(Date.now() - 5 * 60e3)), '5m ago');
  assert.equal(timeAgo(new Date(Date.now() - 3 * 3600e3)), '3h ago');
  assert.equal(timeAgo(new Date(Date.now() - 2 * 86400e3)), '2d ago');
});

test('Firestore REST encoding round-trips', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  const obj = { s: 'x', n: 3, f: 1.5, b: true, z: null, d, arr: DEFAULT_CATEGORIES.slice(0, 2), m: { a: 'b' } };
  const back = fromFields(toFields(obj));
  assert.deepEqual(back, obj);
});
