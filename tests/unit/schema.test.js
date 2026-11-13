import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_KEYS } from '../../src/validate/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = join(root, 'src/content/schema');

const schemaFiles = readdirSync(schemaDir).filter((f) => f.endsWith('.json')).sort();

test('all seven schema files exist and parse as JSON', () => {
  assert.equal(schemaFiles.length, 7, `expected 7 schemas, found: ${schemaFiles.join(', ')}`);
  for (const file of schemaFiles) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
    assert.ok(typeof schema.title === 'string' && schema.title.length > 0, `${file}: title required`);
    assert.ok(schema.$schema, `${file}: $schema required`);
  }
});

test('hierarchy schema stage keys match validator stage keys', () => {
  const schema = JSON.parse(readFileSync(join(schemaDir, 'hierarchy.schema.json'), 'utf8'));
  const keys = schema.$defs.StageKey.enum;
  assert.deepEqual([...keys].sort(), [...STAGE_KEYS].sort());
});

test('content-block schema supports multiple sources', () => {
  const schema = JSON.parse(readFileSync(join(schemaDir, 'content-block.schema.json'), 'utf8'));
  assert.ok(schema.properties.sourceRefs, 'sourceRefs must exist');
  assert.equal(schema.properties.sourceRefs.type, 'array');
  assert.ok(!('maxItems' in schema.properties.sourceRefs), 'no single-source cap allowed');
});

test('approval schema separates the four gates', () => {
  const schema = JSON.parse(readFileSync(join(schemaDir, 'approval.schema.json'), 'utf8'));
  const gates = schema.$defs.ApprovalRecord.properties.gate.enum;
  for (const gate of ['A-automated', 'B-scientific', 'B-notebook-educational', 'C-owner', 'D-publishing']) {
    assert.ok(gates.includes(gate), `missing gate: ${gate}`);
  }
});
