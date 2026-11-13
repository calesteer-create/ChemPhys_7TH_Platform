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
  validateApprovalChain,
} from '../../src/validate/validators.js';
import { computeVersionHash } from '../../src/validate/version-hash.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'src/content/fixtures', name), 'utf8'));
const fixtureText = (name) => readFileSync(join(root, 'src/content/fixtures', name), 'utf8');

function contentFiles() {
  return [
    { path: 'src/content/fixtures/valid-hierarchy.json', content: fixtureText('valid-hierarchy.json') },
    { path: 'src/content/fixtures/valid-blocks.json', content: fixtureText('valid-blocks.json') },
    { path: 'src/content/fixtures/valid-coverage.json', content: fixtureText('valid-coverage.json') },
    { path: 'src/content/fixtures/valid-notebook.json', content: fixtureText('valid-notebook.json') },
    { path: 'src/content/fixtures/valid-sources.json', content: fixtureText('valid-sources.json') },
    { path: 'src/content/fixtures/valid-quiz.json', content: fixtureText('valid-quiz.json') },
  ];
}

function completeChain(hash) {
  return [
    { lessonId: 'l01', gate: 'A-automated', versionHash: hash, result: 'pass', by: 'ci', at: '2026-01-01' },
    { lessonId: 'l01', gate: 'B-scientific', versionHash: hash, result: 'pass', by: 'reviewer', at: '2026-01-01' },
    { lessonId: 'l01', gate: 'B-notebook-educational', versionHash: hash, result: 'pass', by: 'reviewer', at: '2026-01-01' },
    { lessonId: 'l01', gate: 'C-owner', versionHash: hash, result: 'approved', by: 'owner', at: '2026-01-01' },
  ];
}

test('full approval chain succeeds on a coherent fictional lesson', () => {
  const data = fixture('valid-hierarchy.json');
  const allBlocks = fixture('valid-blocks.json');
  const items = fixture('valid-coverage.json');
  const sources = fixture('valid-sources.json');
  const notebookData = fixture('valid-notebook.json');
  const quizData = fixture('valid-quiz.json');

  assert.equal(validateHierarchy(data).valid, true);
  for (const block of allBlocks) assert.equal(validateContentBlock(block).valid, true);
  assert.equal(validateCoverage(items, allBlocks, data).valid, true);
  assert.equal(validateSourcePrepGate(sources.pages, sources.figures, { pages: [10], figures: [1] }).blocked, false);
  assert.equal(validateNotebook(notebookData.notebook, notebookData.subItems, notebookData.profile).valid, true);
  for (const quiz of quizData.quizzes) {
    assert.equal(validateQuiz(quiz, quizData.authorizations, quizData.units).valid, true);
  }

  const hash = computeVersionHash(contentFiles());
  assert.match(hash, /^[0-9a-f]{64}$/);
  const chain = validateApprovalChain(completeChain(hash), hash);
  assert.equal(chain.valid, true, chain.errors.join('; '));
});

test('approval chain fails when a mandatory gate is missing', () => {
  const hash = computeVersionHash(contentFiles());
  const incomplete = completeChain(hash).filter((r) => r.gate !== 'C-owner');
  const chain = validateApprovalChain(incomplete, hash);
  assert.equal(chain.valid, false);
  assert.ok(chain.errors.some((e) => e.includes('mandatory gate missing: C-owner')));
});

test('approval chain fails when the hash does not match the content', () => {
  const hash = computeVersionHash(contentFiles());
  const tamperedBlocks = JSON.stringify([...fixture('valid-blocks.json'), {
    id: 'extra-block', lessonId: 'l01', stageKey: 'orient', kind: 'explanation',
    blockType: 'note', bodyMarkdown: 'x', sourceRefs: [], coversElementIds: [], order: 99,
  }]);
  const tampered = computeVersionHash(
    contentFiles().map((file) =>
      file.path.endsWith('valid-blocks.json')
        ? { path: file.path, content: tamperedBlocks }
        : file,
    ),
  );
  assert.notEqual(hash, tampered);
  const chain = validateApprovalChain(completeChain(hash), tampered);
  assert.equal(chain.valid, false);
  assert.ok(chain.errors.some((e) => e.includes('does not match computed content hash')));
});

test('recording approval does not change the approved content hash', () => {
  const hash = computeVersionHash(contentFiles());
  const withApproval = computeVersionHash([
    ...contentFiles(),
    { path: 'src/content/approvals/l01.json', content: JSON.stringify(completeChain(hash)) },
  ]);
  assert.equal(hash, withApproval);
});

test('approval chain fails when automated gate fails', () => {
  const hash = computeVersionHash(contentFiles());
  const chain = completeChain(hash).map((r) => (r.gate === 'A-automated' ? { ...r, result: 'fail' } : r));
  const result = validateApprovalChain(chain, hash);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('A-automated did not pass')));
});

test('approval chain fails when scientific gate is rejected', () => {
  const hash = computeVersionHash(contentFiles());
  const chain = completeChain(hash).map((r) => (r.gate === 'B-scientific' ? { ...r, result: 'rejected' } : r));
  const result = validateApprovalChain(chain, hash);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('B-scientific did not pass')));
});

test('approval chain fails when owner gate is rejected', () => {
  const hash = computeVersionHash(contentFiles());
  const chain = completeChain(hash).map((r) => (r.gate === 'C-owner' ? { ...r, result: 'rejected' } : r));
  const result = validateApprovalChain(chain, hash);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('C-owner did not pass')));
});

test('approval chain fails when a gate result is missing', () => {
  const hash = computeVersionHash(contentFiles());
  const chain = completeChain(hash).map((r) => {
    if (r.gate !== 'C-owner') return r;
    const copy = { ...r };
    delete copy.result;
    return copy;
  });
  const result = validateApprovalChain(chain, hash);
  assert.equal(result.valid, false);
});

test('approval chain fails when a gate result is unknown', () => {
  const hash = computeVersionHash(contentFiles());
  const chain = completeChain(hash).map((r) => (r.gate === 'C-owner' ? { ...r, result: 'pending' } : r));
  const result = validateApprovalChain(chain, hash);
  assert.equal(result.valid, false);
});
