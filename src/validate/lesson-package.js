// Task 005: lesson package validation gateway.
//
// One public entry point, validateLessonPackage(bundle), that proves a whole
// lesson package is coherent BEFORE any approval is recorded. It is not a
// wrapper that merely calls the individual validators: it also proves lesson
// identity, existence, stage order, reverse references, duplicate scopes,
// notebook/coverage linkage, file safety, and the version hash binding.
//
// Contract notes that must not be silently strengthened:
//   - The bundle carries RAW file contents ("path" + "content" per role). The
//     bytes that are parsed are the bytes that are hashed, so a future
//     refactor cannot validate one source and hash another.
//   - The public function NEVER throws. computeVersionHash does throw TypeError
//     on invalid input; that is caught here and reported as a structured
//     "[hash]" error (T-3a tests the internal throw, T-3b tests this).
//   - Approval validity means: the record exists, is well formed, has a
//     successful result, and matches the computed hash. It does NOT prove that
//     a human review happened or who performed it.
//   - Unknown keys are rejected only for the contracts named here (manifest,
//     quiz file top level). This is NOT a change to the general schema engine.

import { readFileSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  SCHEMA_VERSION,
  HASH_ALGORITHM_VERSION,
  computeVersionHash,
  isApprovalRecordPath,
  normalizeHashPath,
} from './version-hash.js';
import {
  validateHierarchy,
  validateContentBlock,
  validateCoverage,
  validateSourcePrepGate,
  validateNotebook,
  validateApprovalChain,
  validateQuiz,
  loadSchemas,
} from './validators.js';

export const ROLE_PATHS = {
  hierarchy: 'src/content/',
  blocks: 'src/content/',
  coverage: 'src/content/',
  sources: 'src/content/',
  notebook: 'src/content/',
  quizzes: 'src/content/',
  approvals: 'src/content/',
};

// Roots allowed for content and images. The package manifest is the single
// extra anchor: it sits at the package root (= repository root).
export const ALLOWED_ROOTS = ['src/content/', 'assets/'];

export const MANIFEST_FILENAME = 'lesson-package.json';

export const MANDATORY_APPROVAL_GATES = ['A-automated', 'B-scientific', 'B-notebook-educational', 'C-owner'];

const SCHEMA_FILES = [
  'hierarchy.schema.json',
  'content-block.schema.json',
  'coverage.schema.json',
  'source.schema.json',
  'notebook.schema.json',
  'quiz.schema.json',
  'approval.schema.json',
];

// Keys explicitly allowed on the quiz file's top level. `units` is NOT among
// them: unit structure is derived from the hierarchy, never from the quiz file.
const QUIZ_FILE_KEYS = ['quizzes', 'authorizations'];

// Keys allowed in the manifest.
const MANIFEST_KEYS = ['packageVersion', 'lessonId', 'hashAlgorithmVersion', 'schemaVersion', 'files', 'images'];
const MANIFEST_FILE_KEYS = ['hierarchy', 'blocks', 'coverage', 'sources', 'notebook', 'quizzes', 'approvals'];

function emptyLayer() {
  return { valid: true, errors: [] };
}

function makeResult() {
  return {
    valid: false,
    automatedValidation: emptyLayer(),
    scientificReview: emptyLayer(),
    notebookEducational: emptyLayer(),
    ownerApproval: emptyLayer(),
    readyToPublish: false,
    publishingStatus: 'not-ready',
    hash: undefined,
    schemaVersion: SCHEMA_VERSION,
    hashAlgorithmVersion: HASH_ALGORITHM_VERSION,
    uncovered: [],
    errors: [],
    notes: [],
  };
}

// Parses JSON from the exact raw string that will be hashed.
function parseJson(content, role, errors) {
  try {
    const text = Buffer.isBuffer(content) || content instanceof Uint8Array
      ? Buffer.from(content).toString('utf8')
      : String(content);
    return JSON.parse(text);
  } catch (err) {
    errors.push('[parse] ' + role + ': content is not valid JSON (' + err.message + ')');
    return undefined;
  }
}

