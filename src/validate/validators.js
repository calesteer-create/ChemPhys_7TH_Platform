// Task 004 validators: pure logic layer. No DOM, no rendering, no imports from
// presentation code. Every function returns { valid, errors } and never throws
// on malformed input (malformed input is reported as errors).

export const STAGE_KEYS = [
  'orient',
  'discover',
  'labOrActivity',
  'understand',
  'apply',
  'selfTest',
  'summary',
];

export const CONTENT_KINDS = ['book', 'explanation', 'enrichment'];

export const BLOCK_TYPES = [
  'definition',
  'law',
  'example',
  'experiment',
  'figure',
  'equation',
  'note',
  'conclusion',
  'exercise',
  'activity',
  'narrative',
];

export const ELEMENT_TYPES = [
  'definition',
  'law',
  'example',
  'experiment',
  'figure',
  'note',
  'conclusion',
  'exercise',
];

export const VERIFICATION_STATUSES = ['uncovered', 'covered', 'verified'];

export const CLARITY_STATUSES = ['clear', 'unclear', 'missing'];

export const APPROVAL_GATES = [
  'A-automated',
  'B-scientific',
  'B-notebook-educational',
  'C-owner',
  'D-publishing',
];

function result(errors) {
  return { valid: errors.length === 0, errors };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkSourceRef(ref, label, errors) {
  if (!ref || typeof ref !== 'object') {
    errors.push(`${label}: source ref must be an object`);
    return;
  }
  if (!isNonEmptyString(ref.bookTitle)) errors.push(`${label}: bookTitle is required`);
  if (!Number.isInteger(ref.page) || ref.page < 1) errors.push(`${label}: page must be an integer >= 1`);
}

export function validateHierarchy(hierarchy) {
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
      errors.push(`grade ${grade?.id ?? '?'}: subjects must be a non-empty array`);
      continue;
    }
    for (const subject of grade.subjects) {
      if (!subject || !isNonEmptyString(subject.id)) errors.push('subject.id is required');
      if (!Array.isArray(subject?.units) || subject.units.length === 0) {
        errors.push(`subject ${subject?.id ?? '?'}: units must be a non-empty array`);
        continue;
      }
      for (const unit of subject.units) {
        if (!unit || !isNonEmptyString(unit.id)) errors.push('unit.id is required');
        if (!Number.isInteger(unit?.order) || unit.order < 1) {
          errors.push(`unit ${unit?.id ?? '?'}: order must be an integer >= 1`);
        }
        if (!Array.isArray(unit?.lessons) || unit.lessons.length === 0) {
          errors.push(`unit ${unit?.id ?? '?'}: lessons must be a non-empty array`);
          continue;
        }
        for (const lesson of unit.lessons) {
          if (!lesson || !isNonEmptyString(lesson.id)) {
            errors.push('lesson.id is required');
            continue;
          }
          if (lessonIds.has(lesson.id)) errors.push(`duplicate lesson id: ${lesson.id}`);
          lessonIds.add(lesson.id);
          if (!Number.isInteger(lesson.order) || lesson.order < 1) {
            errors.push(`lesson ${lesson.id}: order must be an integer >= 1`);
          }
          if (!Array.isArray(lesson.stages) || lesson.stages.length !== 7) {
            errors.push(`lesson ${lesson.id}: stages must contain exactly 7 entries`);
            continue;
          }
          const keys = lesson.stages.map((s) => s?.stageKey);
          const keySet = new Set(keys);
          if (keySet.size !== 7 || !STAGE_KEYS.every((k) => keySet.has(k))) {
            errors.push(`lesson ${lesson.id}: stages must cover exactly the 7 stage keys`);
          }
          for (const stage of lesson.stages) {
            if (stage.stageKey === 'labOrActivity') {
              if (stage.activityKind !== 'simulation' && stage.activityKind !== 'activity') {
                errors.push(`lesson ${lesson.id}: labOrActivity requires activityKind simulation|activity`);
              }
            } else if (stage.activityKind !== null && stage.activityKind !== undefined) {
              errors.push(`lesson ${lesson.id}: activityKind must be null outside labOrActivity`);
            }
            if (!Array.isArray(stage.blockIds)) {
              errors.push(`lesson ${lesson.id} stage ${stage.stageKey}: blockIds must be an array`);
            }
          }
        }
      }
    }
  }
  return result(errors);
}

