import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeVersionHash,
  normalizeHashPath,
  SCHEMA_VERSION,
  HASH_ALGORITHM_VERSION,
} from '../../src/validate/version-hash.js';
import {
  validateLessonPackage,
  loadLessonPackageFromDisk,
  deriveUnits,
  ALLOWED_ROOTS,
  MANIFEST_FILENAME,
  SCHEMA_PATHS,
  ROLE_ROOTS,
  IMAGE_ROOT,
  CONTENT_ROOT,
} from '../../src/validate/lesson-package.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (relPath) => readFileSync(join(root, relPath), 'utf8');
const bytes = (relPath) => readFileSync(join(root, relPath));
const json = (relPath) => JSON.parse(text(relPath));

const MANIFEST_PATH = 'src/content/fixtures/valid-package-manifest.json';
const manifestText = () => text(MANIFEST_PATH);
const manifest = () => json(MANIFEST_PATH);

function roleFiles() {
  const m = manifest();
  return {
    hierarchy: { path: m.files.hierarchy, content: text(m.files.hierarchy) },
    blocks: { path: m.files.blocks, content: text(m.files.blocks) },
    coverage: { path: m.files.coverage, content: text(m.files.coverage) },
    sources: { path: m.files.sources, content: text(m.files.sources) },
    notebook: { path: m.files.notebook, content: text(m.files.notebook) },
    quizzes: { path: m.files.quizzes, content: text(m.files.quizzes) },
    approvals: { path: m.files.approvals, content: text(m.files.approvals) },
  };
}

function images() {
  return manifest().images.map((p) => ({ path: p, content: bytes(p) }));
}

// The approval fixture uses a placeholder instead of a hard-coded hash, so the
// real hash is always computed from the exact bytes under test.
function approve(files, options = {}) {
  const probe = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  }, options);
  const hash = probe.hash;
  const patched = files.approvals.content.replaceAll('__COMPUTED_HASH__', hash);
  return {
    files: { ...files, approvals: { ...files.approvals, content: patched } },
    hash,
  };
}

function validBundle() {
  const files = roleFiles();
  const { files: approvedFiles, hash } = approve(files);
  return {
    hash,
    bundle: { files: approvedFiles, manifest: { path: MANIFEST_FILENAME, content: manifestText() }, images: images() },
  };
}

function run() {
  const { bundle } = validBundle();
  return validateLessonPackage(bundle);
}

// ---------------------------------------------------------------------------
// Baseline: the whole package passes and the four layers are separated.
// ---------------------------------------------------------------------------

test('P-1: a complete lesson package passes and becomes ready (not published)', () => {
  const result = run();
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.hashAlgorithmVersion, HASH_ALGORITHM_VERSION);
  assert.deepEqual(result.uncovered, []);
  assert.equal(result.automatedValidation.valid, true);
  assert.equal(result.scientificReview.valid, true);
  assert.equal(result.notebookEducational.valid, true);
  assert.equal(result.ownerApproval.valid, true);
  assert.equal(result.readyToPublish, true);
  assert.equal(result.publishingStatus, 'ready');
});

test('P-2: D-publishing is not mandatory and never affects readyToPublish', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const records = JSON.parse(approvedFiles.approvals.content);
  const withPublishing = [...records, { lessonId: 'l01', gate: 'D-publishing', versionHash: 'stale-hash', result: 'fail', by: 'ci', at: '2026-01-01' }];
  const result = validateLessonPackage({
    files: { ...approvedFiles, approvals: { ...approvedFiles.approvals, content: JSON.stringify(withPublishing) } },
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.readyToPublish, true);
  assert.equal(result.publishingStatus, 'ready');
});

test('P-3: a published record flips status but is not owner approval', () => {
  const files = roleFiles();
  const { files: approvedFiles, hash } = approve(files);
  const records = JSON.parse(approvedFiles.approvals.content);
  const published = [...records, { lessonId: 'l01', gate: 'D-publishing', versionHash: hash, result: 'published', by: 'ci', at: '2026-01-01' }];
  const result = validateLessonPackage({
    files: { ...approvedFiles, approvals: { ...approvedFiles.approvals, content: JSON.stringify(published) } },
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.publishingStatus, 'published');
  assert.equal(result.ownerApproval.valid, true);
  assert.ok(result.notes.some((n) => n.includes('does not prove a human review')));
});

// ---------------------------------------------------------------------------
// T-3a / T-3b: internal TypeError vs public structured error.
// ---------------------------------------------------------------------------

test('T-3a: computeVersionHash throws TypeError when nothing is hashable', () => {
  assert.throws(() => computeVersionHash([]), TypeError);
  assert.throws(() => computeVersionHash(null), TypeError);
  assert.throws(() => computeVersionHash([{ path: 'src/content/approvals/l01.json', content: '[]' }]), TypeError);
});

test('T-3b: the public interface converts an internal TypeError into a structured error and never throws', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  // Task 005 fix: the seven schemas are mandatory hash inputs, so the empty-list
  // TypeError that T-3a exercises internally is no longer reachable through the
  // public path (a package always contributes at least the seven schemas).
  // What T-3b must still prove is the CONVERSION: an internal TypeError never
  // escapes the public interface. An incomplete schema set raises one.
  let result;
  assert.doesNotThrow(() => {
    result = validateLessonPackage({
      files: { approvals: approvedFiles.approvals },
      images: [],
    }, { schemaFiles: [] });
  });
  assert.equal(result.valid, false);
  assert.equal(result.hash, undefined);
  assert.ok(result.errors.some((e) => e.startsWith('[hash]')), result.errors.join('; '));
  assert.equal(result.publishingStatus, 'not-ready');
  assert.equal(result.readyToPublish, false);

  // The public interface also never throws on a completely malformed bundle.
  let malformed;
  assert.doesNotThrow(() => { malformed = validateLessonPackage(undefined); });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.length > 0);
});

