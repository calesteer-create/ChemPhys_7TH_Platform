// Task 004 validators: pure logic layer. No DOM, no rendering, no imports from
// presentation code. Every function returns { valid, errors } and never throws
// on malformed input (malformed input is reported as errors).
//
// The seven JSON schemas under src/content/schema are the single source of
// truth for structural constraints. A small built-in engine enforces type,
// required, enum, properties, items, minItems, maxItems, minLength, minimum,
// and local $ref resolution directly from the schema files, so changing any
// structural constraint in a schema changes validation results. Rules that
// JSON Schema cannot express without conditionals (book-source requirement,
// lab activity kind, notebook payload per type, source prep gate, coverage
// linkage, last-lesson verification, version-hash binding) are implemented as
// explicit cross-entity checks below and are documented as such.

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

function resolveRef(ref, root) {
  const parts = String(ref).replace(/^#\//, '').split('/');
  let current = root;
  for (const part of parts) {
    current = current?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

function typeMatches(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

// Generic structural validation driven entirely by the schema object.
function validateAgainstSchema(value, schema, root, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path, errors);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(path + ': must be one of ' + schema.enum.join('|'));
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0 && !types.some((t) => typeMatches(value, t))) {
    errors.push(path + ': must be ' + types.join('|'));
    return;
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(path + ': must have length >= ' + schema.minLength);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(path + ': must be >= ' + schema.minimum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(path + ': must have at least ' + schema.minItems + ' items');
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(path + ': must have at most ' + schema.maxItems + ' items');
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        validateAgainstSchema(entry, schema.items, root, path + '[' + index + ']', errors);
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required ?? []) {
      if (value[field] === undefined) errors.push(path + '.' + field + ' is required');
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) {
          validateAgainstSchema(value[key], subSchema, root, path + '.' + key, errors);
        }
      }
    }
  }
}

function structuralErrors(value, schema, root, path) {
  const errors = [];
  validateAgainstSchema(value, schema, root, path ?? '$', errors);
  return errors;
}

