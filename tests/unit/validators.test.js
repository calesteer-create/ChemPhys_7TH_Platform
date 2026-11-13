import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateHierarchy,
  validateContentBlock,
  validateCoverage,
  validateSourcePrepGate,
  validateNotebook,
  validateQuiz,
  validateApprovalRecord,
} from '../../src/validate/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'src/content/fixtures', name), 'utf8'));

test('valid hierarchy passes', () => {
  const result = validateHierarchy(fixture('valid-hierarchy.json'));
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('hierarchy with missing stage fails', () => {
  const hierarchy = fixture('valid-hierarchy.json');
  hierarchy.grades[0].subjects[0].units[0].lessons[0].stages.pop();
  const result = validateHierarchy(hierarchy);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('exactly 7')));
});

test('valid blocks pass, including multi-source book block', () => {
  const blocks = fixture('valid-blocks.json');
  for (const block of blocks) {
    const result = validateContentBlock(block);
    assert.equal(result.valid, true, `${block.id}: ${result.errors.join('; ')}`);
  }
  const bookBlock = blocks.find((b) => b.kind === 'book');
  assert.ok(bookBlock.sourceRefs.length >= 2, 'book block must carry multiple sources');
});

test('book block without source fails', () => {
  const result = validateContentBlock(fixture('invalid-block-no-source.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least one traceable source')));
});

test('valid coverage passes with no uncovered items', () => {
  const result = validateCoverage(fixture('valid-coverage.json'));
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.uncovered, []);
});

test('coverage gap fails and reports uncovered element', () => {
  const result = validateCoverage(fixture('invalid-coverage-gap.json'));
  assert.equal(result.valid, false);
  assert.ok(result.uncovered.includes('l01-bad01'));
});

test('valid notebook passes', () => {
  const data = fixture('valid-notebook.json');
  const result = validateNotebook(data.notebook, data.subItems, data.profile);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('orphan notebook item and missing required item fail', () => {
  const data = fixture('invalid-notebook-orphan.json');
  const result = validateNotebook(data.notebook, data.subItems, data.profile);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('orphan')));
  assert.ok(result.errors.some((e) => e.includes('has no notebook item')));
});

test('lesson quiz and authorized unit quiz pass', () => {
  const data = fixture('valid-quiz.json');
  for (const quiz of data.quizzes) {
    const result = validateQuiz(quiz, data.authorizations);
    assert.equal(result.valid, true, `${quiz.id}: ${result.errors.join('; ')}`);
  }
});

test('unit quiz without authorization fails', () => {
  const data = fixture('invalid-quiz-unit-no-auth.json');
  const result = validateQuiz(data.quizzes[0], data.authorizations);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('UnitTestAuthorization')));
});

test('clear sources do not block preparation', () => {
  const data = fixture('valid-sources.json');
  const result = validateSourcePrepGate(data.pages, data.figures);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('unclear essential source blocks preparation', () => {
  const data = fixture('invalid-sources-unclear.json');
  const result = validateSourcePrepGate(data.pages, data.figures);
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.some((b) => b.includes('page 10')));
});

test('approval record binds to computed version hash', () => {
  const record = {
    lessonId: 'l01',
    gate: 'C-owner',
    versionHash: 'abc123',
    result: 'approved',
    by: 'owner',
    at: '2026-01-01',
  };
  assert.equal(validateApprovalRecord(record, 'abc123').valid, true);
  assert.equal(validateApprovalRecord(record, 'different').valid, false);
});

test('validators layer is separated from presentation code', () => {
  const source = readFileSync(join(root, 'src/validate/validators.js'), 'utf8');
  assert.ok(!source.includes('main.js'), 'validators must not import presentation code');
  assert.ok(!source.includes('document.'), 'validators must not touch the DOM');
});
