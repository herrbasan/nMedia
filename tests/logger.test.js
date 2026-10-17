import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, resetLogger } from '../modules/nLogger/src/logger.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmedia-log-test-'));

function newLogger() {
  resetLogger();
  return createLogger({ logsDir: tmpDir, sessionPrefix: 'test' });
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

test('level filtering hides lower levels but never errors', async () => {
  const logger = newLogger();
  logger.setLevel('warn');
  logger.info('hidden info');
  logger.warn('visible warn', { tag: 'warn' });
  logger.error('visible error', new Error('boom'), { tag: 'error' });

  const logFile = logger.getSessionInfo().logFile;
  logger.close('test done');
  await settled();

  const text = fs.readFileSync(logFile, 'utf8');
  assert.equal(text.includes('hidden info'), false);
  assert.match(text, /visible warn/);
  assert.match(text, /visible error/);
  assert.match(text, /boom/);
});

test('an unknown level is rejected', async () => {
  const logger = newLogger();
  assert.throws(() => logger.setLevel('bogus'), /Unknown log level/);
  logger.close('test done');
  await settled();
});

test('logError keeps the message, metadata and every stack frame', async () => {
  resetLogger();
  const { default: logger, logError } = await import('../src/utils/logger.js');

  function inner() {
    throw new Error('synthetic failure');
  }
  try {
    inner();
  } catch (error) {
    logError('Handler failed', error, { requestId: 'req-1', jobId: 'job-1' });
  }

  const logFile = logger.getSessionInfo().logFile;
  logger.close('test done');
  await settled();

  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /Handler failed/);
  assert.match(text, /"requestId":"req-1"/);
  assert.match(text, /"jobId":"job-1"/);
  // The stack is stored as an array so nLogger's 500-char string truncation
  // cannot cut it down to the first frame.
  assert.match(text, /at inner/);
  assert.match(text, /"stack":\[/);

  fs.unlinkSync(logFile);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.join(process.cwd(), 'logs'));
  } catch {
    // Other log files are present, or the directory is in use.
  }
});
