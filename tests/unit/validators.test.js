import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createValidators,
  loadSchemas,
  validateHierarchy,
  validateContentBlock,
  validateCoverage,
  validateSourcePrepGate,
  validateLessonProfile,
  validateNotebook,
  validateQuiz,
  validateApprovalRecord,
} from '../../src/validate/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'src/content/fixtures', name), 'utf8'));

test('changing a schema constraint changes validation results', () => {
  const schemas = loadSchemas();
  const block = fixture('valid-blocks.json')[0];
  assert.equal(validateContentBlock(block).valid, true);
  const mutated = structuredClone(schemas);
  mutated.hierarchy.$defs.StageKey.enum = mutated.hierarchy.$defs.StageKey.enum.filter((k) => k !== 'understand');
  const strict = createValidators(mutated);
  const result = strict.validateContentBlock(block);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('stageKey is invalid')));
});

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
    assert.equal(result.valid, true, block.id + ': ' + result.errors.join('; '));
  }
  const bookBlock = blocks.find((b) => b.kind === 'book');
  assert.ok(bookBlock.sourceRefs.length >= 2, 'book block must carry multiple sources');
});

test('book block without source fails', () => {
  const result = validateContentBlock(fixture('invalid-block-no-source.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least one traceable source')));
});

test('valid coverage passes with linked treatment blocks', () => {
  const result = validateCoverage(fixture('valid-coverage.json'), fixture('valid-blocks.json'));
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.uncovered, []);
});

test('coverage gap fails specifically because the element is uncovered', () => {
  const result = validateCoverage(fixture('invalid-coverage-gap.json'), fixture('valid-blocks.json'));
  assert.equal(result.valid, false);
  assert.ok(result.uncovered.includes('l01-bad01'));
  assert.ok(result.errors.some((e) => e.includes('uncovered') && e.includes('l01-bad01')));
  assert.ok(
    !result.errors.some((e) => e.includes('traceable source')),
    'failure must be due to uncovered status, not a missing source',
  );
});

test('covered element without treatment blocks is rejected', () => {
  const items = structuredClone(fixture('valid-coverage.json'));
  items[0].blockIds = [];
  const result = validateCoverage(items, fixture('valid-blocks.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least one treatment block')));
});

