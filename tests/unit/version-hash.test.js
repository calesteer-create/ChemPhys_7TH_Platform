import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVersionHash,
  canonicalize,
  filterHashInputs,
  VERSION_HASH_INCLUDES,
  VERSION_HASH_EXCLUDES,
} from '../../src/validate/version-hash.js';

const files = [
  { path: 'src/content/lesson-l01.json', content: '{"a":1}' },
  { path: 'assets/sources/page-10.jpg', content: Buffer.from([1, 2, 3]) },
  { path: 'src/content/notebook-l01.json', content: '{"b":2}' },
];

test('hash is deterministic regardless of input order', () => {
  const forward = computeVersionHash(files);
  const reversed = computeVersionHash([...files].reverse());
  assert.equal(forward, reversed);
  assert.match(forward, /^[0-9a-f]{64}$/);
});

test('hash changes when any content input changes', () => {
  const base = computeVersionHash(files);
  const changed = computeVersionHash([
    { path: 'src/content/lesson-l01.json', content: '{"a":2}' },
    files[1],
    files[2],
  ]);
  assert.notEqual(base, changed);
});

test('hash changes when an image changes', () => {
  const base = computeVersionHash(files);
  const changed = computeVersionHash([
    files[0],
    { path: 'assets/sources/page-10.jpg', content: Buffer.from([9, 9, 9]) },
    files[2],
  ]);
  assert.notEqual(base, changed);
});

test('approval records are excluded from the hash', () => {
  const base = computeVersionHash(files);
  const withApproval = computeVersionHash([
    ...files,
    { path: 'src/content/approvals/l01-approval.json', content: '{"approved":true}' },
  ]);
  assert.equal(base, withApproval);
  assert.equal(filterHashInputs([{ path: 'x/approval.json', content: '' }]).length, 0);
});

test('canonicalize makes key order irrelevant', () => {
  assert.deepEqual(canonicalize({ b: 1, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
});

test('hash scope covers all content inputs and excludes approvals', () => {
  for (const item of ['lesson data', 'stages', 'notebook', 'coverage matrix', 'source records', 'images', 'figures', 'equations']) {
    assert.ok(VERSION_HASH_INCLUDES.includes(item), `missing include: ${item}`);
  }
  assert.ok(VERSION_HASH_EXCLUDES.includes('approval records'));
  assert.ok(VERSION_HASH_EXCLUDES.includes('owner approvals'));
});