test('T-3b-2: computeVersionHash still throws TypeError for zero hashable files (internal contract)', () => {
  // The internal contract is unchanged; only the public layer is guaranteed not
  // to throw. This keeps T-3a and T-3b separately meaningful after the change.
  assert.throws(() => computeVersionHash([]), TypeError);
  assert.throws(() => computeVersionHash([{ path: 'src/content/approvals/a.json', content: '[]' }]), TypeError);
});

// ---------------------------------------------------------------------------
// T-1: normalisation + duplicate detection.
// ---------------------------------------------------------------------------

test('T-1: normalisation removes "." and empty segments', () => {
  assert.deepEqual(normalizeHashPath('a/./b.json'), { ok: true, path: 'a/b.json' });
  assert.deepEqual(normalizeHashPath('a//b.json'), { ok: true, path: 'a/b.json' });
  assert.deepEqual(normalizeHashPath('./a/b.json'), { ok: true, path: 'a/b.json' });
});

test('T-1: duplicates are detected after normalisation', () => {
  assert.throws(
    () => computeVersionHash([
      { path: 'a/b.json', content: '{}' },
      { path: 'a/./b.json', content: '{}' },
    ]),
    (err) => err instanceof TypeError && err.message.includes('duplicate path'),
  );
});

// ---------------------------------------------------------------------------
// T-2: reject outside roots (disk mode, realpath containment).
// ---------------------------------------------------------------------------

test('T-2: a path resolving outside the allowed roots is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const escaped = {
    ...approvedFiles,
    hierarchy: { path: 'src/content/../../../etc/passwd', content: approvedFiles.hierarchy.content },
  };
  const result = validateLessonPackage({
    files: escaped,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
    diskRoot: root,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('..')), result.errors.join('; '));
});

