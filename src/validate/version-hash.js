// Task 005 version hash: deterministic SHA-256 over the exact raw bytes that
// were validated. No JSON canonicalisation: a formatting-only change is a new
// version and invalidates earlier approvals on purpose.
//
// Contract (frozen):
//   - SHA-256, lowercase hex.
//   - Paths: relative POSIX, single "/" separator, normalised by dropping "."
//     and empty segments. Absolute paths, backslashes, ".." segments and NUL
//     are rejected. No case folding, no unicode normalisation, no symlink
//     resolution inside the hash.
//   - Sort: ascending UTF-8 bytewise (NOT JavaScript UTF-16 string order).
//   - Per file: d_i = SHA256_HEX(utf8(path_i) + 0x00 + rawBytes_i)
//   - Header (literal):
//       "ofuq-package-hash\n"
//       "hashAlgorithmVersion:" + HASH_ALGORITHM_VERSION + "\n"
//       "schemaVersion:"         + SCHEMA_VERSION         + "\n"
//       "fileCount:"             + String(n)              + "\n"
//       "---\n"
//   - Final: SHA256_HEX(utf8(header) + utf8(d_1 + "\n" + ... + "\n" + d_n))
//   - Approval records are excluded before sorting/counting.
//   - Changing either version constant changes every hash, so all earlier
//     approvals are invalidated.
//
// computeVersionHash throws TypeError on invalid input (empty list after
// exclusion, missing content, duplicate or rejected path). The public lesson
// package interface catches that TypeError and reports it as a structured
// error, so the public layer never throws.

import { createHash } from 'node:crypto';

// Version of the data contract (the seven schemas AND the validator rules that
// the schemas cannot express). Any change to a validator rule MUST bump this,
// even when no schema file changes.
export const SCHEMA_VERSION = '1.0.0';

// Version of the hashing algorithm itself. Any change to how the hash is
// computed MUST bump this.
export const HASH_ALGORITHM_VERSION = '1';

export const HASH_HEADER_PREFIX = 'ofuq-package-hash';

export const VERSION_HASH_INCLUDES = [
  'lesson data',
  'stages',
  'notebook',
  'coverage matrix',
  'source records',
  'images',
  'figures',
  'equations',
  'schemas',
  'package manifest',
];

export const VERSION_HASH_EXCLUDES = ['approval records', 'owner approvals'];

// Precise exclusion: only paths inside an `approvals/` directory segment or
// named exactly `approval.json` / `*.approval.json` are excluded. A content
// file whose name merely contains the word "approval" (e.g.
// `lesson-approval-overview.json`) is NOT excluded.
export function isApprovalRecordPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.includes('approvals')) return true;
  const basename = segments[segments.length - 1] ?? '';
  return basename === 'approval.json' || basename.endsWith('.approval.json');
}

export function filterHashInputs(files) {
  return (files ?? []).filter((file) => !isApprovalRecordPath(file?.path));
}

// Kept exported for consumers that want a canonical form for display or
// comparison. It is NOT part of the hash path any more: hashing always uses
// raw bytes.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

// Normalises a path for hashing. Returns { ok: true, path } or
// { ok: false, error }. Throws nothing.
export function normalizeHashPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  if (path.includes('\u0000')) return { ok: false, error: 'path must not contain NUL: ' + JSON.stringify(path) };
  if (path.includes('\\')) return { ok: false, error: 'path must use "/" not "\\": ' + path };
  if (path.startsWith('/')) return { ok: false, error: 'absolute paths are not allowed: ' + path };
  if (/^[A-Za-z]:/.test(path)) return { ok: false, error: 'drive-letter paths are not allowed: ' + path };
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, error: 'path must not contain "..": ' + path };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, error: 'path normalises to empty: ' + JSON.stringify(path) };
  return { ok: true, path: segments.join('/') };
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return Buffer.from(String(content), 'utf8');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Ascending UTF-8 bytewise comparison (not JS UTF-16 string order).
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// files: [{ path: string, content: string | Buffer | Uint8Array }]
// options: { schemaVersion, hashAlgorithmVersion }
// Throws TypeError on invalid input or when nothing is left after excluding
// approval records.
export function computeVersionHash(files, options = {}) {
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  const hashAlgorithmVersion = options.hashAlgorithmVersion ?? HASH_ALGORITHM_VERSION;

  if (!Array.isArray(files) || files.length === 0) throw new TypeError('files must be a non-empty array');
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path.length === 0) {
      throw new TypeError('every file must have a non-empty path');
    }
    if (file.content === undefined || file.content === null) {
      throw new TypeError(`file ${file.path} is missing content`);
    }
  }

  const inputs = filterHashInputs(files);
  const seen = new Set();
  const prepared = [];
  for (const file of inputs) {
    const normalized = normalizeHashPath(file.path);
    if (!normalized.ok) throw new TypeError(normalized.error);
    if (seen.has(normalized.path)) throw new TypeError(`duplicate path: ${normalized.path}`);
    seen.add(normalized.path);
    prepared.push({ path: normalized.path, content: file.content });
  }
  // Zero files after excluding approval records is a hard error, never an
  // empty hash: a package with no content proves nothing.
  if (prepared.length === 0) throw new TypeError('no hashable files remain after excluding approval records');

  prepared.sort((a, b) => compareUtf8(a.path, b.path));

  const perFile = prepared.map((file) => {
    const pathBytes = Buffer.from(`${file.path}\0`, 'utf8');
    return sha256Hex(Buffer.concat([pathBytes, toBuffer(file.content)]));
  });

  const header = [
    HASH_HEADER_PREFIX,
    `hashAlgorithmVersion:${hashAlgorithmVersion}`,
    `schemaVersion:${schemaVersion}`,
    `fileCount:${prepared.length}`,
    '---',
    '',
  ].join('\n');

  return sha256Hex(Buffer.concat([
    Buffer.from(header, 'utf8'),
    Buffer.from(perFile.join('\n'), 'utf8'),
  ]));
}
