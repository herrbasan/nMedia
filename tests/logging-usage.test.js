import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(srcDir);

const isLoggerModule = (file) => file.endsWith(path.join('utils', 'logger.js'));

test('every module that calls logger imports it', () => {
  const broken = files.filter((file) => {
    if (isLoggerModule(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    const calls = /logger\.(info|warn|error|debug|close|setLevel|getLevel)\s*\(/.test(text);
    const imports = /import\s+logger\b/.test(text);
    return calls && !imports;
  });
  // A missing import is invisible until the code path runs; the assets route
  // shipped that way and returned "logger is not defined" on every download.
  assert.deepEqual(broken, []);
});

test('logger.error is not called with a metadata object in the error slot', () => {
  const broken = files
    .filter((file) => !isLoggerModule(file))
    .filter((file) => /logger\.error\([^,]+,\s*\{/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(srcDir, file));
  // nLogger's signature is error(message, error, meta): an object literal in
  // the second position silently drops the message, the stack and the metadata.
  assert.deepEqual(broken, []);
});