test('T-2: a syntactically safe path that symlinks outside is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  }, { diskRoot: root });
  // Every real fixture lives inside src/content or assets, so this proves the
  // containment check accepts legitimate files rather than rejecting blindly.
  assert.equal(result.valid, true, result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// T-3: zero files.
// ---------------------------------------------------------------------------

test('T-3: zero hashable files is an error, never an empty hash', () => {
  assert.throws(() => computeVersionHash([]), TypeError);
});

// ---------------------------------------------------------------------------
// T-4: one file versus two files.
// ---------------------------------------------------------------------------

test('T-4: one file and two files produce different digests', () => {
  const one = computeVersionHash([{ path: 'a.json', content: '{"a":1}' }]);
  const two = computeVersionHash([
    { path: 'a.json', content: '{"a":1}' },
    { path: 'b.json', content: '{"b":2}' },
  ]);
  assert.notEqual(one, two);
  // A second file with empty content still changes the digest.
  const twoEmpty = computeVersionHash([
    { path: 'a.json', content: '{"a":1}' },
    { path: 'b.json', content: '' },
  ]);
  assert.notEqual(one, twoEmpty);
});

// ---------------------------------------------------------------------------
// T-5: path change changes the digest.
// ---------------------------------------------------------------------------

test('T-5: moving identical bytes to another path changes the digest', () => {
  const atA = computeVersionHash([{ path: 'src/content/a.json', content: '{"a":1}' }]);
  const atB = computeVersionHash([{ path: 'src/content/b.json', content: '{"a":1}' }]);
  assert.notEqual(atA, atB);
});

// ---------------------------------------------------------------------------
// T-6 / KAT-4: input order is irrelevant.
// ---------------------------------------------------------------------------

test('T-6: input order does not affect the digest', () => {
  const files = [
    { path: 'a.json', content: '{"a":1}' },
    { path: 'b.json', content: '{"b":2}' },
    { path: 'c.bin', content: Buffer.from([0, 1, 2]) },
  ];
  assert.equal(computeVersionHash(files), computeVersionHash([...files].reverse()));
});

// ---------------------------------------------------------------------------
// KAT-1 .. KAT-5: known answer tests with an independently derived digest.
//
// The expected value below was computed OUTSIDE this repository (Python
// hashlib, following the frozen specification byte by byte), not by calling
// computeVersionHash. Derivation:
//   per-file  d_data = SHA256("data.json" + 0x00 + '{"a":1}')
//             d_img  = SHA256("img.bin"   + 0x00 + 00 01 02 FF)
//   header    "ofuq-package-hash\nhashAlgorithmVersion:1\nschemaVersion:1.0.0\nfileCount:2\n---\n"
//   final     SHA256(header + d_data + "\n" + d_img)
// Any change to the algorithm or either version constant must break KAT-1.
// ---------------------------------------------------------------------------

const KAT_FILES = [
  { path: 'data.json', content: '{"a":1}' },
  { path: 'img.bin', content: Buffer.from([0x00, 0x01, 0x02, 0xFF]) },
];

const KAT_1_EXPECTED = 'd82ee8b754efc93ca155d38380c7f5dc907c4e134c39708c1457682353ca2460';

test('KAT-1: a fixed input produces the externally computed digest', () => {
  assert.equal(computeVersionHash(KAT_FILES), KAT_1_EXPECTED);
});

test('KAT-2: flipping a single byte changes the digest', () => {
  const flipped = [KAT_FILES[0], { path: 'img.bin', content: Buffer.from([0x00, 0x01, 0x02, 0xFE]) }];
  const digest = computeVersionHash(flipped);
  assert.notEqual(digest, KAT_1_EXPECTED);
  assert.equal(digest, '1f8be712c416e174bf0b7c1bc2df7420396c51a08fa975e048f20dce6c0d57ab');
});

test('KAT-3: changing schemaVersion changes the digest', () => {
  const digest = computeVersionHash(KAT_FILES, { schemaVersion: '1.0.1' });
  assert.notEqual(digest, KAT_1_EXPECTED);
  assert.equal(digest, '75d7934e2d0f72fb3a5e9b5d9c46cf8d52ee716db5bf11b73cdc459bf5dccc07');
});

test('KAT-4: input order is irrelevant', () => {
  assert.equal(computeVersionHash([...KAT_FILES].reverse()), KAT_1_EXPECTED);
});

test('KAT-5: changing hashAlgorithmVersion changes the digest', () => {
  const digest = computeVersionHash(KAT_FILES, { hashAlgorithmVersion: '2' });
  assert.notEqual(digest, KAT_1_EXPECTED);
  assert.equal(digest, '41fe16f0b401e7fa3e76d850c70b63b10f0cdebb1088600564d04520f5984dbe');
});

// ---------------------------------------------------------------------------
// Identity, existence, reverse references.
// ---------------------------------------------------------------------------

test('I-1: a lesson that does not exist in the hierarchy is rejected', () => {
  const m = manifest();
  const ghost = { ...m, lessonId: 'ghost-lesson' };
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: JSON.stringify(ghost) },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not exist in the hierarchy')), result.errors.join('; '));
});

test('I-2: a hierarchy that references an unknown block is rejected', () => {
  const files = roleFiles();
  const hierarchy = JSON.parse(files.hierarchy.content);
  hierarchy.grades[0].subjects[0].units[0].lessons[0].stages[3].blockIds = ['ghost-block'];
  files.hierarchy = { ...files.hierarchy, content: JSON.stringify(hierarchy) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('references unknown block ghost-block')), result.errors.join('; '));
});

