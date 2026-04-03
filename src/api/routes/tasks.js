import { taskManager } from '../../tasks/TaskManager.js';
import { TaskStatus } from '../../tasks/Task.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import { assetCache } from '../../cache/AssetCache.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';

/**
 * Validate task type
 * @param {string} type
 * @returns {boolean}
 */
function isValidTaskType(type) {
  return ['image', 'audio', 'video'].includes(type);
}

/**
 * POST /v1/tasks
 * Create and submit a new task
 */
export async function handleCreateTask(ctx) {
  try {
    const { type, input, options } = ctx.body;

    if (!type || !isValidTaskType(type)) {
      ctx.error(400, `Invalid task type. Must be one of: image, audio, video`);
      return;
    }

    if (!input) {
      ctx.error(400, 'No input provided. Send base64 data or file upload.');
      return;
    }

    let inputBuffer;
    let originalSize;

    // Handle file upload or base64 input
    if (ctx.file) {
      inputBuffer = ctx.file.buffer;
      originalSize = ctx.file.size;
    } else if (typeof input === 'string') {
      // Handle base64 input (strip data URL prefix if present)
      const base64Data = input.replace(/^data:[^;]+;base64,/, '');
      inputBuffer = Buffer.from(base64Data, 'base64');
      originalSize = inputBuffer.length;
    } else {
      ctx.error(400, 'Invalid input format. Send base64 string or file upload.');
      return;
    }

    // Create task
    const task = taskManager.createTask(type, inputBuffer, options || {}, ProgressReporter);

    // Store original size for response
    task._originalSize = originalSize;

    // Submit to queue
    taskManager.submitTask(task).catch((err) => {
      logger.error('Task submission error', { taskId: task.id, error: err.message });
    });

    // Return task info immediately - processing happens async
    ctx.json(202, {
      task_id: task.id,
      status: task.status,
      type: task.type,
      created_at: task.createdAt,
      message: 'Task queued for processing',
      progress_url: `/v1/tasks/${task.id}`,
    });
  } catch (error) {
    logger.error('Task creation failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/tasks
 * List all tasks or filter by status
 */
export async function handleListTasks(ctx) {
  try {
    const { status, type, limit } = ctx.query;

    let tasks = taskManager.getAllTasks();

    // Filter by status
    if (status) {
      if (!Object.values(TaskStatus).includes(status)) {
        ctx.error(400, `Invalid status. Must be one of: ${Object.values(TaskStatus).join(', ')}`);
        return;
      }
      tasks = tasks.filter((t) => t.status === status);
    }

    // Filter by type
    if (type) {
      if (!isValidTaskType(type)) {
        ctx.error(400, `Invalid type. Must be one of: image, audio, video`);
        return;
      }
      tasks = tasks.filter((t) => t.type === type);
    }

    // Sort by createdAt descending (newest first)
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    const maxLimit = parseInt(limit) || 100;
    tasks = tasks.slice(0, maxLimit);

    ctx.json(200, {
      tasks: tasks.map((t) => t.toJSON()),
      total: tasks.length,
      stats: taskManager.getStats(),
    });
  } catch (error) {
    logger.error('List tasks failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/tasks/:taskId
 * Get task status and details
 */
export async function handleGetTask(ctx) {
  try {
    const { taskId } = ctx.params;

    if (!taskId) {
      ctx.error(400, 'Task ID is required');
      return;
    }

    const task = taskManager.getTask(taskId);

    if (!task) {
      ctx.error(404, `Task not found: ${taskId}`);
      return;
    }

    ctx.json(200, task.toJSON());
  } catch (error) {
    logger.error('Get task failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/tasks/:taskId/result
 * Get task result (buffer)
 */
export async function handleGetTaskResult(ctx) {
  try {
    const { taskId } = ctx.params;

    if (!taskId) {
      ctx.error(400, 'Task ID is required');
      return;
    }

    const task = taskManager.getTask(taskId);

    if (!task) {
      ctx.error(404, `Task not found: ${taskId}`);
      return;
    }

    if (task.status !== TaskStatus.COMPLETED) {
      ctx.error(400, `Task not completed. Status: ${task.status}`);
      return;
    }

    let buffer;
    let mimeType;
    let extension;

    // Try to serve from asset cache first
    if (task.assetId) {
      const asset = assetCache.get(task.assetId);
      if (asset) {
        buffer = assetCache.getBuffer(task.assetId);
        mimeType = asset.mimeType;
        extension = assetCache._getExtension(asset.mimeType);
      }
    }

    // Fall back to task result buffer
    if (!buffer) {
      if (!task.result?.buffer) {
        ctx.error(404, 'No result buffer available');
        return;
      }
      buffer = task.result.buffer;
      mimeType = task.result.metadata?.mimeType || 'application/octet-stream';
      extension = task.result.metadata?.format || 'bin';
    }

    ctx.send(200, buffer, mimeType, `result.${extension}`);
  } catch (error) {
    logger.error('Get task result failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * DELETE /v1/tasks/:taskId
 * Cancel a pending task
 */
export async function handleCancelTask(ctx) {
  try {
    const { taskId } = ctx.params;

    if (!taskId) {
      ctx.error(400, 'Task ID is required');
      return;
    }

    const task = taskManager.getTask(taskId);

    if (!task) {
      ctx.error(404, `Task not found: ${taskId}`);
      return;
    }

    if (task.status !== TaskStatus.PENDING) {
      ctx.error(400, `Cannot cancel task with status: ${task.status}. Only pending tasks can be cancelled.`);
      return;
    }

    const cancelled = taskManager.cancelTask(taskId);

    if (!cancelled) {
      ctx.error(500, 'Failed to cancel task');
      return;
    }

    ctx.json(200, {
      task_id: taskId,
      status: 'cancelled',
      message: 'Task cancelled successfully',
    });
  } catch (error) {
    logger.error('Cancel task failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/tasks/stats
 * Get queue and worker statistics
 */
export async function handleTaskStats(ctx) {
  try {
    ctx.json(200, taskManager.getStats());
  } catch (error) {
    logger.error('Get task stats failed', { error: error.message });
    ctx.error(500, error.message);
  }
}
