import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Task, TaskStatus } from '../src/tasks/Task.js';
import { TaskQueue } from '../src/tasks/TaskQueue.js';
import { TaskStore } from '../src/tasks/TaskStore.js';
import { TaskWorker } from '../src/tasks/Worker.js';
import ProgressReporter from '../src/pipeline/ProgressReporter.js';
import PipelineExecutor from '../src/pipeline/PipelineExecutor.js';
import { assetCache } from '../src/cache/AssetCache.js';
import { jobStore } from '../src/jobs/JobStore.js';
import logger from '../src/utils/logger.js';

const createdAssets = [];

// The queue mode runs the registered processor on this thread, which is the
// cheapest way to exercise the real Worker/queue hand-off.
PipelineExecutor.register('image', {
  validateOptions() {},
  async process(input, options, onProgress) {
    onProgress?.(100, 'done');
    const buffer = Buffer.from(`fake-output-${options?.tag ?? ''}`);
    return { buffer, metadata: { mimeType: 'image/png', outputSize: buffer.length } };
  },
});

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('a finishing task frees its worker before the next task is dispatched', async () => {
  const queue = new TaskQueue(1);
  const store = new TaskStore();
  const worker = new TaskWorker('worker-0', queue, store, 'queue');

  // Mirrors TaskManager.startTask: pick a worker with no active task.
  queue.setProcessor(async (task) => {
    const available = [worker].find((w) => !w.activeTask);
    if (!available) throw new Error('No available worker');
    await available.process(task);
  });

  const first = new Task('task-1', 'image', Buffer.from('a'), {}, ProgressReporter);
  const second = new Task('task-2', 'image', Buffer.from('b'), {}, ProgressReporter);
  store.add(first);
  store.add(second);

  await queue.enqueue(first);
  await queue.enqueue(second);
  await waitFor(() => first.status === TaskStatus.COMPLETED && second.status === TaskStatus.COMPLETED);

  assert.equal(first.status, TaskStatus.COMPLETED);
  assert.equal(second.status, TaskStatus.COMPLETED);
  assert.equal(queue.getRunningCount(), 0);

  for (const task of [first, second]) {
    if (task.assetId) createdAssets.push(task.assetId);
  }
});

test('a processor that throws releases its queue slot', async () => {
  const queue = new TaskQueue(1);
  queue.setProcessor(async () => {
    throw new Error('dispatch failed');
  });

  const failed = new Task('task-failed', 'image', Buffer.from('x'), {}, ProgressReporter);
  await queue.enqueue(failed);
  await waitFor(() => failed.status === TaskStatus.FAILED);

  assert.equal(failed.error, 'dispatch failed');
  assert.equal(queue.getRunningCount(), 0);

  let started = false;
  queue.setProcessor(async (task) => {
    started = true;
    task.fail(new Error('stop here'));
  });

  const next = new Task('task-next', 'image', Buffer.from('y'), {}, ProgressReporter);
  await queue.enqueue(next);
  assert.equal(started, true);
});

test.after(() => {
  for (const id of createdAssets) assetCache.delete(id);
  // Both singletons own cleanup intervals; without this the test process never exits.
  assetCache.shutdown();
  jobStore.shutdown();
  const info = logger.getSessionInfo();
  logger.close('task queue tests done');
  try {
    fs.unlinkSync(info.logFile);
  } catch {
    // Already gone.
  }
  try {
    fs.rmdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs'));
  } catch {
    // Other sessions are logging to the same directory.
  }
});