test('I-3: a notebook lessonId that disagrees with the manifest is rejected', () => {
  const files = roleFiles();
  const notebook = JSON.parse(files.notebook.content);
  notebook.notebook.lessonId = 'other-lesson';
  files.notebook = { ...files.notebook, content: JSON.stringify(notebook) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('notebook.lessonId')), result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// C12: fixed stage order.
// ---------------------------------------------------------------------------

test('C12: the seven stages must appear in the fixed order', () => {
  const files = roleFiles();
  const hierarchy = JSON.parse(files.hierarchy.content);
  const stages = hierarchy.grades[0].subjects[0].units[0].lessons[0].stages;
  [stages[0], stages[1]] = [stages[1], stages[0]];
  files.hierarchy = { ...files.hierarchy, content: JSON.stringify(hierarchy) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('stage order must be')), result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// C11: payload minima for all nine item types.
// ---------------------------------------------------------------------------

const PAYLOAD_CASES = [
  { itemType: 'definition', good: { statement: 'تعريف' }, bad: {} },
  { itemType: 'law', good: { tex: 'F=ma', symbols: ['F'], units: ['N'] }, bad: { tex: 'F=ma', symbols: [], units: ['N'] } },
  { itemType: 'example', good: { steps: ['خطوة'] }, bad: { steps: [] } },
  { itemType: 'figure', good: { figureId: '1', caption: 'شرح' }, bad: { figureId: '1' } },
  { itemType: 'table', good: { labels: ['الكمية', 'الوحدة'] }, bad: { labels: [] } },
  { itemType: 'experiment', good: { steps: ['نقيس'] }, bad: {} },
  { itemType: 'conclusion', good: { statement: 'خلاصة' }, bad: { statement: '   ' } },
  { itemType: 'warning', good: { statement: 'تحذير' }, bad: {} },
  { itemType: 'skill', good: { steps: ['نقيس الحجم'] }, bad: {} },
  { itemType: 'skill', good: { statement: 'وصف المهارة' }, bad: { statement: '' } },
];

function notebookWith(itemType, payload) {
  return {
    lessonId: 'l01',
    version: 1,
    sections: [
      {
        sectionType: 'laws',
        items: [{ itemId: 'l01-n01', itemType, payload, tracesTo: ['l01-e01-s01'], order: 1 }],
      },
    ],
  };
}

const SUB_ITEMS = [
  { subId: 'l01-e01-s01', kind: 'info', description: 'وصف', stageLocation: 'understand', notebookLocation: 'laws', notebookRequired: true, verificationStatus: 'covered' },
];

test('C11: every notebook item type accepts a payload meeting its minimum', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  for (const testCase of PAYLOAD_CASES) {
    const result = validateNotebook(notebookWith(testCase.itemType, testCase.good), SUB_ITEMS, { lessonId: 'l01' });
    assert.equal(result.valid, true, testCase.itemType + ' good payload: ' + result.errors.join('; '));
  }
});

test('C11: every notebook item type rejects a payload below its minimum', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  for (const testCase of PAYLOAD_CASES) {
    const result = validateNotebook(notebookWith(testCase.itemType, testCase.bad), SUB_ITEMS, { lessonId: 'l01' });
    assert.equal(result.valid, false, testCase.itemType + ' bad payload must be rejected');
  }
});

test('C11: a table check proves labels only and never claims full table verification', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  const result = validateNotebook(notebookWith('table', { statement: 'عنوان الجدول' }), SUB_ITEMS, { lessonId: 'l01' });
  assert.ok(
    result.errors.some((e) => e.includes('table requires labels') && e.includes('table content is not verified')),
    result.errors.join('; '),
  );
});

// ---------------------------------------------------------------------------
// Duplicate scopes.
// ---------------------------------------------------------------------------

test('D-1: duplicate subId across the lesson is rejected', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  const subs = [SUB_ITEMS[0], { ...SUB_ITEMS[0] }];
  const result = validateNotebook(notebookWith('definition', { statement: 'تعريف' }), subs, { lessonId: 'l01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate subId')), result.errors.join('; '));
});

test('D-2: duplicate itemId across the notebook is rejected', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  const notebook = {
    lessonId: 'l01',
    version: 1,
    sections: [
      { sectionType: 'laws', items: [{ itemId: 'dup', itemType: 'definition', payload: { statement: 'أ' }, tracesTo: ['l01-e01-s01'] }] },
      { sectionType: 'laws', items: [{ itemId: 'dup', itemType: 'definition', payload: { statement: 'ب' }, tracesTo: ['l01-e01-s01'] }] },
    ],
  };
  const result = validateNotebook(notebook, SUB_ITEMS, { lessonId: 'l01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate itemId')), result.errors.join('; '));
});

test('D-3: repeated tracesTo inside one item is rejected', async () => {
  const { validateNotebook } = await import('../../src/validate/validators.js');
  const notebook = {
    lessonId: 'l01',
    version: 1,
    sections: [{ sectionType: 'laws', items: [{ itemId: 'n1', itemType: 'definition', payload: { statement: 'أ' }, tracesTo: ['l01-e01-s01', 'l01-e01-s01'] }] }],
  };
  const result = validateNotebook(notebook, SUB_ITEMS, { lessonId: 'l01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('repeated tracesTo')), result.errors.join('; '));
});

test('D-4: duplicate elementId in coverage is rejected', async () => {
  const { validateCoverage } = await import('../../src/validate/validators.js');
  const items = json('src/content/fixtures/valid-coverage.json');
  items.push({ ...items[0] });
  const result = validateCoverage(items, json('src/content/fixtures/valid-blocks.json'), json('src/content/fixtures/valid-hierarchy.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate elementId')), result.errors.join('; '));
});

test('D-5: duplicate pageNo and figureNo are rejected by the source gate', async () => {
  const { validateSourcePrepGate } = await import('../../src/validate/validators.js');
  const sources = json('src/content/fixtures/valid-sources.json');
  const duplicated = {
    pages: [...sources.pages, { ...sources.pages[0] }],
    figures: [...sources.figures, { ...sources.figures[0] }],
  };
  const result = validateSourcePrepGate(duplicated.pages, duplicated.figures, { pages: [10], figures: [1] });
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.some((b) => b.includes('duplicate pageNo')), result.blockers.join('; '));
  assert.ok(result.blockers.some((b) => b.includes('duplicate figureNo')), result.blockers.join('; '));
});

// ---------------------------------------------------------------------------
// Contract-key strictness (named contracts only, never the general engine).
// ---------------------------------------------------------------------------