export function createValidators(schemas) {
  const STAGE_KEYS = schemas.hierarchy.$defs.StageKey.enum;
  const CONTENT_KINDS = schemas.contentBlock.properties.kind.enum;
  const BLOCK_TYPES = schemas.contentBlock.properties.blockType.enum;
  const ELEMENT_TYPES = schemas.coverage.$defs.CoverageItem.properties.elementType.enum;
  const VERIFICATION_STATUSES = schemas.coverage.$defs.CoverageItem.properties.verificationStatus.enum;
  const CLARITY_STATUSES = schemas.source.$defs.SourcePage.properties.clarityStatus.enum;
  const APPROVAL_GATES = schemas.approval.$defs.ApprovalRecord.properties.gate.enum;
  const SUB_KINDS = schemas.coverage.$defs.CoverageSubItem.properties.kind.enum;
  const QUIZ_SCOPES = schemas.quiz.$defs.Quiz.properties.scope.enum;
  const ACTIVITY_KINDS = schemas.hierarchy.$defs.StageContent.properties.activityKind.enum.filter((k) => k !== null);
  const NOTEBOOK_ITEM_TYPES = schemas.notebook.$defs.NotebookItem.properties.itemType.enum;

  function result(errors) {
    return { valid: errors.length === 0, errors };
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function checkSourceRef(ref, label, errors) {
    if (!ref || typeof ref !== 'object') {
      errors.push(label + ': source ref must be an object');
      return;
    }
    if (!isNonEmptyString(ref.bookTitle)) errors.push(label + ': bookTitle is required');
    if (!Number.isInteger(ref.page) || ref.page < 1) errors.push(label + ': page must be an integer >= 1');
  }

  function findLessonStageMap(hierarchy, lessonId) {
    const map = new Map();
    for (const grade of Array.isArray(hierarchy?.grades) ? hierarchy.grades : []) {
      for (const subject of Array.isArray(grade?.subjects) ? grade.subjects : []) {
        for (const unit of Array.isArray(subject?.units) ? subject.units : []) {
          for (const lesson of Array.isArray(unit?.lessons) ? unit.lessons : []) {
            if (lesson?.id === lessonId) {
              for (const stage of Array.isArray(lesson.stages) ? lesson.stages : []) {
                for (const blockId of Array.isArray(stage?.blockIds) ? stage.blockIds : []) {
                  map.set(blockId, stage.stageKey);
                }
              }
            }
          }
        }
      }
    }
    return map;
  }

  function validateHierarchy(hierarchy) {
    const errors = structuralErrors(hierarchy, schemas.hierarchy, schemas.hierarchy, '$');
    if (!hierarchy || typeof hierarchy !== 'object') return result(errors.length > 0 ? errors : ['hierarchy must be an object']);
    const lessonIds = new Set();
    for (const grade of Array.isArray(hierarchy.grades) ? hierarchy.grades : []) {
      for (const subject of Array.isArray(grade?.subjects) ? grade.subjects : []) {
        for (const unit of Array.isArray(subject?.units) ? subject.units : []) {
          for (const lesson of Array.isArray(unit?.lessons) ? unit.lessons : []) {
            if (!lesson || !isNonEmptyString(lesson.id)) continue;
            if (lessonIds.has(lesson.id)) errors.push('duplicate lesson id: ' + lesson.id);
            lessonIds.add(lesson.id);
            if (!Array.isArray(lesson.stages) || lesson.stages.length !== STAGE_KEYS.length) continue;
            const keys = lesson.stages.map((s) => s?.stageKey);
            const keySet = new Set(keys);
            if (keySet.size !== STAGE_KEYS.length || !STAGE_KEYS.every((k) => keySet.has(k))) {
              errors.push('lesson ' + lesson.id + ': stages must cover exactly the stage keys from the schema');
            }
            for (const stage of lesson.stages) {
              if (!stage || typeof stage !== 'object') continue;
              if (stage.stageKey === 'labOrActivity') {
                if (!ACTIVITY_KINDS.includes(stage.activityKind)) {
                  errors.push('lesson ' + lesson.id + ': labOrActivity requires activityKind ' + ACTIVITY_KINDS.join('|'));
                }
              } else if (stage.activityKind !== null && stage.activityKind !== undefined) {
                errors.push('lesson ' + lesson.id + ': activityKind must be null outside labOrActivity');
              }
            }
          }
        }
      }
    }
    return result(errors);
  }

  function validateContentBlock(block) {
    const errors = structuralErrors(block, schemas.contentBlock, schemas.contentBlock, '$');
    if (!block || typeof block !== 'object') return result(errors.length > 0 ? errors : ['block must be an object']);
    const label = 'block ' + (block.id ?? '?');
    if (Array.isArray(block.sourceRefs)) {
      block.sourceRefs.forEach((ref, i) => checkSourceRef(ref, label + ' sourceRefs[' + i + ']', errors));
      if (block.kind === 'book' && block.sourceRefs.length < 1) {
        errors.push(label + ': book content requires at least one traceable source');
      }
    }
    return result(errors);
  }

  // blocks: the lesson's content blocks. hierarchy: the full hierarchy object
  // used to prove each treatment block sits in the lesson's actual stages.
  // A covered/verified element is only accepted when its blockIds resolve to
  // real blocks that back-reference the element, sit in the declared stage
  // locations, and appear in the hierarchy at the declared positions.
  function validateCoverage(items, blocks, hierarchy) {
    const errors = [];
    const uncovered = [];
    if (!Array.isArray(items)) return { valid: false, errors: ['items must be an array'], uncovered };
    errors.push(...structuralErrors({ items }, schemas.coverage, schemas.coverage, '$'));
    const blockList = Array.isArray(blocks) ? blocks : [];
    const blockById = new Map();
    for (const block of blockList) {
      if (block && isNonEmptyString(block.id)) blockById.set(block.id, block);
    }
    const elementIds = new Set(items.map((i) => i?.elementId).filter(isNonEmptyString));
    const stageMap = hierarchy ? findLessonStageMap(hierarchy, null) : null;

    for (const block of blockList) {
      for (const elementId of Array.isArray(block?.coversElementIds) ? block.coversElementIds : []) {
        if (!elementIds.has(elementId)) {
          errors.push('block ' + (block.id ?? '?') + ': references unknown element ' + elementId);
        }
      }
    }

    for (const item of items) {
      const label = 'element ' + (item?.elementId ?? '?');
      if (!item || typeof item !== 'object') continue;
      if (item.verificationStatus === 'uncovered') {
        uncovered.push(item.elementId);
        errors.push(label + ' is uncovered (incomplete coverage)');
      }
      for (const sub of Array.isArray(item.subItems) ? item.subItems : []) {
        if (sub?.verificationStatus === 'uncovered') {
          uncovered.push(sub.subId);
          errors.push('sub ' + (sub?.subId ?? '?') + ' is uncovered (incomplete coverage)');
        }
      }
      if (item.verificationStatus !== 'covered' && item.verificationStatus !== 'verified') continue;
      if (!Array.isArray(item.blockIds) || item.blockIds.length === 0) {
        errors.push(label + ': covered element requires at least one treatment block');
        continue;
      }
      if (new Set(item.blockIds).size !== item.blockIds.length) {
        errors.push(label + ': blockIds must not contain duplicates');
      }
      if (Array.isArray(item.stageLocations) && new Set(item.stageLocations).size !== item.stageLocations.length) {
        errors.push(label + ': stageLocations must not contain duplicates');
      }
      const allowedStages = Array.isArray(item.stageLocations) && item.stageLocations.length > 0
        ? item.stageLocations
        : [item.stageLocation];
      const lessonStageMap = hierarchy ? findLessonStageMap(hierarchy, item.lessonId) : null;
      for (const blockId of item.blockIds) {
        const block = blockById.get(blockId);
        if (!block) {
          errors.push(label + ': references missing block ' + blockId);
          continue;
        }
        if (block.lessonId !== item.lessonId) {
          errors.push(label + ': block ' + blockId + ' belongs to a different lesson');
        }
        if (!(Array.isArray(block.coversElementIds) ? block.coversElementIds : []).includes(item.elementId)) {
          errors.push(label + ': block ' + blockId + ' does not treat this element');
        }
        if (!allowedStages.includes(block.stageKey)) {
          errors.push(label + ': block ' + blockId + ' stage ' + block.stageKey + ' does not match declared stage locations');
        }
        if (lessonStageMap) {
          if (!lessonStageMap.has(blockId)) {
            errors.push(label + ': block ' + blockId + ' is not in the lesson hierarchy');
          } else if (lessonStageMap.get(blockId) !== block.stageKey) {
            errors.push(label + ': block ' + blockId + ' hierarchy stage ' + lessonStageMap.get(blockId) + ' does not match block stage ' + block.stageKey);
          }
        }
      }
      for (const block of blockList) {
        if ((Array.isArray(block?.coversElementIds) ? block.coversElementIds : []).includes(item.elementId) && !item.blockIds.includes(block.id)) {
          errors.push(label + ': block ' + block.id + ' claims to treat this element but is not listed');
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

    for (const page of allPages) {
      blockers.push(...structuralErrors(page, schemas.source.$defs.SourcePage, schemas.source, 'page ' + (page?.pageNo ?? '?')));
    }
    for (const figure of allFigures) {
      blockers.push(...structuralErrors(figure, schemas.source.$defs.SourceFigure, schemas.source, 'figure ' + (figure?.figureNo ?? '?')));
    }

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

  // Minimum structural requirements for a valid lesson profile, driven by the
  // notebook schema. A lesson without laws is valid: capability flags are
  // optional booleans and no section is forced by their absence.
  function validateLessonProfile(profile) {
    const errors = structuralErrors(profile, schemas.notebook.$defs.LessonProfile, schemas.notebook, '$');
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
    const errors = structuralErrors(notebook, schemas.notebook, schemas.notebook, '$');
    if (!notebook || typeof notebook !== 'object') return result(errors.length > 0 ? errors : ['notebook must be an object']);
    if (profile !== undefined && profile !== null) {
      errors.push(...validateLessonProfile(profile).errors);
    }

    const requiredSubs = new Map();
    for (const sub of Array.isArray(subItems) ? subItems : []) {
      if (sub?.notebookRequired === true) requiredSubs.set(sub.subId, sub);
    }
    const knownSubs = new Set((Array.isArray(subItems) ? subItems : []).map((s) => s?.subId));
    const traced = new Set();

    for (const section of Array.isArray(notebook.sections) ? notebook.sections : []) {
      const sectionLabel = 'section ' + (section?.sectionType ?? '?');
      if (!section || typeof section !== 'object') continue;
      for (const item of Array.isArray(section.items) ? section.items : []) {
        const label = 'item ' + (item?.itemId ?? '?');
        if (!item || typeof item !== 'object') continue;
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
      const hasLawsSection = (Array.isArray(notebook.sections) ? notebook.sections : []).some((s) => s?.sectionType === 'laws');
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
    const errors = structuralErrors(
      { quizzes: quiz ? [quiz] : [], authorizations: authorizations ?? [] },
      schemas.quiz,
      schemas.quiz,
      '$',
    );
    if (!quiz || typeof quiz !== 'object') return result(errors.length > 0 ? errors : ['quiz must be an object']);
    const label = 'quiz ' + (quiz.id ?? '?');
    if (!QUIZ_SCOPES.includes(quiz.scope)) errors.push(label + ': scope must be ' + QUIZ_SCOPES.join('|'));
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
    const errors = structuralErrors(record, schemas.approval.$defs.ApprovalRecord, schemas.approval, '$');
    if (!record || typeof record !== 'object') return result(errors.length > 0 ? errors : ['record must be an object']);
    const label = 'record ' + (record.lessonId ?? '?') + ' ' + (record.gate ?? '?');
    if (computedHash !== undefined && record.versionHash !== computedHash) {
      errors.push(label + ': versionHash does not match computed content hash');
    }
    return result(errors);
  }

  // Mandatory gates for approval. Publishing (D-publishing) is a separate step
  // and is not required for the approval chain itself.
  const MANDATORY_GATES = ['A-automated', 'B-scientific', 'B-notebook-educational', 'C-owner'];

  const REQUIRED_RESULTS = {
    'A-automated': 'pass',
    'B-scientific': 'pass',
    'B-notebook-educational': 'pass',
    'C-owner': 'approved',
  };

  function validateApprovalChain(records, computedHash) {
    const errors = [];
    if (!Array.isArray(records)) return result(['records must be an array']);
    const present = new Set();
    for (const record of records) {
      errors.push(...validateApprovalRecord(record, computedHash).errors);
      if (record && APPROVAL_GATES.includes(record.gate)) {
        present.add(record.gate);
        const required = REQUIRED_RESULTS[record.gate];
        if (required && record.result !== required) {
          errors.push('gate ' + record.gate + ' did not pass (result ' + (record.result ?? 'missing') + ', required ' + required + ')');
        }
      }
    }
    for (const gate of MANDATORY_GATES) {
      if (!present.has(gate)) errors.push('mandatory gate missing: ' + gate);
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
    SUB_KINDS,
    QUIZ_SCOPES,
    ACTIVITY_KINDS,
    NOTEBOOK_ITEM_TYPES,
    MANDATORY_GATES,
    REQUIRED_RESULTS,
    validateHierarchy,
    validateContentBlock,
    validateCoverage,
    validateSourcePrepGate,
    validateLessonProfile,
    validateNotebook,
    validateQuiz,
    validateApprovalRecord,
    validateApprovalChain,
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
export const SUB_KINDS = defaultValidators.SUB_KINDS;
export const QUIZ_SCOPES = defaultValidators.QUIZ_SCOPES;
export const ACTIVITY_KINDS = defaultValidators.ACTIVITY_KINDS;
export const NOTEBOOK_ITEM_TYPES = defaultValidators.NOTEBOOK_ITEM_TYPES;
export const MANDATORY_GATES = defaultValidators.MANDATORY_GATES;
export const REQUIRED_RESULTS = defaultValidators.REQUIRED_RESULTS;
export const validateHierarchy = defaultValidators.validateHierarchy;
export const validateContentBlock = defaultValidators.validateContentBlock;
export const validateCoverage = defaultValidators.validateCoverage;
export const validateSourcePrepGate = defaultValidators.validateSourcePrepGate;
export const validateLessonProfile = defaultValidators.validateLessonProfile;
export const validateNotebook = defaultValidators.validateNotebook;
export const validateQuiz = defaultValidators.validateQuiz;
export const validateApprovalRecord = defaultValidators.validateApprovalRecord;
export const validateApprovalChain = defaultValidators.validateApprovalChain;
