// Task 004 validators: pure logic layer. No DOM, no rendering, no imports from
// presentation code. Every function returns { valid, errors } and never throws
// on malformed input (malformed input is reported as errors).
//
// The seven JSON schemas under src/content/schema are the single source of
// truth for enumerations and required fields. createValidators binds the
// checks to a given schema set, so changing a constraint in a schema changes
// validation results. Cross-entity rules that JSON Schema cannot express
// (source prep gate, coverage-to-block linkage, last-lesson verification,
// version-hash binding) are implemented as explicit code checks below.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'schema');

function loadSchema(name) {
  return JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));
}

export function loadSchemas() {
  return {
    hierarchy: loadSchema('hierarchy.schema.json'),
    contentBlock: loadSchema('content-block.schema.json'),
    coverage: loadSchema('coverage.schema.json'),
    source: loadSchema('source.schema.json'),
    notebook: loadSchema('notebook.schema.json'),
    quiz: loadSchema('quiz.schema.json'),
    approval: loadSchema('approval.schema.json'),
  };
}

export function createValidators(schemas) {
  const STAGE_KEYS = schemas.hierarchy.$defs.StageKey.enum;
  const CONTENT_KINDS = schemas.contentBlock.properties.kind.enum;
  const BLOCK_TYPES = schemas.contentBlock.properties.blockType.enum;
  const ELEMENT_TYPES = schemas.coverage.$defs.CoverageItem.properties.elementType.enum;
  const VERIFICATION_STATUSES = schemas.coverage.$defs.CoverageItem.properties.verificationStatus.enum;
  const CLARITY_STATUSES = schemas.source.$defs.SourcePage.properties.clarityStatus.enum;
  const APPROVAL_GATES = schemas.approval.$defs.ApprovalRecord.properties.gate.enum;
  const BLOCK_REQUIRED = schemas.contentBlock.required;
  const ITEM_REQUIRED = schemas.coverage.$defs.CoverageItem.required;
  const SUB_REQUIRED = schemas.coverage.$defs.CoverageSubItem.required;
  const QUIZ_REQUIRED = schemas.quiz.$defs.Quiz.required;
  const AUTH_REQUIRED = schemas.quiz.$defs.UnitTestAuthorization.required;
  const RECORD_REQUIRED = schemas.approval.$defs.ApprovalRecord.required;

  function result(errors) {
    return { valid: errors.length === 0, errors };
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function missingRequired(obj, required) {
    const missing = [];
    for (const field of required ?? []) {
      const value = obj?.[field];
      if (value === undefined || value === null || value === '') missing.push(field);
    }
    return missing;
  }

  function checkSourceRef(ref, label, errors) {
    if (!ref || typeof ref !== 'object') {
      errors.push(label + ': source ref must be an object');
      return;
    }
    if (!isNonEmptyString(ref.bookTitle)) errors.push(label + ': bookTitle is required');
    if (!Number.isInteger(ref.page) || ref.page < 1) errors.push(label + ': page must be an integer >= 1');
  }

  function validateHierarchy(hierarchy) {
    const errors = [];
    if (!hierarchy || typeof hierarchy !== 'object') return result(['hierarchy must be an object']);
    if (!hierarchy.platform || !isNonEmptyString(hierarchy.platform.id)) {
      errors.push('platform.id is required');
    }
    if (!hierarchy.platform || !isNonEmptyString(hierarchy.platform.title)) {
      errors.push('platform.title is required');
    }
    if (!Array.isArray(hierarchy.grades) || hierarchy.grades.length === 0) {
      errors.push('grades must be a non-empty array');
      return result(errors);
    }
    const lessonIds = new Set();
    for (const grade of hierarchy.grades) {
      if (!grade || !isNonEmptyString(grade.id)) errors.push('grade.id is required');
      if (!Array.isArray(grade?.subjects) || grade.subjects.length === 0) {
        errors.push('grade ' + (grade?.id ?? '?') + ': subjects must be a non-empty array');
        continue;
      }
      for (const subject of grade.subjects) {
        if (!subject || !isNonEmptyString(subject.id)) errors.push('subject.id is required');
        if (!Array.isArray(subject?.units) || subject.units.length === 0) {
          errors.push('subject ' + (subject?.id ?? '?') + ': units must be a non-empty array');
          continue;
        }
        for (const unit of subject.units) {
          if (!unit || !isNonEmptyString(unit.id)) errors.push('unit.id is required');
          if (!Number.isInteger(unit?.order) || unit.order < 1) {
            errors.push('unit ' + (unit?.id ?? '?') + ': order must be an integer >= 1');
          }
          if (!Array.isArray(unit?.lessons) || unit.lessons.length === 0) {
            errors.push('unit ' + (unit?.id ?? '?') + ': lessons must be a non-empty array');
            continue;
          }
          for (const lesson of unit.lessons) {
            if (!lesson || !isNonEmptyString(lesson.id)) {
              errors.push('lesson.id is required');
              continue;
            }
            if (lessonIds.has(lesson.id)) errors.push('duplicate lesson id: ' + lesson.id);
            lessonIds.add(lesson.id);
            if (!Number.isInteger(lesson.order) || lesson.order < 1) {
              errors.push('lesson ' + lesson.id + ': order must be an integer >= 1');
            }
            if (!Array.isArray(lesson.stages) || lesson.stages.length !== STAGE_KEYS.length) {
              errors.push('lesson ' + lesson.id + ': stages must contain exactly ' + STAGE_KEYS.length + ' entries');
              continue;
            }
            const keys = lesson.stages.map((s) => s?.stageKey);
            const keySet = new Set(keys);
            if (keySet.size !== STAGE_KEYS.length || !STAGE_KEYS.every((k) => keySet.has(k))) {
              errors.push('lesson ' + lesson.id + ': stages must cover exactly the stage keys from the schema');
            }
            for (const stage of lesson.stages) {
              if (!stage || typeof stage !== 'object') {
                errors.push('lesson ' + lesson.id + ': stage entry must be an object');
                continue;
              }
              if (stage.stageKey === 'labOrActivity') {
                if (stage.activityKind !== 'simulation' && stage.activityKind !== 'activity') {
                  errors.push('lesson ' + lesson.id + ': labOrActivity requires activityKind simulation|activity');
                }
              } else if (stage.activityKind !== null && stage.activityKind !== undefined) {
                errors.push('lesson ' + lesson.id + ': activityKind must be null outside labOrActivity');
              }
              if (!Array.isArray(stage.blockIds)) {
                errors.push('lesson ' + lesson.id + ' stage ' + stage.stageKey + ': blockIds must be an array');
              }
            }
          }
        }
      }
    }
    return result(errors);
  }

  function validateContentBlock(block) {
    const errors = [];
    if (!block || typeof block !== 'object') return result(['block must be an object']);
    const label = 'block ' + (block.id ?? '?');
    for (const field of missingRequired(block, BLOCK_REQUIRED)) {
      errors.push(label + ': ' + field + ' is required');
    }
    if (!STAGE_KEYS.includes(block.stageKey)) errors.push(label + ': stageKey is invalid');
    if (!CONTENT_KINDS.includes(block.kind)) errors.push(label + ': kind is invalid');
    if (!BLOCK_TYPES.includes(block.blockType)) errors.push(label + ': blockType is invalid');
    if (!Array.isArray(block.sourceRefs)) {
      errors.push(label + ': sourceRefs must be an array');
    } else {
      block.sourceRefs.forEach((ref, i) => checkSourceRef(ref, label + ' sourceRefs[' + i + ']', errors));
      if (block.kind === 'book' && block.sourceRefs.length < 1) {
        errors.push(label + ': book content requires at least one traceable source');
      }
    }
    if (block.bodyMarkdown !== undefined && typeof block.bodyMarkdown !== 'string') {
      errors.push(label + ': bodyMarkdown must be a string');
    }
    if (block.coversElementIds !== undefined && !Array.isArray(block.coversElementIds)) {
      errors.push(label + ': coversElementIds must be an array');
    }
    return result(errors);
  }

  // blocks: the lesson's content blocks. A covered/verified element is only
  // accepted when its blockIds resolve to real blocks that back-reference the
  // element and sit in the declared stage locations. The status flag alone
  // never proves completeness.
  function validateCoverage(items, blocks) {
    const errors = [];
    const uncovered = [];
    if (!Array.isArray(items)) return { valid: false, errors: ['items must be an array'], uncovered };
    const blockList = Array.isArray(blocks) ? blocks : [];
    const blockById = new Map();
    for (const block of blockList) {
      if (block && isNonEmptyString(block.id)) blockById.set(block.id, block);
    }
    const elementIds = new Set();
    for (const item of items) {
      const label = 'element ' + (item?.elementId ?? '?');
      if (!item || typeof item !== 'object') {
        errors.push('coverage item must be an object');
        continue;
      }
      for (const field of missingRequired(item, ITEM_REQUIRED)) {
        errors.push(label + ': ' + field + ' is required');
      }
      if (!isNonEmptyString(item.elementId)) errors.push('elementId is required');
      else if (elementIds.has(item.elementId)) errors.push('duplicate elementId: ' + item.elementId);
      else elementIds.add(item.elementId);
      if (!ELEMENT_TYPES.includes(item.elementType)) errors.push(label + ': elementType is invalid');
      if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1) {
        errors.push(label + ': at least one traceable source is required');
      } else {
        item.sourceRefs.forEach((ref, i) => checkSourceRef(ref, label + ' sourceRefs[' + i + ']', errors));
      }
      if (!STAGE_KEYS.includes(item.stageLocation)) errors.push(label + ': stageLocation is invalid');
      if (Array.isArray(item.stageLocations)) {
        for (const stage of item.stageLocations) {
          if (!STAGE_KEYS.includes(stage)) errors.push(label + ': stageLocations entry ' + stage + ' is invalid');
        }
      }
      if (!VERIFICATION_STATUSES.includes(item.verificationStatus)) {
        errors.push(label + ': verificationStatus is invalid');
      }
      if (item.verificationStatus === 'uncovered') {
        uncovered.push(item.elementId);
        errors.push(label + ' is uncovered (incomplete coverage)');
      }
      if (item.verificationStatus === 'covered' || item.verificationStatus === 'verified') {
        if (!Array.isArray(item.blockIds) || item.blockIds.length === 0) {
          errors.push(label + ': covered element requires at least one treatment block');
        } else {
          const allowedStages = Array.isArray(item.stageLocations) && item.stageLocations.length > 0
            ? item.stageLocations
            : [item.stageLocation];
          for (const blockId of item.blockIds) {
            const block = blockById.get(blockId);
            if (!block) {
              errors.push(label + ': references missing block ' + blockId);
              continue;
            }
            if (block.lessonId !== item.lessonId) {
              errors.push(label + ': block ' + blockId + ' belongs to a different lesson');
            }
            if (!(block.coversElementIds ?? []).includes(item.elementId)) {
              errors.push(label + ': block ' + blockId + ' does not treat this element');
            }
            if (!allowedStages.includes(block.stageKey)) {
              errors.push(label + ': block ' + blockId + ' stage ' + block.stageKey + ' does not match declared stage locations');
            }
          }
        }
      }
      for (const sub of item.subItems ?? []) {
        const subLabel = 'sub ' + (sub?.subId ?? '?');
        if (!sub || typeof sub !== 'object') {
          errors.push(label + ': sub-item must be an object');
          continue;
        }
        for (const field of missingRequired(sub, SUB_REQUIRED)) {
          errors.push(subLabel + ': ' + field + ' is required');
        }
        if (sub.kind !== 'info' && sub.kind !== 'skill') errors.push(subLabel + ': kind must be info|skill');
        if (!STAGE_KEYS.includes(sub.stageLocation)) errors.push(subLabel + ': stageLocation is invalid');
        if (typeof sub.notebookRequired !== 'boolean') errors.push(subLabel + ': notebookRequired must be boolean');
        if (!VERIFICATION_STATUSES.includes(sub.verificationStatus)) {
          errors.push(subLabel + ': verificationStatus is invalid');
        }
        if (sub.verificationStatus === 'uncovered') {
          uncovered.push(sub.subId);
          errors.push(subLabel + ' is uncovered (incomplete coverage)');
        }
      }
    }
    return { valid: errors.length === 0, errors, uncovered };
  }

  // expected: { pages: [pageNo...], figures: [figureNo...] } — the essential
  // sources that must exist. Preparation is blocked when the essential list is
  // empty, when an expected source has no record, or when any essential record
  // is not clear. Checking only existing records is not sufficient.
  function validateSourcePrepGate(pages, figures, expected) {
    const blockers = [];
    const allPages = Array.isArray(pages) ? pages : [];
    const allFigures = Array.isArray(figures) ? figures : [];
    const expectedPages = Array.isArray(expected?.pages) ? expected.pages : [];
    const expectedFigures = Array.isArray(expected?.figures) ? expected.figures : [];

    const essentialPages = allPages.filter((p) => p?.essential !== false);
    const essentialFigures = allFigures.filter((f) => f?.essential !== false);
    if (essentialPages.length + essentialFigures.length === 0) {
      blockers.push('no essential sources provided');
    }

    const recordedPages = new Set(allPages.map((p) => p?.pageNo));
    for (const pageNo of expectedPages) {
      if (!recordedPages.has(pageNo)) blockers.push('expected essential page ' + pageNo + ' has no inspection record');
    }
    const recordedFigures = new Set(allFigures.map((f) => String(f?.figureNo)));
    for (const figureNo of expectedFigures) {
      if (!recordedFigures.has(String(figureNo))) {
        blockers.push('expected essential figure ' + figureNo + ' has no inspection record');
      }
    }

    for (const page of essentialPages) {
      if (!CLARITY_STATUSES.includes(page?.clarityStatus)) {
        blockers.push('page ' + (page?.pageNo ?? '?') + ': clarityStatus is invalid');
      } else if (page.clarityStatus !== 'clear') {
        blockers.push('page ' + page.pageNo + ': essential source is ' + page.clarityStatus);
      }
    }
    for (const figure of essentialFigures) {
      if (!CLARITY_STATUSES.includes(figure?.clarityStatus)) {
        blockers.push('figure ' + (figure?.figureNo ?? '?') + ': clarityStatus is invalid');
      } else if (figure.clarityStatus !== 'clear') {
        blockers.push('figure ' + figure.figureNo + ' (page ' + figure.pageNo + '): essential source is ' + figure.clarityStatus);
      }
    }
    return { blocked: blockers.length > 0, blockers };
  }

  // Minimum structural requirements for a valid lesson profile. A lesson
  // without laws is valid: capability flags are optional booleans and no
  // section is forced by their absence.
  function validateLessonProfile(profile) {
    const errors = [];
    if (!profile || typeof profile !== 'object') return result(['profile must be an object']);
    if (!isNonEmptyString(profile.lessonId)) errors.push('profile.lessonId is required');
    const flags = ['hasLaws', 'hasExperiments', 'hasFigures', 'hasWorkedExamples', 'hasTables', 'hasSkills'];
    for (const flag of flags) {
      if (profile[flag] !== undefined && typeof profile[flag] !== 'boolean') {
        errors.push('profile.' + flag + ' must be a boolean');
      }
    }
    return result(errors);
  }

  function checkNotebookPayload(item, label, errors) {
    const payload = item.payload;
    if (!payload || typeof payload !== 'object') {
      errors.push(label + ': payload is required');
      return;
    }
    switch (item.itemType) {
      case 'definition':
        if (!isNonEmptyString(payload.statement)) errors.push(label + ': definition requires statement');
        break;
      case 'law':
        if (!isNonEmptyString(payload.tex)) errors.push(label + ': law requires tex');
        if (!Array.isArray(payload.symbols) || payload.symbols.length === 0) {
          errors.push(label + ': law requires symbols');
        }
        if (!Array.isArray(payload.units) || payload.units.length === 0) {
          errors.push(label + ': law requires units');
        }
        break;
      case 'example':
        if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
          errors.push(label + ': example requires steps');
        }
        break;
      case 'figure':
        if (!isNonEmptyString(payload.figureId)) errors.push(label + ': figure requires figureId');
        if (!isNonEmptyString(payload.caption)) errors.push(label + ': figure requires caption');
        break;
      default:
        break;
    }
  }

  function validateNotebook(notebook, subItems, profile) {
    const errors = [];
    if (!notebook || typeof notebook !== 'object') return result(['notebook must be an object']);
    if (!isNonEmptyString(notebook.lessonId)) errors.push('notebook.lessonId is required');
    if (!Array.isArray(notebook.sections)) return result([...errors, 'notebook.sections must be an array']);
    if (profile !== undefined && profile !== null) {
      errors.push(...validateLessonProfile(profile).errors);
    }

    const requiredSubs = new Map();
    for (const sub of subItems ?? []) {
      if (sub?.notebookRequired === true) requiredSubs.set(sub.subId, sub);
    }
    const knownSubs = new Set((subItems ?? []).map((s) => s?.subId));
    const traced = new Set();

    for (const section of notebook.sections) {
      const sectionLabel = 'section ' + (section?.sectionType ?? '?');
      if (!section || typeof section !== 'object') {
        errors.push('notebook section must be an object');
        continue;
      }
      if (!isNonEmptyString(section.sectionType)) errors.push('sectionType is required');
      if (!Array.isArray(section.items) || section.items.length === 0) {
        errors.push(sectionLabel + ': empty sections are not allowed');
        continue;
      }
      for (const item of section.items) {
        const label = 'item ' + (item?.itemId ?? '?');
        if (!item || typeof item !== 'object') {
          errors.push(sectionLabel + ': notebook item must be an object');
          continue;
        }
        if (!isNonEmptyString(item.itemId)) errors.push(sectionLabel + ': itemId is required');
        if (!Array.isArray(item.tracesTo) || item.tracesTo.length === 0) {
          errors.push(label + ': tracesTo must reference at least one coverage sub-item');
        } else {
          for (const subId of item.tracesTo) {
            if (!knownSubs.has(subId)) errors.push(label + ': unknown tracesTo ' + subId + ' (orphan)');
            else traced.add(subId);
          }
        }
        checkNotebookPayload(item, label, errors);
      }
    }

    for (const subId of requiredSubs.keys()) {
      if (!traced.has(subId)) errors.push('required sub-item ' + subId + ' has no notebook item');
    }

    if (profile && profile.hasLaws === true) {
      const hasLawsSection = notebook.sections.some((s) => s?.sectionType === 'laws');
      const hasRequiredLaw = [...requiredSubs.values()].some(
        (s) => s.notebookLocation === 'laws',
      );
      if (hasRequiredLaw && !hasLawsSection) {
        errors.push('profile hasLaws with required law items requires a laws section');
      }
    }

    return result(errors);
  }

  // units: [{ unitId, lessons: [{ id, order }] }] — used to verify that the
  // authorized lastLessonId is the actual last lesson of the unit by order.
  function validateQuiz(quiz, authorizations, units) {
    const errors = [];
    if (!quiz || typeof quiz !== 'object') return result(['quiz must be an object']);
    const label = 'quiz ' + (quiz.id ?? '?');
    for (const field of missingRequired(quiz, QUIZ_REQUIRED)) {
      errors.push(label + ': ' + field + ' is required');
    }
    if (quiz.scope !== 'lesson' && quiz.scope !== 'unit') errors.push(label + ': scope must be lesson|unit');
    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      errors.push(label + ': questions must be a non-empty array');
    }
    if (quiz.scope === 'lesson' && !isNonEmptyString(quiz.lessonId)) {
      errors.push(label + ': lesson scope requires lessonId');
    }
    if (quiz.scope === 'unit') {
      if (!isNonEmptyString(quiz.unitId)) errors.push(label + ': unit scope requires unitId');
      const auths = Array.isArray(authorizations) ? authorizations : [];
      const match = auths.find((a) => a?.unitId === quiz.unitId);
      if (!match) {
        errors.push(label + ': unit quiz requires UnitTestAuthorization for unit ' + (quiz.unitId ?? '?'));
      } else {
        for (const field of missingRequired(match, AUTH_REQUIRED)) {
          errors.push(label + ': authorization ' + field + ' is required');
        }
        const unitList = Array.isArray(units) ? units : [];
        const unit = unitList.find((u) => u?.unitId === quiz.unitId);
        if (!unit || !Array.isArray(unit.lessons) || unit.lessons.length === 0) {
          errors.push(label + ': unit structure required to verify last lesson of ' + (quiz.unitId ?? '?'));
        } else {
          const ordered = [...unit.lessons].filter((l) => l && Number.isInteger(l.order));
          if (ordered.length !== unit.lessons.length) {
            errors.push(label + ': every lesson in unit ' + quiz.unitId + ' must have an integer order');
          } else {
            const last = ordered.sort((a, b) => b.order - a.order)[0];
            if (match.lastLessonId !== last.id) {
              errors.push(
                label + ': authorized lastLessonId ' + match.lastLessonId + ' is not the last lesson of ' + quiz.unitId + ' (expected ' + last.id + ')',
              );
            }
          }
        }
      }
    }
    return result(errors);
  }

  function validateApprovalRecord(record, computedHash) {
    const errors = [];
    if (!record || typeof record !== 'object') return result(['record must be an object']);
    const label = 'record ' + (record.lessonId ?? '?') + ' ' + (record.gate ?? '?');
    for (const field of missingRequired(record, RECORD_REQUIRED)) {
      errors.push(label + ': ' + field + ' is required');
    }
    if (!APPROVAL_GATES.includes(record.gate)) errors.push(label + ': gate is invalid');
    if (computedHash !== undefined && record.versionHash !== computedHash) {
      errors.push(label + ': versionHash does not match computed content hash');
    }
    return result(errors);
  }

  return {
    STAGE_KEYS,
    CONTENT_KINDS,
    BLOCK_TYPES,
    ELEMENT_TYPES,
    VERIFICATION_STATUSES,
    CLARITY_STATUSES,
    APPROVAL_GATES,
    validateHierarchy,
    validateContentBlock,
    validateCoverage,
    validateSourcePrepGate,
    validateLessonProfile,
    validateNotebook,
    validateQuiz,
    validateApprovalRecord,
  };
}

const defaultValidators = createValidators(loadSchemas());

export const STAGE_KEYS = defaultValidators.STAGE_KEYS;
export const CONTENT_KINDS = defaultValidators.CONTENT_KINDS;
export const BLOCK_TYPES = defaultValidators.BLOCK_TYPES;
export const ELEMENT_TYPES = defaultValidators.ELEMENT_TYPES;
export const VERIFICATION_STATUSES = defaultValidators.VERIFICATION_STATUSES;
export const CLARITY_STATUSES = defaultValidators.CLARITY_STATUSES;
export const APPROVAL_GATES = defaultValidators.APPROVAL_GATES;
export const validateHierarchy = defaultValidators.validateHierarchy;
export const validateContentBlock = defaultValidators.validateContentBlock;
export const validateCoverage = defaultValidators.validateCoverage;
export const validateSourcePrepGate = defaultValidators.validateSourcePrepGate;
export const validateLessonProfile = defaultValidators.validateLessonProfile;
export const validateNotebook = defaultValidators.validateNotebook;
export const validateQuiz = defaultValidators.validateQuiz;
export const validateApprovalRecord = defaultValidators.validateApprovalRecord;
