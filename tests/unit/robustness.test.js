import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHierarchy } from '../../src/validate/validators.js';

const BAD_VALUES = [{}, 5, true, null, undefined];

function baseHierarchy() {
  return {
    platform: { id: 'ofuq', title: 'أفق العلوم' },
    grades: [
      {
        id: 'g7',
        title: 'الصف السابع',
        subjects: [
          {
            id: 'sci',
            title: 'العلوم',
            units: [
              {
                id: 'u01',
                title: 'وحدة افتراضية',
                order: 1,
                lessons: [
                  {
                    id: 'l01',
                    title: 'درس افتراضي',
                    order: 1,
                    stages: [
                      { stageKey: 'orient', blockIds: [], activityKind: null },
                      { stageKey: 'discover', blockIds: [], activityKind: null },
                      { stageKey: 'labOrActivity', blockIds: [], activityKind: 'activity' },
                      { stageKey: 'understand', blockIds: [], activityKind: null },
                      { stageKey: 'apply', blockIds: [], activityKind: null },
                      { stageKey: 'selfTest', blockIds: [], activityKind: null },
                      { stageKey: 'summary', blockIds: [], activityKind: null },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function assertInvalidWithoutThrowing(hierarchy, label) {
  let result;
  assert.doesNotThrow(() => {
    result = validateHierarchy(hierarchy);
  }, label + ' must not throw');
  assert.equal(result.valid, false, label + ' must be invalid');
  assert.ok(result.errors.length > 0, label + ' must report errors');
}

test('grades with wrong types are rejected without throwing', () => {
  for (const bad of BAD_VALUES) {
    const hierarchy = baseHierarchy();
    hierarchy.grades = bad;
    assertInvalidWithoutThrowing(hierarchy, 'grades=' + JSON.stringify(bad));
  }
});

test('subjects with wrong types are rejected without throwing', () => {
  for (const bad of BAD_VALUES) {
    const hierarchy = baseHierarchy();
    hierarchy.grades[0].subjects = bad;
    assertInvalidWithoutThrowing(hierarchy, 'subjects=' + JSON.stringify(bad));
  }
});

test('units with wrong types are rejected without throwing', () => {
  for (const bad of BAD_VALUES) {
    const hierarchy = baseHierarchy();
    hierarchy.grades[0].subjects[0].units = bad;
    assertInvalidWithoutThrowing(hierarchy, 'units=' + JSON.stringify(bad));
  }
});

test('lessons with wrong types are rejected without throwing', () => {
  for (const bad of BAD_VALUES) {
    const hierarchy = baseHierarchy();
    hierarchy.grades[0].subjects[0].units[0].lessons = bad;
    assertInvalidWithoutThrowing(hierarchy, 'lessons=' + JSON.stringify(bad));
  }
});

test('valid arrays pass and arrays with invalid elements fail without throwing', () => {
  assert.equal(validateHierarchy(baseHierarchy()).valid, true);
  const hierarchy = baseHierarchy();
  hierarchy.grades[0].subjects[0].units[0].lessons = [null, 5, 'x'];
  assertInvalidWithoutThrowing(hierarchy, 'lessons with invalid elements');
});