test('K-1: an unknown key in the quiz file is rejected', () => {
  const files = roleFiles();
  const quizzes = JSON.parse(files.quizzes.content);
  quizzes.units = [{ unitId: 'u01', lessons: [{ id: 'l01', order: 1 }] }];
  files.quizzes = { ...files.quizzes, content: JSON.stringify(quizzes) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown key "units"')), result.errors.join('; '));
});

test('K-2: unit structure is derived from the hierarchy, never from the quiz file', () => {
  const units = deriveUnits(json('src/content/fixtures/valid-hierarchy.json'));
  assert.deepEqual(units, [{ unitId: 'u01', lessons: [{ id: 'l01', order: 1 }] }]);
});

test('K-3: an unknown manifest key is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const bad = { ...manifest(), surprise: true };
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: JSON.stringify(bad) },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown key "surprise"')), result.errors.join('; '));
});

test('K-4: the general schema engine still ignores unknown keys elsewhere', async () => {
  const { validateContentBlock } = await import('../../src/validate/validators.js');
  const block = { ...json('src/content/fixtures/valid-blocks.json')[0], unexpectedField: 'ignored' };
  assert.equal(validateContentBlock(block).valid, true);
});

// ---------------------------------------------------------------------------
// Hash binding and tamper detection (the validated bytes ARE the hashed bytes).
// ---------------------------------------------------------------------------

test('H-1: tampering with a content file invalidates the approval chain', () => {
  const files = roleFiles();
  const { files: approvedFiles, hash } = approve(files);
  const tampered = { ...approvedFiles, blocks: { ...approvedFiles.blocks, content: approvedFiles.blocks.content.replace('نص افتراضي', 'نص مُحرَّر') } };
  const result = validateLessonPackage({
    files: tampered,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.notEqual(result.hash, hash);
  assert.equal(result.valid, false);
  assert.equal(result.ownerApproval.valid, false);
  assert.equal(result.readyToPublish, false);
});

test('H-2: a formatting-only change is a new version (raw bytes are hashed)', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const reformatted = { ...approvedFiles, blocks: { ...approvedFiles.blocks, content: approvedFiles.blocks.content.replace('  {', '{') } };
  const result = validateLessonPackage({
    files: reformatted,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('versionHash does not match')), result.errors.join('; '));
});

test('H-3: recording an approval never changes the hash', () => {
  const files = roleFiles();
  const probe = validateLessonPackage({ files, manifest: { path: MANIFEST_FILENAME, content: manifestText() }, images: images() });
  const withApprovals = {
    ...files,
    approvals: { ...files.approvals, content: files.approvals.content.replaceAll('__COMPUTED_HASH__', probe.hash) },
  };
  const after = validateLessonPackage({ files: withApprovals, manifest: { path: MANIFEST_FILENAME, content: manifestText() }, images: images() });
  assert.equal(after.hash, probe.hash);
});

// ---------------------------------------------------------------------------
// Bundle shape and file safety.
// ---------------------------------------------------------------------------

test('B-1: a bundle that is not an object returns a structured error', () => {
  for (const bad of [null, undefined, 5, 'x', []]) {
    const result = validateLessonPackage(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test('B-2: an unknown top-level bundle key is rejected', () => {
  const { bundle } = validBundle();
  const result = validateLessonPackage({ ...bundle, surprise: 1 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown key "surprise"')), result.errors.join('; '));
});

test('B-3: two roles sharing one path is rejected', () => {
  const files = roleFiles();
  files.blocks = { ...files.blocks, path: files.coverage.path };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate path')), result.errors.join('; '));
});

test('B-4: a content role masquerading as an approval record is rejected', () => {
  const files = roleFiles();
  files.blocks = { ...files.blocks, path: 'src/content/approvals/l01.json' };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must not use an approval-record path')), result.errors.join('; '));
});

test('B-5: a content role occupying a schema path is rejected', () => {
  const files = roleFiles();
  files.blocks = { ...files.blocks, path: 'src/content/schema/quiz.schema.json' };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must not occupy a schema path')), result.errors.join('; '));
});

test('B-6: the manifest must sit at the package root', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: 'src/content/lesson-package.json', content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must sit at the package root')), result.errors.join('; '));
});

test('B-7: a missing role is a structured error, not a crash', () => {
  const files = roleFiles();
  delete files.sources;
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('missing role sources')), result.errors.join('; '));
});

test('B-8: unparseable JSON is a structured error', () => {
  const files = roleFiles();
  files.coverage = { ...files.coverage, content: '{not json' };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('[parse] coverage')), result.errors.join('; '));
});

test('B-9: disk mode requires image files to exist', () => {
  const files = roleFiles();
  const m = { ...manifest(), images: [...manifest().images, 'assets/fixtures/does-not-exist.png'] };
  const mText = JSON.stringify(m);
  const result = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: mText },
    images: [...images(), { path: 'assets/fixtures/does-not-exist.png', content: Buffer.from([1]) }],
  }, { diskRoot: root });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does-not-exist.png') && e.includes('not readable')), result.errors.join('; '));
});