test('covered element with missing block reference is rejected', () => {
  const items = structuredClone(fixture('valid-coverage.json'));
  items[0].blockIds = ['missing-block'];
  const result = validateCoverage(items, fixture('valid-blocks.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('references missing block')));
});

test('existing block that does not treat the element is rejected', () => {
  const items = structuredClone(fixture('valid-coverage.json'));
  items[0].blockIds = ['l01-b03'];
  items[0].stageLocations = ['summary'];
  const result = validateCoverage(items, fixture('valid-blocks.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not treat this element')));
});

test('single element treated in multiple stages is accepted', () => {
  const items = fixture('valid-coverage.json');
  assert.deepEqual(items[0].stageLocations, ['understand', 'apply']);
  const result = validateCoverage(items, fixture('valid-blocks.json'));
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('coverage without any source fails', () => {
  const items = [
    {
      elementId: 'x1',
      lessonId: 'l01',
      elementType: 'definition',
      referenceText: 'وصف افتراضي',
      sourceRefs: [],
      stageLocation: 'understand',
      verificationStatus: 'covered',
      blockIds: ['l01-b01'],
      subItems: [],
    },
  ];
  const result = validateCoverage(items, fixture('valid-blocks.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('traceable source')));
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

test('lesson without laws is not rejected for missing laws', () => {
  const profile = { lessonId: 'l01', hasLaws: false };
  assert.equal(validateLessonProfile(profile).valid, true);
  const data = fixture('valid-notebook.json');
  const result = validateNotebook(data.notebook, data.subItems, profile);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('invalid lesson profile fails', () => {
  assert.equal(validateLessonProfile(null).valid, false);
  assert.equal(validateLessonProfile({}).valid, false);
  assert.equal(validateLessonProfile({ lessonId: 'l01', hasLaws: 'yes' }).valid, false);
});

test('lesson quiz and authorized unit quiz pass with verified last lesson', () => {
  const data = fixture('valid-quiz.json');
  for (const quiz of data.quizzes) {
    const result = validateQuiz(quiz, data.authorizations, data.units);
    assert.equal(result.valid, true, quiz.id + ': ' + result.errors.join('; '));
  }
});

test('unit quiz without authorization fails', () => {
  const data = fixture('invalid-quiz-unit-no-auth.json');
  const result = validateQuiz(data.quizzes[0], data.authorizations, data.units);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('UnitTestAuthorization')));
});

test('unit quiz with wrong last lesson fails', () => {
  const data = fixture('invalid-quiz-wrong-last-lesson.json');
  const result = validateQuiz(data.quizzes[0], data.authorizations, data.units);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is not the last lesson')));
});

test('unit quiz without unit structure fails verification', () => {
  const data = fixture('valid-quiz.json');
  const unitQuiz = data.quizzes.find((q) => q.scope === 'unit');
  const result = validateQuiz(unitQuiz, data.authorizations, undefined);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unit structure required')));
});

test('clear sources with expected list do not block preparation', () => {
  const data = fixture('valid-sources.json');
  const result = validateSourcePrepGate(data.pages, data.figures, { pages: [10], figures: [1] });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('non-essential unclear source does not block preparation', () => {
  const pages = [
    { pageNo: 1, clarityStatus: 'clear', essential: true, inspectedBy: 'x', inspectedAt: 'y' },
    { pageNo: 2, clarityStatus: 'unclear', essential: false, inspectedBy: 'x', inspectedAt: 'y' },
  ];
  const result = validateSourcePrepGate(pages, [], { pages: [1], figures: [] });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.blockers, []);
});

test('unclear essential source blocks preparation', () => {
  const data = fixture('invalid-sources-unclear.json');
  const result = validateSourcePrepGate(data.pages, data.figures, { pages: [10], figures: [] });
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.some((b) => b.includes('page 10')));
});

test('empty essential source list blocks preparation', () => {
  const result = validateSourcePrepGate([], [], { pages: [], figures: [] });
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.some((b) => b.includes('no essential sources')));
});

test('expected source without inspection record blocks preparation', () => {
  const data = fixture('valid-sources.json');
  const result = validateSourcePrepGate(data.pages, data.figures, { pages: [10, 99], figures: [1] });
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.some((b) => b.includes('page 99')));
});

test('coherent fictional lesson passes all validators together', () => {
  const hierarchy = fixture('valid-hierarchy.json');
  const blocks = fixture('valid-blocks.json');
  const coverage = fixture('valid-coverage.json');
  const sources = fixture('valid-sources.json');
  const notebookData = fixture('valid-notebook.json');
  const quizData = fixture('valid-quiz.json');

  assert.equal(validateHierarchy(hierarchy).valid, true);
  for (const block of blocks) assert.equal(validateContentBlock(block).valid, true);
  assert.equal(validateCoverage(coverage, blocks).valid, true);
  assert.equal(validateSourcePrepGate(sources.pages, sources.figures, { pages: [10], figures: [1] }).blocked, false);
  assert.equal(validateNotebook(notebookData.notebook, notebookData.subItems, notebookData.profile).valid, true);
  for (const quiz of quizData.quizzes) {
    assert.equal(validateQuiz(quiz, quizData.authorizations, quizData.units).valid, true);
  }

  const lesson = hierarchy.grades[0].subjects[0].units[0].lessons[0];
  const blockIds = new Set(blocks.map((b) => b.id));
  for (const stage of lesson.stages) {
    for (const blockId of stage.blockIds) {
      assert.ok(blockIds.has(blockId), 'stage references existing block ' + blockId);
    }
  }
  for (const item of coverage) {
    for (const blockId of item.blockIds) {
      const block = blocks.find((b) => b.id === blockId);
      assert.ok(block.coversElementIds.includes(item.elementId));
      assert.ok(item.stageLocations.includes(block.stageKey));
    }
  }
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

test('validators return errors instead of throwing on malformed input', () => {
  const calls = [
    () => validateHierarchy(null),
    () => validateHierarchy(undefined),
    () => validateHierarchy({}),
    () => validateHierarchy({ grades: null }),
    () => validateHierarchy({ grades: [null] }),
    () => validateContentBlock(null),
    () => validateContentBlock({}),
    () => validateCoverage(null),
    () => validateCoverage([null]),
    () => validateCoverage([{ elementId: 'x', subItems: [null] }], null),
    () => validateLessonProfile(null),
    () => validateNotebook(null, null, null),
    () => validateNotebook({ lessonId: 'l01', sections: [null] }, null, null),
    () => validateNotebook({ lessonId: 'l01', sections: [{ sectionType: 'laws', items: [null] }] }, [], null),
    () => validateQuiz(null, null, null),
    () => validateQuiz({}, null, null),
    () => validateApprovalRecord(null),
    () => validateApprovalRecord({}),
  ];
  for (const call of calls) {
    let result;
    assert.doesNotThrow(() => {
      result = call();
    });
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  }
});

test('source gate returns blockers instead of throwing on malformed input', () => {
  for (const call of [
    () => validateSourcePrepGate(null, null),
    () => validateSourcePrepGate([null], [null]),
    () => validateSourcePrepGate(undefined, undefined, undefined),
  ]) {
    let result;
    assert.doesNotThrow(() => {
      result = call();
    });
    assert.equal(result.blocked, true);
    assert.ok(Array.isArray(result.blockers) && result.blockers.length > 0);
  }
});

test('hierarchy with null stage entries fails without throwing', () => {
  const hierarchy = fixture('valid-hierarchy.json');
  hierarchy.grades[0].subjects[0].units[0].lessons[0].stages[0] = null;
  let result;
  assert.doesNotThrow(() => {
    result = validateHierarchy(hierarchy);
  });
  assert.equal(result.valid, false);
});

test('validators layer is separated from presentation code', () => {
  const source = readFileSync(join(root, 'src/validate/validators.js'), 'utf8');
  assert.ok(!source.includes('main.js'), 'validators must not import presentation code');
  assert.ok(!source.includes('document.'), 'validators must not touch the DOM');
});