export function validateContentBlock(block) {
  const errors = [];
  if (!block || typeof block !== 'object') return result(['block must be an object']);
  const label = `block ${block.id ?? '?'}`;
  if (!isNonEmptyString(block.id)) errors.push('block.id is required');
  if (!isNonEmptyString(block.lessonId)) errors.push(`${label}: lessonId is required`);
  if (!STAGE_KEYS.includes(block.stageKey)) errors.push(`${label}: stageKey is invalid`);
  if (!CONTENT_KINDS.includes(block.kind)) errors.push(`${label}: kind is invalid`);
  if (!BLOCK_TYPES.includes(block.blockType)) errors.push(`${label}: blockType is invalid`);
  if (!Array.isArray(block.sourceRefs)) {
    errors.push(`${label}: sourceRefs must be an array`);
  } else {
    block.sourceRefs.forEach((ref, i) => checkSourceRef(ref, `${label} sourceRefs[${i}]`, errors));
    if (block.kind === 'book' && block.sourceRefs.length < 1) {
      errors.push(`${label}: book content requires at least one traceable source`);
    }
  }
  if (block.bodyMarkdown !== undefined && typeof block.bodyMarkdown !== 'string') {
    errors.push(`${label}: bodyMarkdown must be a string`);
  }
  return result(errors);
}

export function validateCoverage(items) {
  const errors = [];
  const uncovered = [];
  if (!Array.isArray(items)) return { valid: false, errors: ['items must be an array'], uncovered };
  const elementIds = new Set();
  for (const item of items) {
    const label = `element ${item?.elementId ?? '?'}`;
    if (!item || typeof item !== 'object') {
      errors.push('coverage item must be an object');
      continue;
    }
    if (!isNonEmptyString(item.elementId)) errors.push('elementId is required');
    else if (elementIds.has(item.elementId)) errors.push(`duplicate elementId: ${item.elementId}`);
    else elementIds.add(item.elementId);
    if (!isNonEmptyString(item.lessonId)) errors.push(`${label}: lessonId is required`);
    if (!ELEMENT_TYPES.includes(item.elementType)) errors.push(`${label}: elementType is invalid`);
    if (!isNonEmptyString(item.referenceText)) errors.push(`${label}: referenceText is required`);
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1) {
      errors.push(`${label}: at least one traceable source is required`);
    } else {
      item.sourceRefs.forEach((ref, i) => checkSourceRef(ref, `${label} sourceRefs[${i}]`, errors));
    }
    if (!STAGE_KEYS.includes(item.stageLocation)) errors.push(`${label}: stageLocation is invalid`);
    if (!VERIFICATION_STATUSES.includes(item.verificationStatus)) {
      errors.push(`${label}: verificationStatus is invalid`);
    }
    if (item.verificationStatus === 'uncovered') uncovered.push(item.elementId);
    for (const sub of item.subItems ?? []) {
      const subLabel = `sub ${sub?.subId ?? '?'}`;
      if (!isNonEmptyString(sub.subId)) errors.push(`${label}: subId is required`);
      if (sub.kind !== 'info' && sub.kind !== 'skill') errors.push(`${subLabel}: kind must be info|skill`);
      if (!isNonEmptyString(sub.description)) errors.push(`${subLabel}: description is required`);
      if (!STAGE_KEYS.includes(sub.stageLocation)) errors.push(`${subLabel}: stageLocation is invalid`);
      if (typeof sub.notebookRequired !== 'boolean') errors.push(`${subLabel}: notebookRequired must be boolean`);
      if (!VERIFICATION_STATUSES.includes(sub.verificationStatus)) {
        errors.push(`${subLabel}: verificationStatus is invalid`);
      }
      if (sub.verificationStatus === 'uncovered') uncovered.push(sub.subId);
    }
  }
  return { valid: errors.length === 0, errors, uncovered };
}

export function validateSourcePrepGate(pages, figures) {
  const blockers = [];
  const allPages = Array.isArray(pages) ? pages : [];
  const allFigures = Array.isArray(figures) ? figures : [];
  for (const page of allPages) {
    const essential = page?.essential !== false;
    if (!essential) continue;
    if (!CLARITY_STATUSES.includes(page?.clarityStatus)) {
      blockers.push(`page ${page?.pageNo ?? '?'}: clarityStatus is invalid`);
    } else if (page.clarityStatus !== 'clear') {
      blockers.push(`page ${page.pageNo}: essential source is ${page.clarityStatus}`);
    }
  }
  for (const figure of allFigures) {
    const essential = figure?.essential !== false;
    if (!essential) continue;
    if (!CLARITY_STATUSES.includes(figure?.clarityStatus)) {
      blockers.push(`figure ${figure?.figureNo ?? '?'}: clarityStatus is invalid`);
    } else if (figure.clarityStatus !== 'clear') {
      blockers.push(`figure ${figure.figureNo} (page ${figure.pageNo}): essential source is ${figure.clarityStatus}`);
    }
  }
  return { blocked: blockers.length > 0, blockers };
}