function bytesOf(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return Buffer.from(String(content), 'utf8');
}

// Path safety, memory mode: syntactic rules only (no filesystem).
function checkPathSyntax(path, role, errors) {
  const normalized = normalizeHashPath(path);
  if (!normalized.ok) {
    errors.push('[path] ' + role + ': ' + normalized.error);
    return undefined;
  }
  return normalized.path;
}

// Path safety, disk mode: syntactic rules, then realpath containment on EVERY
// component. This is an integrity check for a single-tenant CI run, not an
// absolute security guarantee: a TOCTOU window remains between realpath and
// open. The file is read through the handle that was fstat-checked.
export function resolveInsideRoots(rootDir, relPath, errors, role) {
  const syntactic = checkPathSyntax(relPath, role, errors);
  if (!syntactic) return undefined;
  const absoluteRoot = realpathSync(resolve(rootDir));
  const candidate = resolve(absoluteRoot, syntactic);
  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch (err) {
    errors.push('[files] ' + role + ': ' + syntactic + ' is not readable (' + err.code + ')');
    return undefined;
  }
  const allowed = ALLOWED_ROOTS.map((root) => {
    try {
      return realpathSync(resolve(absoluteRoot, root.replace(/\/$/, '')));
    } catch {
      return null;
    }
  }).filter(Boolean);
  const contained = allowed.some((root) => realCandidate === root || realCandidate.startsWith(root + sep));
  if (!contained) {
    errors.push('[files] ' + role + ': ' + syntactic + ' resolves outside the allowed roots');
    return undefined;
  }
  return realCandidate;
}

