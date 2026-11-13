import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovalChain } from '../../src/validate/validators.js';

const HASH = 'a'.repeat(64);

function record(gate, result, overrides = {}) {
  return { lessonId: 'l01', gate, versionHash: HASH, result, by: 'reviewer', at: '2026-01-01', ...overrides };
}

function validChain() {
  return [
    record('A-automated', 'pass'),
    record('B-scientific', 'pass'),
    record('B-notebook-educational', 'pass'),
    record('C-owner', 'approved'),
  ];
}

function errorsOf(chain, hash = HASH) {
  return validateApprovalChain(chain, hash).errors;
}

test('D-1 baseline: one record per gate is accepted', () => {
  const result = validateApprovalChain(validChain(), HASH);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('D-1: duplicate A-automated gate is rejected even when both records are identical', () => {
  const chain = [...validChain(), record('A-automated', 'pass')];
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate gate record: A-automated appears 2 times')), result.errors.join('; '));
});

test('D-1: duplicate B-scientific gate is rejected even when both records are identical', () => {
  const chain = [...validChain(), record('B-scientific', 'pass')];
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate gate record: B-scientific')), result.errors.join('; '));
});

test('D-1: duplicate C-owner gate is rejected even when both records are identical', () => {
  const chain = [...validChain(), record('C-owner', 'approved')];
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate gate record: C-owner')), result.errors.join('; '));
});

test('D-1: duplicate B-notebook-educational gate is rejected', () => {
  const chain = [...validChain(), record('B-notebook-educational', 'pass')];
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate gate record: B-notebook-educational')), result.errors.join('; '));
});

test('D-1: three identical records of the same gate are rejected with the real count', () => {
  const chain = [...validChain(), record('A-automated', 'pass'), record('A-automated', 'pass')];
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('A-automated appears 3 times')), result.errors.join('; '));
});

test('D-1: a duplicated gate cannot compensate for a missing mandatory gate', () => {
  const chain = validChain().filter((r) => r.gate !== 'C-owner');
  chain.push(record('A-automated', 'pass'));
  const errors = errorsOf(chain);
  assert.ok(errors.some((e) => e.includes('duplicate gate record: A-automated')), errors.join('; '));
  assert.ok(errors.some((e) => e.includes('mandatory gate missing: C-owner')), errors.join('; '));
});

test('D-1: duplicate with a conflicting result is rejected', () => {
  const chain = [...validChain(), record('A-automated', 'fail')];
  const errors = errorsOf(chain);
  assert.ok(errors.some((e) => e.includes('duplicate gate record: A-automated')), errors.join('; '));
  assert.ok(errors.some((e) => e.includes('A-automated did not pass')), errors.join('; '));
});

test('D-1: duplicate with a conflicting version hash is rejected', () => {
  const chain = [...validChain(), record('C-owner', 'approved', { versionHash: 'b'.repeat(64) })];
  const errors = errorsOf(chain);
  assert.ok(errors.some((e) => e.includes('duplicate gate record: C-owner')), errors.join('; '));
  assert.ok(errors.some((e) => e.includes('versionHash does not match computed content hash')), errors.join('; '));
});

test('D-2 baseline: a chain whose records all belong to one lesson is accepted', () => {
  const result = validateApprovalChain(validChain(), HASH);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('D-2: A-automated belonging to a different lesson is rejected', () => {
  const chain = validChain().map((r) => (r.gate === 'A-automated' ? { ...r, lessonId: 'l99' } : r));
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('approval chain must belong to a single lesson')), result.errors.join('; '));
});

test('D-2: B-scientific differing from the rest is rejected', () => {
  const chain = validChain().map((r) => (r.gate === 'B-scientific' ? { ...r, lessonId: 'l02' } : r));
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('single lesson') && e.includes('l02')), result.errors.join('; '));
});

test('D-2: C-owner differing from the rest is rejected', () => {
  const chain = validChain().map((r) => (r.gate === 'C-owner' ? { ...r, lessonId: 'l77' } : r));
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('single lesson')), result.errors.join('; '));
});

test('D-2: four different lessonIds are all rejected', () => {
  const chain = validChain().map((r, i) => ({ ...r, lessonId: 'lesson-' + i }));
  const result = validateApprovalChain(chain, HASH);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('single lesson')), result.errors.join('; '));
});

test('D-2: a matching versionHash does not prove the gates belong to the same lesson', () => {
  const chain = validChain().map((r) => (r.gate === 'C-owner' ? { ...r, lessonId: 'other-lesson' } : r));
  assert.ok(chain.every((r) => r.versionHash === HASH));
  assert.equal(validateApprovalChain(chain, HASH).valid, false);
});

test('D-2: a missing lessonId is rejected', () => {
  const chain = validChain().map((r) => {
    if (r.gate !== 'C-owner') return r;
    const copy = { ...r };
    delete copy.lessonId;
    return copy;
  });
  const errors = errorsOf(chain);
  assert.ok(errors.some((e) => e.includes('lessonId is required')), errors.join('; '));
});

test('D-2: an empty lessonId is rejected', () => {
  for (const empty of ['', '   ']) {
    const chain = validChain().map((r) => (r.gate === 'C-owner' ? { ...r, lessonId: empty } : r));
    const result = validateApprovalChain(chain, HASH);
    assert.equal(result.valid, false, 'empty lessonId "' + empty + '" must be rejected');
    assert.ok(result.errors.some((e) => e.includes('lessonId is required')), result.errors.join('; '));
  }
});

test('D-2: a non-string lessonId is rejected', () => {
  for (const bad of [5, true, {}, [], null]) {
    const chain = validChain().map((r) => (r.gate === 'B-scientific' ? { ...r, lessonId: bad } : r));
    const result = validateApprovalChain(chain, HASH);
    assert.equal(result.valid, false, 'lessonId ' + JSON.stringify(bad) + ' must be rejected');
  }
});

test('D-2: records without an object shape do not crash the chain', () => {
  for (const bad of [null, 5, 'x']) {
    let result;
    assert.doesNotThrow(() => {
      result = validateApprovalChain([...validChain(), bad], HASH);
    });
    assert.equal(result.valid, false);
  }
});
