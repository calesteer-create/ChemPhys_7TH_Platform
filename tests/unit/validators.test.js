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
const hierarchy = () => fixture('valid-hierarchy.json');
const blocks = () => fixture('valid-blocks.json');
const coverage = () => fixture('valid-coverage.json');

test('changing an enum constraint in the schema changes validation results', () => {
  const schemas = loadSchemas();
  const block = fixture('valid-blocks.json')[0];
  assert.equal(validateContentBlock(block).valid, true);
  const mutated = structuredClone(schemas);
  mutated.contentBlock.properties.stageKey.enum = mutated.contentBlock.properties.stageKey.enum.filter((k) => k !== 'understand');
  const strict = createValidators(mutated);
  const result = strict.validateContentBlock(block);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be one of')));
});

test('changing a type constraint in the schema changes validation results', () => {
  const schemas = loadSchemas();
  const block = fixture('valid-blocks.json')[0];
  const mutated = structuredClone(schemas);
  mutated.contentBlock.properties.order.type = 'string';
  const strict = createValidators(mutated);
  const result = strict.validateContentBlock(block);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be string')));
});

test('changing a minItems constraint in the schema changes validation results', () => {
  const schemas = loadSchemas();
  const block = fixture('valid-blocks.json')[0];
  const mutated = structuredClone(schemas);
  mutated.contentBlock.properties.sourceRefs.minItems = 99;
  const strict = createValidators(mutated);
  const result = strict.validateContentBlock(block);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least 99 items')));
});

test('notebook schema drives notebook validation', () => {
  const data = fixture('valid-notebook.json');
  assert.equal(validateNotebook(data.notebook, data.subItems, data.profile).valid, true);
  const schemas = loadSchemas();
  const mutated = structuredClone(schemas);
  mutated.notebook.$defs.NotebookItem.properties.itemType.enum = ['definition'];
  const strict = createValidators(mutated);
  const result = strict.validateNotebook(data.notebook, data.subItems, data.profile);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be one of')));
});

test('valid hierarchy passes', () => {
  const result = validateHierarchy(hierarchy());
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('hierarchy with missing stage fails', () => {
  const data = hierarchy();
  data.grades[0].subjects[0].units[0].lessons[0].stages.pop();
  const result = validateHierarchy(data);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least 7 items') || e.includes('exactly')));
});

test('valid blocks pass, including multi-source book block', () => {
  for (const block of blocks()) {
    const result = validateContentBlock(block);
    assert.equal(result.valid, true, block.id + ': ' + result.errors.join('; '));
  }
  const bookBlock = blocks().find((b) => b.kind === 'book');
  assert.ok(bookBlock.sourceRefs.length >= 2, 'book block must carry multiple sources');
});

test('book block without source fails', () => {
  const result = validateContentBlock(fixture('invalid-block-no-source.json'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least one traceable source')));
});

test('valid coverage passes with linked treatment blocks', () => {
  const result = validateCoverage(coverage(), blocks(), hierarchy());
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.uncovered, []);
});

test('coverage gap fails specifically because the element is uncovered', () => {
  const result = validateCoverage(fixture('invalid-coverage-gap.json'), blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.uncovered.includes('l01-bad01'));
  assert.ok(result.errors.some((e) => e.includes('uncovered') && e.includes('l01-bad01')));
  assert.ok(
    !result.errors.some((e) => e.includes('traceable source')),
    'failure must be due to uncovered status, not a missing source',
  );
});

test('covered element without treatment blocks is rejected', () => {
  const items = structuredClone(coverage());
  items[0].blockIds = [];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least one treatment block')));
});

test('covered element with missing block reference is rejected', () => {
  const items = structuredClone(coverage());
  items[0].blockIds = ['missing-block'];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('references missing block')));
});

test('existing block that does not treat the element is rejected', () => {
  const items = structuredClone(coverage());
  items[0].blockIds = ['l01-b03'];
  items[0].stageLocations = ['summary'];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not treat this element')));
});

test('block referencing an unknown element is rejected', () => {
  const allBlocks = blocks();
  allBlocks[2].coversElementIds = ['ghost-element'];
  const result = validateCoverage(coverage(), allBlocks, hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('references unknown element')));
});

test('duplicate blockIds are rejected', () => {
  const items = structuredClone(coverage());
  items[0].blockIds = ['l01-b01', 'l01-b01'];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must not contain duplicates')));
});

test('duplicate stageLocations are rejected', () => {
  const items = structuredClone(coverage());
  items[0].blockIds = ['l01-b01'];
  items[0].stageLocations = ['understand', 'understand'];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must not contain duplicates')));
});

test('block outside the lesson hierarchy is rejected', () => {
  const data = hierarchy();
  data.grades[0].subjects[0].units[0].lessons[0].stages = data.grades[0].subjects[0].units[0].lessons[0].stages.map(
    (s) => (s.stageKey === 'understand' ? { ...s, blockIds: [] } : s),
  );
  const result = validateCoverage(coverage(), blocks(), data);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is not in the lesson hierarchy')));
});

test('block stage mismatch with hierarchy position is rejected', () => {
  const allBlocks = blocks();
  allBlocks[0].stageKey = 'apply';
  const result = validateCoverage(coverage(), allBlocks, hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not match')));
});

test('single element treated in multiple stages is accepted', () => {
  const items = coverage();
  assert.deepEqual(items[0].stageLocations, ['understand', 'apply']);
  const result = validateCoverage(items, blocks(), hierarchy());
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
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('sourceRefs')));
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
    { pageNo: 1, imagePath: 'a.jpg', clarityStatus: 'clear', essential: true, inspectedBy: 'x', inspectedAt: 'y' },
    { pageNo: 2, imagePath: 'b.jpg', clarityStatus: 'unclear', essential: false, inspectedBy: 'x', inspectedAt: 'y' },
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
  const data = hierarchy();
  const allBlocks = blocks();
  const items = coverage();
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

  const lesson = data.grades[0].subjects[0].units[0].lessons[0];
  const blockIds = new Set(allBlocks.map((b) => b.id));
  for (const stage of lesson.stages) {
    for (const blockId of stage.blockIds) {
      assert.ok(blockIds.has(blockId), 'stage references existing block ' + blockId);
    }
  }
  for (const item of items) {
    for (const blockId of item.blockIds) {
      const block = allBlocks.find((b) => b.id === blockId);
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
    () => validateCoverage([null], null, null),
    () => validateCoverage([{ elementId: 'x', subItems: [null] }], null, null),
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
  const data = hierarchy();
  data.grades[0].subjects[0].units[0].lessons[0].stages[0] = null;
  let result;
  assert.doesNotThrow(() => {
    result = validateHierarchy(data);
  });
  assert.equal(result.valid, false);
});

test('validators layer is separated from presentation code', () => {
  const source = readFileSync(join(root, 'src/validate/validators.js'), 'utf8');
  assert.ok(!source.includes('main.js'), 'validators must not import presentation code');
  assert.ok(!source.includes('document.'), 'validators must not touch the DOM');
});
