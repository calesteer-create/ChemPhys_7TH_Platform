// Task 004 version hash: deterministic SHA-256 over every content-affecting
// input. Inclusion is by default (every file counts) except precise approval
// record paths, so recording an approval never changes the approved version.
// Same inputs always produce the same hash regardless of input order.

import { createHash } from 'node:crypto';

export const VERSION_HASH_INCLUDES = [
  'lesson data',
  'stages',
  'notebook',
  'coverage matrix',
  'source records',
  'images',
  'figures',
  'equations',
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

// Recursively sort object keys so equivalent JSON always canonicalizes alike.
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

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(String(content), 'utf8');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// JSON files are hashed over their canonical form so that formatting and key
// order never affect the hash; non-JSON files (images, etc.) hash raw bytes.
// Unparseable JSON falls back to raw bytes instead of throwing.
function contentBytes(path, content) {
  if (typeof path === 'string' && path.endsWith('.json')) {
    try {
      const text = Buffer.isBuffer(content) || content instanceof Uint8Array
        ? toBuffer(content).toString('utf8')
        : String(content);
      return Buffer.from(JSON.stringify(canonicalize(JSON.parse(text))), 'utf8');
    } catch {
      return toBuffer(content);
    }
  }
  return toBuffer(content);
}

// files: [{ path: string, content: string | Buffer | Uint8Array }]
// Paths are sorted in code-unit order; each file contributes
// sha256(path + NUL + bytes); the final hash covers the ordered list.
// Throws TypeError on missing inputs or duplicate paths.
export function computeVersionHash(files) {
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
  for (const file of inputs) {
    if (seen.has(file.path)) throw new TypeError(`duplicate path: ${file.path}`);
    seen.add(file.path);
  }
  const sorted = [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const perFile = sorted.map((file) => {
    const header = Buffer.from(`${file.path}\0`, 'utf8');
    return sha256Hex(Buffer.concat([header, contentBytes(file.path, file.content)]));
  });
  return sha256Hex(Buffer.from(perFile.join('\n'), 'utf8'));
}
