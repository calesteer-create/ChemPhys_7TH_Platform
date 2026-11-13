import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVersionHash,
  canonicalize,
  filterHashInputs,
  isApprovalRecordPath,
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

test('hash changes when a new content file is added', () => {
  const base = computeVersionHash(files);
  const extended = computeVersionHash([
    ...files,
    { path: 'src/content/coverage-l01.json', content: '{"items":[]}' },
  ]);
  assert.notEqual(base, extended);
});

test('approval records are excluded from the hash', () => {
  const base = computeVersionHash(files);
  const withApproval = computeVersionHash([
    ...files,
    { path: 'src/content/approvals/l01.json', content: '{"approved":true}' },
  ]);
  assert.equal(base, withApproval);
  assert.equal(filterHashInputs([{ path: 'x/approval.json', content: '' }]).length, 0);
});

test('exclusion is precise: content files mentioning approval are included', () => {
  assert.equal(isApprovalRecordPath('src/content/approvals/l01.json'), true);
  assert.equal(isApprovalRecordPath('src/content/approval.json'), true);
  assert.equal(isApprovalRecordPath('src/content/lesson-approval-overview.json'), false);
  assert.equal(isApprovalRecordPath('src/content/approval-notes.json'), false);
  const base = computeVersionHash(files);
  const withContent = computeVersionHash([
    ...files,
    { path: 'src/content/lesson-approval-overview.json', content: '{"x":1}' },
  ]);
  assert.notEqual(base, withContent, 'content file must affect the hash');
});

test('empty or invalid file lists are rejected', () => {
  assert.throws(() => computeVersionHash([]), TypeError);
  assert.throws(() => computeVersionHash(null), TypeError);
  assert.throws(() => computeVersionHash(undefined), TypeError);
  assert.throws(() => computeVersionHash([{ path: 'a.json' }]), TypeError);
  assert.throws(() => computeVersionHash([{ content: '{}' }]), TypeError);
});

test('duplicate paths throw a clear error', () => {
  assert.throws(
    () => computeVersionHash([
      { path: 'a.json', content: '{}' },
      { path: 'a.json', content: '{}' },
    ]),
    TypeError,
  );
});

// Task 005: raw bytes are hashed, so a formatting-only change is a new version
// and invalidates earlier approvals on purpose. This replaces the Task 004 test
// that asserted the opposite behaviour.
test('JSON formatting changes produce a different hash (raw bytes are hashed)', () => {
  const first = computeVersionHash([{ path: 'a.json', content: '{"b":1,"a":2}' }]);
  const second = computeVersionHash([{ path: 'a.json', content: '{\n  "a": 2,\n  "b": 1\n}' }]);
  assert.notEqual(first, second);
});

// A change that is only key order (same formatting) is also a different version.
test('JSON key order changes produce a different hash', () => {
  const first = computeVersionHash([{ path: 'a.json', content: '{"a":2,"b":1}' }]);
  const second = computeVersionHash([{ path: 'a.json', content: '{"b":1,"a":2}' }]);
  assert.notEqual(first, second);
});

test('JSON value changes affect the hash', () => {
  const first = computeVersionHash([{ path: 'a.json', content: '{"a":1}' }]);
  const second = computeVersionHash([{ path: 'a.json', content: '{"a":2}' }]);
  assert.notEqual(first, second);
});

test('canonicalize makes key order irrelevant', () => {
  assert.deepEqual(canonicalize({ b: 1, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
});

test('hash scope covers all content inputs and excludes approvals', () => {
  for (const item of ['lesson data', 'stages', 'notebook', 'coverage matrix', 'source records', 'images', 'figures', 'equations']) {
    assert.ok(VERSION_HASH_INCLUDES.includes(item), 'missing include: ' + item);
  }
  assert.ok(VERSION_HASH_EXCLUDES.includes('approval records'));
  assert.ok(VERSION_HASH_EXCLUDES.includes('owner approvals'));
});
