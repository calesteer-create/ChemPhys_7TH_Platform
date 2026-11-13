import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_KEYS } from '../../src/validate/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = join(root, 'src/content/schema');
const load = (name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

const schemaFiles = readdirSync(schemaDir).filter((f) => f.endsWith('.json')).sort();

test('all seven schema files exist and parse as JSON', () => {
  assert.equal(schemaFiles.length, 7, `expected 7 schemas, found: ${schemaFiles.join(', ')}`);
  for (const file of schemaFiles) {
    const schema = load(file);
    assert.ok(typeof schema.title === 'string' && schema.title.length > 0, `${file}: title required`);
    assert.ok(schema.$schema, `${file}: $schema required`);
  }
});

test('hierarchy schema enforces exactly seven stages with fixed keys', () => {
  const schema = load('hierarchy.schema.json');
  const stages = schema.$defs.Lesson.properties.stages;
  assert.equal(stages.minItems, 7);
  assert.equal(stages.maxItems, 7);
  const keys = schema.$defs.StageKey.enum;
  assert.deepEqual([...keys].sort(), [...STAGE_KEYS].sort());
  assert.ok(schema.$defs.StageContent.properties.activityKind, 'conditional activityKind must exist');
  assert.ok(schema.$defs.Lesson.properties.order, 'lesson order must exist');
});

test('content-block schema enforces kinds, stage keys, and multiple sources', () => {
  const schema = load('content-block.schema.json');
  assert.deepEqual([...schema.properties.kind.enum].sort(), ['book', 'enrichment', 'explanation']);
  assert.deepEqual([...schema.properties.stageKey.enum].sort(), [...STAGE_KEYS].sort());
  assert.ok(schema.required.includes('sourceRefs'), 'sourceRefs must be required');
  assert.equal(schema.properties.sourceRefs.type, 'array');
  assert.ok(!('maxItems' in schema.properties.sourceRefs), 'no single-source cap allowed');
  assert.ok(schema.properties.bodyMarkdown, 'narrative Markdown body must exist');
});

test('coverage schema enforces element, info, and skill levels', () => {
  const schema = load('coverage.schema.json');
  const item = schema.$defs.CoverageItem;
  assert.ok(item.required.includes('sourceRefs'));
  assert.equal(item.properties.sourceRefs.minItems, 1);
  assert.ok(item.properties.stageLocation.enum.includes('understand'));
  const sub = schema.$defs.CoverageSubItem;
  assert.deepEqual([...sub.properties.kind.enum].sort(), ['info', 'skill']);
  assert.ok(sub.required.includes('notebookRequired'), 'conditional notebook flag must exist');
  assert.ok(sub.required.includes('stageLocation'));
});

test('source schema enforces clarity states and inspection fields', () => {
  const schema = load('source.schema.json');
  const page = schema.$defs.SourcePage;
  assert.deepEqual([...page.properties.clarityStatus.enum].sort(), ['clear', 'missing', 'unclear']);
  assert.ok(page.required.includes('inspectedBy'));
  assert.ok(page.required.includes('inspectedAt'));
  assert.ok(page.required.includes('imagePath'));
  const figure = schema.$defs.SourceFigure;
  assert.ok(figure.required.includes('figureNo'));
  assert.ok(figure.required.includes('pageNo'));
});

test('notebook schema enforces dynamic sections and full payloads', () => {
  const schema = load('notebook.schema.json');
  const section = schema.$defs.NotebookSection;
  assert.equal(section.properties.items.minItems, 1, 'empty sections are not allowed');
  assert.ok(section.properties.sectionType, 'sectionType must be open (dynamic)');
  assert.ok(!section.properties.sectionType.enum, 'sectionType must not be a fixed enum');
  const item = schema.$defs.NotebookItem;
  assert.ok(item.required.includes('tracesTo'));
  assert.ok(item.required.includes('payload'));
  assert.ok(item.properties.payload.properties.tex, 'law payload must carry tex');
  assert.ok(item.properties.payload.properties.units, 'law payload must carry units');
});

test('quiz schema enforces scope and unit authorization fields', () => {
  const schema = load('quiz.schema.json');
  assert.deepEqual([...schema.$defs.Quiz.properties.scope.enum].sort(), ['lesson', 'unit']);
  const auth = schema.$defs.UnitTestAuthorization;
  for (const field of ['unitId', 'lastLessonId', 'authorizedBy', 'authorizedAt']) {
    assert.ok(auth.required.includes(field), `authorization requires ${field}`);
  }
});

test('approval schema separates the four gates', () => {
  const schema = load('approval.schema.json');
  const gates = schema.$defs.ApprovalRecord.properties.gate.enum;
  for (const gate of ['A-automated', 'B-scientific', 'B-notebook-educational', 'C-owner', 'D-publishing']) {
    assert.ok(gates.includes(gate), `missing gate: ${gate}`);
  }
  assert.ok(schema.$defs.ApprovalRecord.required.includes('versionHash'));
  const scope = schema.$defs.VersionHashScope.properties;
  assert.ok(scope.includes, 'hash scope includes must exist');
  assert.ok(scope.excludes, 'hash scope excludes must exist');
});
