import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCoverage, createValidators, loadSchemas } from '../../src/validate/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'src/content/fixtures', name), 'utf8'));
const hierarchy = () => fixture('valid-hierarchy.json');
const blocks = () => fixture('valid-blocks.json');
const coverage = () => fixture('valid-coverage.json');

function emptyHierarchyLinks() {
  const data = hierarchy();
  for (const grade of data.grades) {
    for (const subject of grade.subjects) {
      for (const unit of subject.units) {
        for (const lesson of unit.lessons) {
          for (const stage of lesson.stages) stage.blockIds = [];
        }
      }
    }
  }
  return data;
}

test('D-3 baseline: coverage with a valid hierarchy passes', () => {
  const result = validateCoverage(coverage(), blocks(), hierarchy());
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('D-3: omitting the hierarchy argument is rejected, never silently skipped', () => {
  const result = validateCoverage(coverage(), blocks());
  assert.equal(result.valid, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.includes('hierarchy is required')), result.errors.join('; '));
});

test('D-3: hierarchy null is rejected with a structured error', () => {
  const result = validateCoverage(coverage(), blocks(), null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('hierarchy is required')), result.errors.join('; '));
});

test('D-3: hierarchy of an invalid type is rejected without throwing', () => {
  for (const bad of [5, 'x', true, [], [{ grades: [] }]]) {
    let result;
    assert.doesNotThrow(() => {
      result = validateCoverage(coverage(), blocks(), bad);
    });
    assert.equal(result.valid, false, 'hierarchy ' + JSON.stringify(bad) + ' must be rejected');
    assert.ok(result.errors.length > 0);
  }
});

test('D-3: a structurally invalid hierarchy object is rejected', () => {
  for (const bad of [{}, { grades: [] }, { platform: { id: 'x', title: 'y' } }]) {
    const result = validateCoverage(coverage(), blocks(), bad);
    assert.equal(result.valid, false, 'hierarchy ' + JSON.stringify(bad) + ' must be rejected');
    assert.ok(result.errors.some((e) => e.includes('hierarchy is required')), result.errors.join('; '));
  }
});

test('D-3: a block missing from the lesson hierarchy is rejected', () => {
  const result = validateCoverage(coverage(), blocks(), emptyHierarchyLinks());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is not in the lesson hierarchy')), result.errors.join('; '));
});

test('D-3: a block belonging to another lesson is rejected', () => {
  const shifted = blocks().map((b) => ({ ...b, lessonId: 'lesson-other' }));
  for (const data of [hierarchy(), emptyHierarchyLinks()]) {
    const result = validateCoverage(coverage(), shifted, data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('belongs to a different lesson')), result.errors.join('; '));
  }
});

test('D-3: a coverage element pointing at a stage that does not exist is rejected', () => {
  const items = coverage();
  items[0].stageLocation = 'notAStage';
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be one of')), result.errors.join('; '));
});

test('D-3: a coverage element declaring a stage that does not exist is rejected', () => {
  const items = coverage();
  const target = items.find((i) => Array.isArray(i.stageLocations) && i.stageLocations.length > 0);
  target.stageLocations = [...target.stageLocations, 'notAStage'];
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be one of')), result.errors.join('; '));
});

test('D-3: valid multi-block multi-stage coverage passes and no check is skipped', () => {
  const items = coverage();
  const multi = items.find((i) => (i.blockIds ?? []).length > 1);
  assert.ok(multi, 'fixture must contain an element treated by more than one block');
  assert.ok((multi.stageLocations ?? []).length > 1, 'fixture must declare more than one stage');
  const result = validateCoverage(items, blocks(), hierarchy());
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('R-1: a non-array block list is rejected instead of becoming an empty array', () => {
  for (const bad of [{}, 5, true, 'x', null, undefined]) {
    const result = validateCoverage(coverage(), bad, hierarchy());
    assert.equal(result.valid, false, 'blocks ' + JSON.stringify(bad) + ' must be rejected');
    assert.ok(result.errors.some((e) => e.includes('blocks must be an array')), result.errors.join('; '));
  }
});

test('R-1: a non-array block list is rejected even when the coverage items array is empty', () => {
  for (const bad of [{}, 5, true]) {
    const result = validateCoverage([], bad, hierarchy());
    assert.equal(result.valid, false, 'blocks ' + JSON.stringify(bad) + ' must be rejected');
    assert.ok(result.errors.some((e) => e.includes('blocks must be an array')), result.errors.join('; '));
    assert.equal(result.uncovered.length, 0);
  }
});

test('R-1: block entries that are not objects are rejected with structured errors', () => {
  const result = validateCoverage(coverage(), [...blocks(), null, 5], hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('blocks[') && e.includes('must be an object')), result.errors.join('; '));
});

test('R-1: duplicate block ids inside the block list are rejected', () => {
  const list = blocks();
  const result = validateCoverage(coverage(), [...list, { ...list[0] }], hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate block id in blocks')), result.errors.join('; '));
});

test('R-2: an empty coverage matrix is rejected by the schema constraint', () => {
  for (const data of [hierarchy(), null, 5]) {
    const result = validateCoverage([], blocks(), data);
    assert.equal(result.valid, false, 'empty coverage matrix must be rejected');
  }
  const result = validateCoverage([], blocks(), hierarchy());
  assert.ok(result.errors.some((e) => e.includes('at least 1 item')), result.errors.join('; '));
});

test('R-2: the minItems constraint comes from the schema and is enforced by the engine', () => {
  const schemas = loadSchemas();
  assert.equal(schemas.coverage.properties.items.minItems, 1);
  const mutated = structuredClone(schemas);
  mutated.coverage.properties.items.minItems = 99;
  const strict = createValidators(mutated);
  const result = strict.validateCoverage(coverage(), blocks(), hierarchy());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('at least 99 items')), result.errors.join('; '));
});