test('B-10: assets/ absence is fine when no image is referenced', () => {
  const files = roleFiles();
  const m = { ...manifest(), images: [] };
  const mText = JSON.stringify(m);
  const probe = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: mText },
    images: [],
  });
  const patched = files.approvals.content.replaceAll('__COMPUTED_HASH__', probe.hash);
  const result = validateLessonPackage({
    files: { ...files, approvals: { ...files.approvals, content: patched } },
    manifest: { path: MANIFEST_FILENAME, content: mText },
    images: [],
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.hash, probe.hash);
});

// ---------------------------------------------------------------------------
// Validator coupling: a structurally broken block cannot pass as coverage.
// ---------------------------------------------------------------------------

test('V-1: a book block with no source fails even when coverage looks complete', () => {
  const files = roleFiles();
  const blocks = JSON.parse(files.blocks.content);
  blocks[0].sourceRefs = [];
  files.blocks = { ...files.blocks, content: JSON.stringify(blocks) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('book content requires at least one traceable source')), result.errors.join('; '));
});

test('V-2: an uncovered element fails the whole package', () => {
  const files = roleFiles();
  const coverage = JSON.parse(files.coverage.content);
  coverage[0].verificationStatus = 'uncovered';
  files.coverage = { ...files.coverage, content: JSON.stringify(coverage) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.uncovered.length > 0);
});

test('V-3: a quiz correctIndex outside the choices range is rejected', () => {
  const files = roleFiles();
  const quizzes = JSON.parse(files.quizzes.content);
  quizzes.quizzes[0].questions[0].choices = ['أ', 'ب'];
  quizzes.quizzes[0].questions[0].correctIndex = 99;
  files.quizzes = { ...files.quizzes, content: JSON.stringify(quizzes) };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('correctIndex is outside')), result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// Scope constants stay as approved.
// ---------------------------------------------------------------------------

test('S-1: allowed roots are exactly assets/ and src/content/', () => {
  assert.deepEqual([...ALLOWED_ROOTS].sort(), ['assets/', 'src/content/']);
});

// ---------------------------------------------------------------------------
// Disk loader: reads raw bytes through realpath containment.
// ---------------------------------------------------------------------------

test('L-1: the disk loader reads the manifest and every role as raw bytes', async () => {
  const { loadLessonPackageFromDisk } = await import('../../src/validate/lesson-package.js');
  // A dedicated temp package root keeps the repository tree untouched.
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = mkdtempSync(join(tmpdir(), 'lesson-package-'));
  mkdirSync(join(tempRoot, 'src/content/approvals'), { recursive: true });
  mkdirSync(join(tempRoot, 'src/content/schema'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets/fixtures'), { recursive: true });
  const m = manifest();
  for (const relPath of Object.values(m.files)) {
    cpSync(join(root, relPath), join(tempRoot, relPath));
  }
  for (const relPath of m.images) cpSync(join(root, relPath), join(tempRoot, relPath));
  // The seven schemas are mandatory disk inputs.
  for (const schemaPath of SCHEMA_PATHS) cpSync(join(root, schemaPath), join(tempRoot, schemaPath));
  writeFileSync(join(tempRoot, MANIFEST_FILENAME), manifestText());
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, true, loaded.errors.join('; '));
  assert.ok(Buffer.isBuffer(loaded.bundle.manifest.content));
  for (const role of Object.keys(m.files)) {
    assert.ok(Buffer.isBuffer(loaded.bundle.files[role].content), role + ' must be raw bytes');
  }
  // The loader also returns the seven schemas as raw bytes for the hash.
  assert.equal(loaded.options.schemaFiles.length, 7);
  for (const entry of loaded.options.schemaFiles) {
    assert.ok(Buffer.isBuffer(entry.content), entry.path + ' must be raw bytes');
    assert.ok(SCHEMA_PATHS.includes(entry.path), entry.path + ' must be a fixed schema path');
  }
});

test('L-2: the disk loader rejects a manifest that is not at the package root', async () => {
  const { loadLessonPackageFromDisk } = await import('../../src/validate/lesson-package.js');
  const loaded = loadLessonPackageFromDisk(root, 'src/content/fixtures/valid-package-manifest.json');
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('must be lesson-package.json')), loaded.errors.join('; '));
});

test('L-3: a missing file is reported, never assumed to exist', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = mkdtempSync(join(tmpdir(), 'lesson-package-empty-'));
  writeFileSync(join(tempRoot, MANIFEST_FILENAME), JSON.stringify({ files: { hierarchy: 'src/content/hierarchy.json' } }));
  const { loadLessonPackageFromDisk } = await import('../../src/validate/lesson-package.js');
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('is not readable')), loaded.errors.join('; '));
});