function readFileSafely(absolutePath, role, errors) {
  let fd;
  try {
    fd = openSync(absolutePath, 'r');
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      errors.push('[files] ' + role + ': not a regular file');
      return undefined;
    }
    const size = stats.size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } catch (err) {
    errors.push('[files] ' + role + ': cannot read (' + err.code + ')');
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Derives unit structure from the hierarchy. This is the ONLY source of unit
// ordering; the quiz file never supplies it.
export function deriveUnits(hierarchy) {
  const units = [];
  for (const grade of Array.isArray(hierarchy?.grades) ? hierarchy.grades : []) {
    for (const subject of Array.isArray(grade?.subjects) ? grade.subjects : []) {
      for (const unit of Array.isArray(subject?.units) ? subject.units : []) {
        if (!unit || typeof unit !== 'object') continue;
        units.push({
          unitId: unit.id,
          lessons: (Array.isArray(unit.lessons) ? unit.lessons : [])
            .filter((lesson) => lesson && typeof lesson === 'object')
            .map((lesson) => ({ id: lesson.id, order: lesson.order })),
        });
      }
    }
  }
  return units;
}

function findLessonOccurrences(hierarchy, lessonId) {
  const found = [];
  for (const grade of Array.isArray(hierarchy?.grades) ? hierarchy.grades : []) {
    for (const subject of Array.isArray(grade?.subjects) ? grade.subjects : []) {
      for (const unit of Array.isArray(subject?.units) ? subject.units : []) {
        for (const lesson of Array.isArray(unit?.lessons) ? unit.lessons : []) {
          if (lesson && lesson.id === lessonId) found.push({ lesson, unitId: unit.id });
        }
      }
    }
  }
  return found;
}

// Figure ids are the string form of the figure number, globally scoped.
function collectFigureIds(sources) {
  const ids = new Set();
  for (const figure of Array.isArray(sources?.figures) ? sources.figures : []) {
    if (figure && figure.figureNo !== undefined && figure.figureNo !== null) ids.add(String(figure.figureNo));
  }
  return ids;
}

function flattenSubItems(coverageItems) {
  const subs = [];
  for (const item of Array.isArray(coverageItems) ? coverageItems : []) {
    if (!item || typeof item !== 'object') continue;
    for (const sub of Array.isArray(item.subItems) ? item.subItems : []) {
      if (sub && typeof sub === 'object') subs.push(sub);
    }
  }
  return subs;
}

function gateLayer(records, gate, expectedResults, computedHash, schema) {
  const errors = [];
  const matching = (Array.isArray(records) ? records : []).filter((record) => record && record.gate === gate);
  if (matching.length === 0) {
    errors.push('[approval] mandatory gate missing: ' + gate);
    return { valid: false, errors };
  }
  if (matching.length > 1) errors.push('[approval] duplicate gate record: ' + gate);
  const record = matching[0];
  if (!expectedResults.includes(record.result)) {
    errors.push('[approval] gate ' + gate + ' did not succeed (result ' + (record.result ?? 'missing') + ')');
  }
  if (computedHash !== undefined && record.versionHash !== computedHash) {
    errors.push('[approval] gate ' + gate + ': versionHash does not match the computed content hash');
  }
  if (typeof record.lessonId !== 'string' || record.lessonId.length === 0) {
    errors.push('[approval] gate ' + gate + ': lessonId is required');
  }
  return { valid: errors.length === 0, errors };
}

// options:
//   schemaFiles: [{path, content}] — the seven schema files, hashed too.
//   diskRoot: repository root, enables realpath/containment/existence checks.
//   allowUnknownKeys: false by default; the named contracts are always strict.
export function validateLessonPackage(bundle, options = {}) {
  const out = makeResult();
  const errors = [];
  const notes = [];
  const schemas = loadSchemas();

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    out.errors = ['[bundle] bundle must be an object with a files map'];
    out.automatedValidation = { valid: false, errors: out.errors };
    return out;
  }

  const files = bundle.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    out.errors = ['[bundle] files must be an object mapping role to {path, content}'];
    out.automatedValidation = { valid: false, errors: out.errors };
    return out;
  }

  const unknownTop = Object.keys(bundle).filter((key) => !['files', 'manifest', 'images'].includes(key));
  for (const key of unknownTop) errors.push('[bundle] unknown key ' + JSON.stringify(key));

  // ---------------------------------------------------------------- step 0
  // Roles: exactly the seven, no extras, each a {path, content} pair.
  const requiredRoles = Object.keys(ROLE_PATHS);
  for (const role of Object.keys(files)) {
    if (!requiredRoles.includes(role)) errors.push('[manifest] unknown role ' + JSON.stringify(role));
  }
  const declared = new Map();
  for (const role of requiredRoles) {
    const entry = files[role];
    if (!entry || typeof entry !== 'object') {
      errors.push('[manifest] missing role ' + role);
      continue;
    }
    if (typeof entry.path !== 'string' || typeof entry.content === 'undefined' || entry.content === null) {
      errors.push('[manifest] role ' + role + ' needs {path, content}');
      continue;
    }
    const normalized = checkPathSyntax(entry.path, role, errors);
    if (!normalized) continue;
    // Approval records live under src/content/ too, but no other role may sit
    // under an approval path: content must never hide from the hash.
    if (role !== 'approvals' && isApprovalRecordPath(normalized)) {
      errors.push('[manifest] role ' + role + ' must not use an approval-record path: ' + normalized);
    }
    declared.set(role, normalized);
  }

  // Duplicate paths and conflicting roles.
  const byPath = new Map();
  for (const [role, path] of declared) {
    if (byPath.has(path)) {
      errors.push('[manifest] duplicate path ' + JSON.stringify(path) + ' used by roles ' + byPath.get(path) + ' and ' + role);
    } else {
      byPath.set(path, role);
    }
  }

  // Schema impersonation: a content file may not occupy a schema path.
  const schemaPaths = SCHEMA_FILES.map((name) => 'src/content/schema/' + name);
  for (const [role, path] of declared) {
    if (schemaPaths.includes(path)) errors.push('[manifest] role ' + role + ' must not occupy a schema path: ' + path);
  }

  const manifestEntry = bundle.manifest;
  let manifest;
  if (manifestEntry === undefined || manifestEntry === null) {
    errors.push('[manifest] manifest is required (lesson-package.json)');
  } else if (typeof manifestEntry.path !== 'string' || manifestEntry.content === undefined) {
    errors.push('[manifest] manifest needs {path, content}');
  } else {
    const manifestPath = checkPathSyntax(manifestEntry.path, 'manifest', errors);
    if (manifestPath && manifestPath !== MANIFEST_FILENAME) {
      errors.push('[manifest] manifest must sit at the package root as ' + MANIFEST_FILENAME + ' (got ' + manifestPath + ')');
    }
    if (manifestPath && byPath.has(manifestPath)) {
      errors.push('[manifest] manifest path collides with role ' + byPath.get(manifestPath));
    }
    manifest = parseJson(manifestEntry.content, 'manifest', errors);
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      for (const key of Object.keys(manifest)) {
        if (!MANIFEST_KEYS.includes(key)) errors.push('[manifest] unknown key ' + JSON.stringify(key));
      }
      if (manifest.files && typeof manifest.files === 'object') {
        for (const key of Object.keys(manifest.files)) {
          if (!MANIFEST_FILE_KEYS.includes(key)) errors.push('[manifest] unknown file role ' + JSON.stringify(key));
        }
        for (const role of MANIFEST_FILE_KEYS) {
          if (!manifest.files[role]) {
            errors.push('[manifest] missing file role ' + role);
            continue;
          }
          const declaredPath = declared.get(role);
          if (declaredPath && declaredPath !== manifest.files[role]) {
            errors.push('[manifest] role ' + role + ' path disagrees with the supplied file (' + manifest.files[role] + ' vs ' + declaredPath + ')');
          }
        }
      } else {
        errors.push('[manifest] files map is required');
      }
      if (manifest.schemaVersion !== SCHEMA_VERSION) {
        errors.push('[manifest] schemaVersion ' + JSON.stringify(manifest.schemaVersion) + ' does not match ' + SCHEMA_VERSION);
      }
      if (manifest.hashAlgorithmVersion !== HASH_ALGORITHM_VERSION) {
        errors.push('[manifest] hashAlgorithmVersion ' + JSON.stringify(manifest.hashAlgorithmVersion) + ' does not match ' + HASH_ALGORITHM_VERSION);
      }
    }
  }

  // Images: unique, safe paths, and they must exist in disk mode.
  const imageEntries = Array.isArray(bundle.images) ? bundle.images : [];
  if (bundle.images !== undefined && !Array.isArray(bundle.images)) errors.push('[manifest] images must be an array');
  const imageSeen = new Set();
  for (const image of imageEntries) {
    if (!image || typeof image !== 'object' || typeof image.path !== 'string') {
      errors.push('[manifest] every image needs {path, content}');
      continue;
    }
    const normalized = checkPathSyntax(image.path, 'image', errors);
    if (!normalized) continue;
    if (imageSeen.has(normalized)) errors.push('[manifest] duplicate image path ' + JSON.stringify(normalized));
    imageSeen.add(normalized);
    if (byPath.has(normalized)) errors.push('[manifest] image path collides with role ' + byPath.get(normalized));
    if (normalized.startsWith('src/content/')) errors.push('[manifest] images must live under assets/, not ' + normalized);
    if (image.content === undefined || image.content === null) {
      errors.push('[files] image ' + normalized + ' is missing content');
    }
  }

  // ---------------------------------------------------------------- step 1
  // Lesson identity: the lessonId in the manifest must exist exactly once, and
  // all roles must agree on it.
  const hierarchyData = files.hierarchy?.content !== undefined
    ? parseJson(files.hierarchy.content, 'hierarchy', errors)
    : undefined;
  const hierarchyCheck = hierarchyData === undefined ? null : validateHierarchy(hierarchyData);
  if (hierarchyCheck && !hierarchyCheck.valid) {
    for (const error of hierarchyCheck.errors) errors.push('[hierarchy] ' + error);
  }
  const lessonId = manifest?.lessonId;
  if (!lessonId) {
    errors.push('[identity] manifest.lessonId is required');
  } else if (hierarchyData !== undefined) {
    const occurrences = findLessonOccurrences(hierarchyData, lessonId);
    if (occurrences.length === 0) errors.push('[identity] lesson ' + lessonId + ' does not exist in the hierarchy');
    if (occurrences.length > 1) errors.push('[identity] lesson ' + lessonId + ' appears ' + occurrences.length + ' times in the hierarchy');
  }

  // ---------------------------------------------------------------- step 2
  // Blocks: structural validation, unique ids, and every block referenced by
  // the hierarchy must exist (reverse existence).
  const blocksData = files.blocks?.content !== undefined ? parseJson(files.blocks.content, 'blocks', errors) : undefined;
  const blockList = Array.isArray(blocksData) ? blocksData : undefined;
  if (blocksData !== undefined && !Array.isArray(blocksData)) errors.push('[blocks] blocks file must contain an array');
  const blockIds = new Set();
  if (blockList) {
    for (const block of blockList) {
      const blockCheck = validateContentBlock(block);
      if (!blockCheck.valid) {
        for (const error of blockCheck.errors) errors.push('[blocks] ' + error);
      }
      if (block && typeof block === 'object') {
        if (blockIds.has(block.id)) errors.push('[blocks] duplicate block id: ' + block.id);
        blockIds.add(block.id);
        if (lessonId && block.lessonId !== lessonId) {
          errors.push('[blocks] block ' + block.id + ' belongs to lesson ' + block.lessonId + ', not ' + lessonId);
        }
      }
    }
    if (hierarchyData !== undefined && lessonId) {
      const occurrences = findLessonOccurrences(hierarchyData, lessonId);
      if (occurrences.length === 1) {
        const referenced = new Set();
        for (const stage of Array.isArray(occurrences[0].lesson.stages) ? occurrences[0].lesson.stages : []) {
          for (const blockId of Array.isArray(stage?.blockIds) ? stage.blockIds : []) referenced.add(blockId);
        }
        for (const blockId of referenced) {
          if (!blockIds.has(blockId)) errors.push('[blocks] hierarchy references unknown block ' + blockId);
        }
      }
    }
  }

  // ---------------------------------------------------------------- step 3
  // Coverage: runs with the already validated block list and hierarchy, so a
  // structurally broken block cannot slip through as "covered".
  const coverageData = files.coverage?.content !== undefined ? parseJson(files.coverage.content, 'coverage', errors) : undefined;
  if (coverageData !== undefined && !Array.isArray(coverageData)) errors.push('[coverage] coverage file must contain an array');
  if (Array.isArray(coverageData) && blockList && hierarchyData !== undefined) {
    const coverageCheck = validateCoverage(coverageData, blockList, hierarchyData);
    if (!coverageCheck.valid) {
      for (const error of coverageCheck.errors) errors.push('[coverage] ' + error);
    }
    out.uncovered = coverageCheck.uncovered ?? [];
    for (const item of coverageData) {
      if (lessonId && item && item.lessonId !== lessonId) {
        errors.push('[coverage] element ' + item.elementId + ' belongs to lesson ' + item.lessonId + ', not ' + lessonId);
      }
    }
  }

  // ---------------------------------------------------------------- step 4
  // Sources: preparation gate plus figure id resolution. Figure numbers are
  // globally scoped here, matching the existing contract exactly.
  let sourcesData;
  let expectedSources;
  if (files.sources?.content !== undefined) {
    sourcesData = parseJson(files.sources.content, 'sources', errors);
    if (sourcesData && typeof sourcesData === 'object') {
      const pages = Array.isArray(sourcesData.pages) ? sourcesData.pages : [];
      const figures = Array.isArray(sourcesData.figures) ? sourcesData.figures : [];
      expectedSources = {
        pages: pages.filter((p) => p && p.essential === true).map((p) => p.pageNo),
        figures: figures.filter((f) => f && f.essential === true).map((f) => f.figureNo),
      };
      const gate = validateSourcePrepGate(pages, figures, expectedSources);
      if (gate.blocked) {
        for (const blocker of gate.blockers) errors.push('[sources] ' + blocker);
      }
    }
  }
  const knownFigureIds = collectFigureIds(sourcesData);

  // ---------------------------------------------------------------- step 5
  // Notebook: sub-items are derived from coverage, never supplied separately.
  // lessonId must agree across coverage, notebook, and profile.
  if (files.notebook?.content !== undefined) {
    const notebookData = parseJson(files.notebook.content, 'notebook', errors);
    if (notebookData && typeof notebookData === 'object') {
      const notebook = notebookData.notebook;
      const profile = notebookData.profile;
      if (lessonId) {
        if (notebook && notebook.lessonId !== lessonId) {
          errors.push('[notebook] notebook.lessonId ' + notebook.lessonId + ' does not match ' + lessonId);
        }
        if (profile && profile.lessonId !== lessonId) {
          errors.push('[notebook] profile.lessonId ' + profile.lessonId + ' does not match ' + lessonId);
        }
        for (const item of Array.isArray(coverageData) ? coverageData : []) {
          if (item && item.lessonId !== lessonId) {
            errors.push('[notebook] coverage element ' + item.elementId + ' does not belong to ' + lessonId);
          }
        }
      }
      const subItems = flattenSubItems(coverageData);
      const notebookCheck = validateNotebook(notebook, subItems, profile);
      if (!notebookCheck.valid) {
        for (const error of notebookCheck.errors) errors.push('[notebook] ' + error);
      }
      // Figure payloads must resolve to a known global figure id.
      if (Array.isArray(notebook?.sections)) {
        for (const section of notebook.sections) {
          for (const item of Array.isArray(section?.items) ? section.items : []) {
            if (item?.itemType === 'figure' && typeof item.payload?.figureId === 'string' && item.payload.figureId.length > 0) {
              if (!knownFigureIds.has(item.payload.figureId)) {
                errors.push('[notebook] item ' + item.itemId + ': unknown figureId ' + item.payload.figureId);
              }
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- step 6
  // Quizzes: unit structure comes from the hierarchy. The quiz file may not
  // carry its own unit list.
  if (files.quizzes?.content !== undefined) {
    const quizData = parseJson(files.quizzes.content, 'quizzes', errors);
    if (quizData && typeof quizData === 'object' && !Array.isArray(quizData)) {
      for (const key of Object.keys(quizData)) {
        if (!QUIZ_FILE_KEYS.includes(key)) {
          errors.push('[quizzes] unknown key ' + JSON.stringify(key) + ' (unit structure is derived from the hierarchy)');
        }
      }
      const units = hierarchyData === undefined ? undefined : deriveUnits(hierarchyData);
      const quizzes = Array.isArray(quizData.quizzes) ? quizData.quizzes : [];
      const authorizations = Array.isArray(quizData.authorizations) ? quizData.authorizations : [];
      const authUnits = new Set();
      for (const auth of authorizations) {
        if (!auth || typeof auth !== 'object') continue;
        if (authUnits.has(auth.unitId)) errors.push('[quizzes] duplicate UnitTestAuthorization for unit ' + auth.unitId);
        authUnits.add(auth.unitId);
      }
      for (const quiz of quizzes) {
        const quizCheck = validateQuiz(quiz, authorizations, units);
        if (!quizCheck.valid) {
          for (const error of quizCheck.errors) errors.push('[quizzes] ' + error);
        }
        if (quiz && quiz.scope === 'lesson' && lessonId && quiz.lessonId !== lessonId) {
          errors.push('[quizzes] lesson quiz ' + quiz.id + ' belongs to ' + quiz.lessonId + ', not ' + lessonId);
        }
        if (quiz && Array.isArray(quiz.questions)) {
          const seenQuestionIds = new Set();
          for (const question of quiz.questions) {
            if (!question || typeof question !== 'object') continue;
            if (seenQuestionIds.has(question.id)) errors.push('[quizzes] quiz ' + quiz.id + ': duplicate question id ' + question.id);
            seenQuestionIds.add(question.id);
            const choices = Array.isArray(question.choices) ? question.choices : [];
            if (question.correctIndex !== undefined && question.correctIndex !== null) {
              if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= choices.length) {
                errors.push('[quizzes] quiz ' + quiz.id + ': question ' + question.id + ' correctIndex is outside the choices range');
              }
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- step 7
  // Files on disk: existence and containment, only when a root is supplied.
  if (options.diskRoot) {
    const rootDir = options.diskRoot;
    for (const [role, path] of declared) {
      const absolute = resolveInsideRoots(rootDir, path, errors, role);
      if (!absolute) continue;
      readFileSafely(absolute, role, errors);
    }
    for (const image of imageSeen) {
      const absolute = resolveInsideRoots(rootDir, image, errors, 'image');
      if (!absolute) continue;
      readFileSafely(absolute, image, errors);
    }
  }

  // ---------------------------------------------------------------- step 8
  // Hash: computed over the exact raw contents that were validated above.
  const schemaFiles = Array.isArray(options.schemaFiles) ? options.schemaFiles : [];
  if (options.schemaFiles !== undefined && schemaFiles.length !== SCHEMA_FILES.length) {
    errors.push('[hash] the seven schema files must be supplied for hashing');
  }
  const hashInputs = [];
  if (manifestEntry && typeof manifestEntry.path === 'string' && manifestEntry.content !== undefined) {
    hashInputs.push({ path: manifestEntry.path, content: manifestEntry.content });
  }
  for (const role of requiredRoles) {
    const entry = files[role];
    if (entry && typeof entry.path === 'string' && entry.content !== undefined) {
      hashInputs.push({ path: entry.path, content: entry.content });
    }
  }
  for (const image of imageEntries) {
    if (image && typeof image.path === 'string' && image.content !== undefined) {
      hashInputs.push({ path: image.path, content: image.content });
    }
  }
  for (const schemaFile of schemaFiles) {
    if (schemaFile && typeof schemaFile.path === 'string' && schemaFile.content !== undefined) {
      hashInputs.push({ path: schemaFile.path, content: schemaFile.content });
    }
  }

  let computedHash;
  try {
    computedHash = computeVersionHash(hashInputs, { schemaVersion: SCHEMA_VERSION, hashAlgorithmVersion: HASH_ALGORITHM_VERSION });
    out.hash = computedHash;
  } catch (err) {
    // T-3b: the internal TypeError becomes a structured error here. The public
    // interface never throws.
    if (err instanceof TypeError) {
      errors.push('[hash] ' + err.message);
    } else {
      throw err;
    }
  }

  // ---------------------------------------------------------------- step 9
  // Approval layers. D-publishing is never a mandatory gate and never blocks
  // readyToPublish; it only selects the publishing status.
  let approvalRecords = [];
  let chainErrors = [];
  if (files.approvals?.content !== undefined) {
    const approvalsData = parseJson(files.approvals.content, 'approvals', errors);
    approvalRecords = Array.isArray(approvalsData) ? approvalsData : [];
    if (approvalsData !== undefined && !Array.isArray(approvalsData)) {
      errors.push('[approval] approvals file must contain an array of records');
    }
    if (lessonId) {
      for (const record of approvalRecords) {
        if (record && record.lessonId !== undefined && record.lessonId !== lessonId) {
          errors.push('[approval] record for lesson ' + record.lessonId + ' does not match ' + lessonId);
        }
      }
    }
    // D-publishing is a separate step: its result and its hash never gate the
    // approval chain, so it is excluded from the chain evaluation entirely.
    const chainRecords = approvalRecords.filter((record) => record && record.gate !== 'D-publishing');
    const chain = validateApprovalChain(chainRecords, computedHash);
    chainErrors = chain.errors;
  } else {
    chainErrors = ['[approval] approvals file is required'];
  }

  out.scientificReview = gateLayer(approvalRecords, 'B-scientific', ['pass'], computedHash, schemas);
  out.notebookEducational = gateLayer(approvalRecords, 'B-notebook-educational', ['pass'], computedHash, schemas);
  out.ownerApproval = gateLayer(approvalRecords, 'C-owner', ['approved'], computedHash, schemas);

  const automated = gateLayer(approvalRecords, 'A-automated', ['pass'], computedHash, schemas);
  for (const error of chainErrors) {
    const tagged = error.startsWith('[') ? error : '[approval] ' + error;
    if (!errors.includes(tagged)) errors.push(tagged);
  }

  // --------------------------------------------------------------- step 10
  out.errors = errors;
  out.notes = notes;
  out.automatedValidation = { valid: errors.length === 0, errors };
  out.valid = errors.length === 0;
  out.readyToPublish = out.valid
    && out.scientificReview.valid
    && out.notebookEducational.valid
    && out.ownerApproval.valid
    && automated.valid;

  const publishingRecords = approvalRecords.filter((record) => record && record.gate === 'D-publishing');
  const published = publishingRecords.some(
    (record) => record.result === 'published' && (computedHash === undefined || record.versionHash === computedHash),
  );
  if (publishingRecords.length > 1) {
    out.errors.push('[approval] duplicate gate record: D-publishing');
    out.notes.push('[approval] duplicate D-publishing records were ignored for status');
  }
  out.publishingStatus = published ? 'published' : (out.readyToPublish ? 'ready' : 'not-ready');
  if (published && !out.readyToPublish) {
    out.notes.push('[approval] a D-publishing record exists but the package is not ready to publish');
  }

  out.notes.push('[approval] approval validity proves record presence, shape, result, and hash match only; it does not prove a human review occurred or who performed it.');
  return out;
}

// Disk loader: reads the manifest, resolves every role through realpath
// containment, and returns a bundle of raw bytes. The bytes read here are the
// bytes hashed.
export function loadLessonPackageFromDisk(rootDir, manifestRelPath = MANIFEST_FILENAME) {
  const errors = [];
  // The manifest is the single anchor outside the content roots: it must sit at
  // the package root, so containment against the content roots does not apply.
  const syntactic = checkPathSyntax(manifestRelPath, 'manifest', errors);
  if (!syntactic || syntactic !== MANIFEST_FILENAME) {
    errors.push('[manifest] manifest must be ' + MANIFEST_FILENAME + ' at the package root');
    return { ok: false, errors };
  }
  const manifestAbsolute = resolve(realpathSync(resolve(rootDir)), syntactic);
  let manifestContent;
  try {
    manifestContent = readFileSync(manifestAbsolute);
  } catch (err) {
    return { ok: false, errors: ['[files] manifest: cannot read (' + err.code + ')'] };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString('utf8'));
  } catch (err) {
    return { ok: false, errors: ['[parse] manifest: content is not valid JSON (' + err.message + ')'] };
  }
  const files = {};
  const readRole = (role, relPath) => {
    if (!relPath) return;
    const absoluteRoot = realpathSync(resolve(rootDir));
    const candidate = resolve(absoluteRoot, relPath);
    let realCandidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch (err) {
      errors.push('[files] ' + role + ': ' + relPath + ' is not readable (' + err.code + ')');
      return;
    }
    const allowed = ALLOWED_ROOTS.map((root) => {
      try {
        return realpathSync(resolve(absoluteRoot, root.replace(/\/$/, '')));
      } catch {
        return null;
      }
    }).filter(Boolean);
    const contained = allowed.some((root) => realCandidate === root || realCandidate.startsWith(root + sep));
    if (!contained) {
      errors.push('[files] ' + role + ': ' + relPath + ' resolves outside the allowed roots');
      return;
    }
    const content = readFileSafely(realCandidate, role, errors);
    if (content !== undefined) files[role] = { path: relPath, content };
  };
  for (const [role, relPath] of Object.entries(manifest?.files ?? {})) readRole(role, relPath);
  const images = [];
  for (const imagePath of Array.isArray(manifest?.images) ? manifest.images : []) {
    const absoluteRoot = realpathSync(resolve(rootDir));
    let realCandidate;
    try {
      realCandidate = realpathSync(resolve(absoluteRoot, imagePath));
    } catch (err) {
      errors.push('[files] image: ' + imagePath + ' is not readable (' + err.code + ')');
      continue;
    }
    const content = readFileSafely(realCandidate, 'image', errors);
    if (content !== undefined) images.push({ path: imagePath, content });
  }
  return {
    ok: errors.length === 0,
    errors,
    bundle: { files, manifest: { path: manifestRelPath, content: manifestContent }, images },
  };
}
