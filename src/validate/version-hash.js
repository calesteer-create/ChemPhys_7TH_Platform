// Task 004 version hash: deterministic SHA-256 over every content-affecting
// input. Approval records themselves are excluded so that recording an
// approval never changes the version that was approved. Same inputs always
// produce the same hash regardless of input order.

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

export function isApprovalRecordPath(path) {
  return typeof path === 'string' && /approval/i.test(path);
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

// files: [{ path: string, content: string | Buffer | Uint8Array }]
// Paths are sorted in code-unit order; each file contributes
// sha256(path + NUL + bytes); the final hash covers the ordered list.
export function computeVersionHash(files) {
  const inputs = filterHashInputs(files);
  const sorted = [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const perFile = sorted.map((file) => {
    const header = Buffer.from(`${file.path}\0`, 'utf8');
    return sha256Hex(Buffer.concat([header, toBuffer(file.content)]));
  });
  return sha256Hex(Buffer.from(perFile.join('\n'), 'utf8'));
}