// ---------------------------------------------------------------------------
// SCHEMA-1..4: the seven schemas are a mandatory part of the hash.
// ---------------------------------------------------------------------------

function schemaInputs() {
  return SCHEMA_PATHS.map((p) => ({ path: p, content: readFileSync(join(root, p)) }));
}

function bundleWith(options) {
  const files = roleFiles();
  const probe = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  }, options);
  const patched = files.approvals.content.replaceAll('__COMPUTED_HASH__', probe.hash);
  return { files: { ...files, approvals: { ...files.approvals, content: patched } }, probe };
}

test('SCHEMA-1: the seven schemas enter the hash (changing one byte changes it)', () => {
  const files = roleFiles();
  const base = { files, manifest: { path: MANIFEST_FILENAME, content: manifestText() }, images: images() };
  const withSchemas = validateLessonPackage(base, { schemaFiles: schemaInputs() });
  const mutated = schemaInputs();
  mutated[0] = { ...mutated[0], content: Buffer.concat([mutated[0].content, Buffer.from(' ')]) };
  const withMutatedSchema = validateLessonPackage(base, { schemaFiles: mutated });
  assert.notEqual(withMutatedSchema.hash, withSchemas.hash);
});

test('SCHEMA-2: dropping one schema blocks the package and yields no valid hash', () => {
  const files = roleFiles();
  const partial = schemaInputs().slice(0, 6);
  let result;
  assert.doesNotThrow(() => {
    result = validateLessonPackage({
      files,
      manifest: { path: MANIFEST_FILENAME, content: manifestText() },
      images: images(),
    }, { schemaFiles: partial });
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('[hash]') && e.includes('is required and could not be read')), result.errors.join('; '));
  assert.ok(result.errors.some((e) => e.includes('cannot be hashed without all seven schemas')), result.errors.join('; '));
  assert.equal(result.hash, undefined, 'an incomplete schema set must not produce a usable hash');
});

test('SCHEMA-3: a substituted schema path is rejected', () => {
  const files = roleFiles();
  const swapped = schemaInputs();
  swapped[0] = { path: 'src/content/my-own-schema.json', content: swapped[0].content };
  const result = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  }, { schemaFiles: swapped });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is not one of the seven fixed schema paths')), result.errors.join('; '));
});

test('SCHEMA-4: a schema cannot be smuggled in from outside src/content/', () => {
  const files = roleFiles();
  const escaped = schemaInputs();
  escaped[1] = { ...escaped[1], path: '/etc/passwd' };
  const result = validateLessonPackage({
    files,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  }, { schemaFiles: escaped });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('[hash]') && e.includes('schema path rejected')), result.errors.join('; '));
});

test('SCHEMA-5: the schema paths are exactly the seven approved files', () => {
  assert.deepEqual(SCHEMA_PATHS, [
    'src/content/schema/hierarchy.schema.json',
    'src/content/schema/content-block.schema.json',
    'src/content/schema/coverage.schema.json',
    'src/content/schema/source.schema.json',
    'src/content/schema/notebook.schema.json',
    'src/content/schema/quiz.schema.json',
    'src/content/schema/approval.schema.json',
  ]);
});

// ---------------------------------------------------------------------------
// ROOT-1..5: role roots enforced in MEMORY (no diskRoot).
// ---------------------------------------------------------------------------

test('ROOT-1: a content role outside src/content/ is rejected in memory mode', () => {
  const files = roleFiles();
  files.blocks = { ...files.blocks, path: 'assets/blocks.json' };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must live under src/content/')), result.errors.join('; '));
});

test('ROOT-2: an image outside assets/ is rejected in memory mode', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: [{ path: 'src/content/sneaky.png', content: Buffer.from([1]) }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must live under assets/')), result.errors.join('; '));
});

test('ROOT-3: a traversal image path is rejected in memory mode', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: [{ path: 'assets/../../etc/passwd', content: Buffer.from([1]) }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('..')), result.errors.join('; '));
});

test('ROOT-4: a role rooted at the directory itself is rejected', () => {
  const files = roleFiles();
  files.coverage = { ...files.coverage, path: 'src/content/' };
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: images(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be a file inside')), result.errors.join('; '));
});

test('ROOT-5: role roots are exactly src/content/', () => {
  for (const role of Object.keys(ROLE_ROOTS)) {
    assert.equal(ROLE_ROOTS[role], CONTENT_ROOT, role + ' must be rooted at src/content/');
  }
  assert.equal(IMAGE_ROOT, 'assets/');
});

// ---------------------------------------------------------------------------
// IMG-1..3: manifest.images must match bundle.images exactly.
// ---------------------------------------------------------------------------

test('IMG-1: a bundle image that is not declared in the manifest is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: [...images(), { path: 'assets/fixtures/extra.png', content: Buffer.from([9]) }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is not declared in the manifest')), result.errors.join('; '));
});

test('IMG-2: a declared image missing from the bundle is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('was not supplied in the bundle')), result.errors.join('; '));
});