function checkNotebookPayload(item, label, errors) {
  const payload = item.payload;
  if (!payload || typeof payload !== 'object') {
    errors.push(`${label}: payload is required`);
    return;
  }
  switch (item.itemType) {
    case 'definition':
      if (!isNonEmptyString(payload.statement)) errors.push(`${label}: definition requires statement`);
      break;
    case 'law':
      if (!isNonEmptyString(payload.tex)) errors.push(`${label}: law requires tex`);
      if (!Array.isArray(payload.symbols) || payload.symbols.length === 0) {
        errors.push(`${label}: law requires symbols`);
      }
      if (!Array.isArray(payload.units) || payload.units.length === 0) {
        errors.push(`${label}: law requires units`);
      }
      break;
    case 'example':
      if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
        errors.push(`${label}: example requires steps`);
      }
      break;
    case 'figure':
      if (!isNonEmptyString(payload.figureId)) errors.push(`${label}: figure requires figureId`);
      if (!isNonEmptyString(payload.caption)) errors.push(`${label}: figure requires caption`);
      break;
    default:
      break;
  }
}

export function validateNotebook(notebook, subItems, profile) {
  const errors = [];
  if (!notebook || typeof notebook !== 'object') return result(['notebook must be an object']);
  if (!isNonEmptyString(notebook.lessonId)) errors.push('notebook.lessonId is required');
  if (!Array.isArray(notebook.sections)) return result([...errors, 'notebook.sections must be an array']);

  const requiredSubs = new Map();
  for (const sub of subItems ?? []) {
    if (sub?.notebookRequired === true) requiredSubs.set(sub.subId, sub);
  }
  const knownSubs = new Set((subItems ?? []).map((s) => s?.subId));
  const traced = new Set();

  for (const section of notebook.sections) {
    const sectionLabel = `section ${section?.sectionType ?? '?'}`;
    if (!isNonEmptyString(section?.sectionType)) errors.push('sectionType is required');
    if (!Array.isArray(section?.items) || section.items.length === 0) {
      errors.push(`${sectionLabel}: empty sections are not allowed`);
      continue;
    }
    for (const item of section.items) {
      const label = `item ${item?.itemId ?? '?'}`;
      if (!isNonEmptyString(item.itemId)) errors.push(`${sectionLabel}: itemId is required`);
      if (!Array.isArray(item.tracesTo) || item.tracesTo.length === 0) {
        errors.push(`${label}: tracesTo must reference at least one coverage sub-item`);
      } else {
        for (const subId of item.tracesTo) {
          if (!knownSubs.has(subId)) errors.push(`${label}: unknown tracesTo ${subId} (orphan)`);
          else traced.add(subId);
        }
      }
      checkNotebookPayload(item, label, errors);
    }
  }

  for (const subId of requiredSubs.keys()) {
    if (!traced.has(subId)) errors.push(`required sub-item ${subId} has no notebook item`);
  }

  if (profile && profile.hasLaws === true) {
    const hasLawsSection = notebook.sections.some((s) => s.sectionType === 'laws');
    const hasRequiredLaw = [...requiredSubs.values()].some(
      (s) => s.notebookLocation === 'laws',
    );
    if (hasRequiredLaw && !hasLawsSection) {
      errors.push('profile hasLaws with required law items requires a laws section');
    }
  }

  return result(errors);
}

export function validateQuiz(quiz, authorizations) {
  const errors = [];
  if (!quiz || typeof quiz !== 'object') return result(['quiz must be an object']);
  const label = `quiz ${quiz.id ?? '?'}`;
  if (!isNonEmptyString(quiz.id)) errors.push('quiz.id is required');
  if (quiz.scope !== 'lesson' && quiz.scope !== 'unit') errors.push(`${label}: scope must be lesson|unit`);
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    errors.push(`${label}: questions must be a non-empty array`);
  }
  if (quiz.scope === 'lesson' && !isNonEmptyString(quiz.lessonId)) {
    errors.push(`${label}: lesson scope requires lessonId`);
  }
  if (quiz.scope === 'unit') {
    if (!isNonEmptyString(quiz.unitId)) errors.push(`${label}: unit scope requires unitId`);
    const auths = Array.isArray(authorizations) ? authorizations : [];
    const match = auths.find((a) => a?.unitId === quiz.unitId);
    if (!match) {
      errors.push(`${label}: unit quiz requires UnitTestAuthorization for unit ${quiz.unitId ?? '?'}`);
    } else if (!isNonEmptyString(match.lastLessonId) || !isNonEmptyString(match.authorizedBy)) {
      errors.push(`${label}: authorization must name lastLessonId and authorizedBy`);
    }
  }
  return result(errors);
}

export function validateApprovalRecord(record, computedHash) {
  const errors = [];
  if (!record || typeof record !== 'object') return result(['record must be an object']);
  const label = `record ${record.lessonId ?? '?'} ${record.gate ?? '?'}`;
  if (!isNonEmptyString(record.lessonId)) errors.push('lessonId is required');
  if (!APPROVAL_GATES.includes(record.gate)) errors.push(`${label}: gate is invalid`);
  if (!isNonEmptyString(record.versionHash)) errors.push(`${label}: versionHash is required`);
  if (computedHash !== undefined && record.versionHash !== computedHash) {
    errors.push(`${label}: versionHash does not match computed content hash`);
  }
  return result(errors);
}