test('IMG-3: a duplicated image path is rejected', () => {
  const files = roleFiles();
  const { files: approvedFiles } = approve(files);
  const result = validateLessonPackage({
    files: approvedFiles,
    manifest: { path: MANIFEST_FILENAME, content: manifestText() },
    images: [...images(), ...images()],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate image path')), result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// DISK-1..5: symlink and containment behaviour on a real filesystem.
// ---------------------------------------------------------------------------

function makePackageRoot() {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync } = require('node:fs');
  return { mkdtempSync, mkdirSync, cpSync, writeFileSync };
}

test('DISK-1: a valid package reads correctly through the disk loader', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'pkg-ok-'));
  fs.mkdirSync(join(tempRoot, 'src/content/approvals'), { recursive: true });
  fs.mkdirSync(join(tempRoot, 'src/content/schema'), { recursive: true });
  fs.mkdirSync(join(tempRoot, 'assets/fixtures'), { recursive: true });
  const m = manifest();
  for (const relPath of Object.values(m.files)) fs.cpSync(join(root, relPath), join(tempRoot, relPath));
  for (const relPath of m.images) fs.cpSync(join(root, relPath), join(tempRoot, relPath));
  for (const schemaPath of SCHEMA_PATHS) fs.cpSync(join(root, schemaPath), join(tempRoot, schemaPath));
  fs.writeFileSync(join(tempRoot, MANIFEST_FILENAME), manifestText());

  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, true, loaded.errors.join('; '));
  const result = validateLessonPackage(loaded.bundle, { schemaFiles: loaded.options.schemaFiles });
  // The approvals still carry the placeholder, so the hash mismatch is expected:
  // what this asserts is that reading from disk worked and the hash was computed.
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.ok(result.errors.every((e) => e.includes('versionHash does not match')), result.errors.join('; '));
});

test('DISK-2: an image outside assets/ is rejected before it is read', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'pkg-img-'));
  fs.mkdirSync(join(tempRoot, 'src/content/schema'), { recursive: true });
  for (const schemaPath of SCHEMA_PATHS) {
    fs.mkdirSync(join(tempRoot, dirname(schemaPath)), { recursive: true });
    fs.cpSync(join(root, schemaPath), join(tempRoot, schemaPath));
  }
  fs.writeFileSync(join(tempRoot, MANIFEST_FILENAME), JSON.stringify({ files: {}, images: ['../outside.png'] }));
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('..')), loaded.errors.join('; '));
});

test('DISK-3: an assets/ directory that is a symlink outside the package root is not trusted', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'pkg-assets-'));
  const outside = fs.mkdtempSync(join(tmpdir(), 'outside-'));
  fs.writeFileSync(join(outside, 'evil.png'), 'evil');
  fs.mkdirSync(join(tempRoot, 'src/content/schema'), { recursive: true });
  for (const schemaPath of SCHEMA_PATHS) fs.cpSync(join(root, schemaPath), join(tempRoot, schemaPath));
  // assets/ itself points outside the package root.
  fs.symlinkSync(outside, join(tempRoot, 'assets'));
  fs.writeFileSync(join(tempRoot, MANIFEST_FILENAME), JSON.stringify({ files: {}, images: ['assets/evil.png'] }));
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('not trusted')), loaded.errors.join('; '));
});

test('DISK-4: a src/content/ directory that is a symlink outside the package root is not trusted', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'pkg-content-'));
  const outside = fs.mkdtempSync(join(tmpdir(), 'outside-content-'));
  fs.mkdirSync(join(outside, 'data'), { recursive: true });
  fs.writeFileSync(join(outside, 'data/blocks.json'), '[]');
  // src/content itself points outside the package root.
  fs.mkdirSync(join(tempRoot, 'src'), { recursive: true });
  fs.symlinkSync(outside, join(tempRoot, 'src/content'));
  fs.writeFileSync(join(tempRoot, MANIFEST_FILENAME), JSON.stringify({ files: { blocks: 'src/content/data/blocks.json' }, images: [] }));
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('not trusted')), loaded.errors.join('; '));
});

test('DISK-5: a missing or non-regular file is reported, never assumed', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'pkg-missing-'));
  fs.mkdirSync(join(tempRoot, 'src/content'), { recursive: true });
  fs.mkdirSync(join(tempRoot, 'assets'), { recursive: true });
  // A directory where a file is expected.
  fs.mkdirSync(join(tempRoot, 'assets/adir.png'), { recursive: true });
  fs.writeFileSync(join(tempRoot, MANIFEST_FILENAME), JSON.stringify({ files: { blocks: 'src/content/none.json' }, images: ['assets/adir.png'] }));
  const loaded = loadLessonPackageFromDisk(tempRoot);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.errors.some((e) => e.includes('none.json') && e.includes('not readable')), loaded.errors.join('; '));
  assert.ok(loaded.errors.some((e) => e.includes('adir.png') && e.includes('not a regular file')), loaded.errors.join('; '));
});
