import { jobStore, JobStatus } from '../../jobs/JobStore.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';

/**
 * GET /v1/jobs/:jobId/progress
 * SSE endpoint for real-time job progress.
 */
export async function handleJobProgress(ctx) {
  try {
    const { jobId } = ctx.params;

    if (!jobId) {
      ctx.error(400, 'Job ID is required');
      return;
    }

    const job = jobStore.getJob(jobId);
    if (!job) {
      ctx.error(404, `Job not found: ${jobId}`);
      return;
    }

    // Create SSE connection
    const sseJobId = ctx.createSseJob();

    // Send current state immediately
    ProgressReporter.send(sseJobId, 'state', {
      jobId: job.jobId,
      status: job.status,
      percent: job.percent,
      message: job.message,
      processor: job.processor,
      mode: job.mode,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
    });

    // If already completed/failed, send final event and close
    if (job.status === JobStatus.COMPLETED) {
      ProgressReporter.complete(sseJobId, {
        jobId: job.jobId,
        assetId: job.assetId,
        duration: job.completedAt - job.startedAt,
      });
      return;
    }

    if (job.status === JobStatus.FAILED) {
      ProgressReporter.send(sseJobId, 'error', {
        jobId: job.jobId,
        error: job.error,
      });
      ProgressReporter.close(sseJobId);
      return;
    }

    if (job.status === JobStatus.CANCELLED) {
      ProgressReporter.send(sseJobId, 'cancelled', { jobId: job.jobId });
      ProgressReporter.close(sseJobId);
      return;
    }

    // For queued/processing jobs, the worker will send progress events
    // Link the SSE connection to the job for progress forwarding
    ProgressReporter.linkJob(sseJobId, jobId);
  } catch (error) {
    logger.error('Job progress SSE failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/jobs/:jobId
 * Polling endpoint for job status.
 */
export async function handleGetJob(ctx) {
  try {
    const { jobId } = ctx.params;

    if (!jobId) {
      ctx.error(400, 'Job ID is required');
      return;
    }

    const job = jobStore.getJob(jobId);
    if (!job) {
      ctx.error(404, `Job not found: ${jobId}`);
      return;
    }

    const response = {
      jobId: job.jobId,
      status: job.status,
      processor: job.processor,
      mode: job.mode,
      percent: job.percent,
      message: job.message,
      assetId: job.assetId,
      error: job.error,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
      queuePosition: job.status === JobStatus.QUEUED ? job.queuePosition : null,
    };

    ctx.json(200, response);
  } catch (error) {
    logger.error('Get job failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * DELETE /v1/jobs/:jobId
 * Cancel a queued job.
 */
export async function handleCancelJob(ctx) {
  try {
    const { jobId } = ctx.params;

    if (!jobId) {
      ctx.error(400, 'Job ID is required');
      return;
    }

    const job = jobStore.getJob(jobId);
    if (!job) {
      ctx.error(404, `Job not found: ${jobId}`);
      return;
    }

    if (job.status !== JobStatus.QUEUED && job.status !== JobStatus.PROCESSING) {
      ctx.error(409, `Cannot cancel job with status: ${job.status}. Only queued or processing jobs can be cancelled.`);
      return;
    }

    jobStore.updateJob(jobId, JobStatus.CANCELLED, {
      message: 'Cancelled by client',
    });

    ctx.json(200, {
      jobId,
      status: JobStatus.CANCELLED,
      message: 'Job cancelled successfully',
    });
  } catch (error) {
    logger.error('Cancel job failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/jobs/active
 * List active (non-deleted) jobs for the admin monitor.
 */
export async function handleListActiveJobs(ctx) {
  try {
    const { processor, limit } = ctx.query;

    let jobs = jobStore.getAllJobs();

    if (processor) {
      jobs = jobs.filter(j => j.processor === processor);
    }

    jobs.sort((a, b) => b.createdAt - a.createdAt);

    const maxLimit = parseInt(limit) || 200;
    jobs = jobs.slice(0, maxLimit);

    ctx.json(200, {
      jobs: jobs.map(j => ({
        jobId: j.jobId,
        fileId: j.fileId,
        inputPath: j.inputPath,
        processor: j.processor,
        mode: j.mode,
        status: j.status,
        percent: j.percent,
        message: j.message,
        assetId: j.assetId,
        outputPath: j.outputPath,
        createdAt: new Date(j.createdAt).toISOString(),
        startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null,
        completedAt: j.completedAt ? new Date(j.completedAt).toISOString() : null,
      })),
      total: jobs.length,
      stats: jobStore.getStats(),
    });
  } catch (error) {
    logger.error('List active jobs failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /v1/jobs
 * List all jobs with optional filters.
 */
export async function handleListJobs(ctx) {
  try {
    const { status, processor, limit } = ctx.query;

    let jobs = jobStore.getAllJobs();

    if (status) {
      jobs = jobs.filter(j => j.status === status);
    }

    if (processor) {
      jobs = jobs.filter(j => j.processor === processor);
    }

    jobs.sort((a, b) => b.createdAt - a.createdAt);

    const maxLimit = parseInt(limit) || 100;
    jobs = jobs.slice(0, maxLimit);

    ctx.json(200, {
      jobs: jobs.map(j => ({
        jobId: j.jobId,
        fileId: j.fileId,
        inputPath: j.inputPath,
        processor: j.processor,
        mode: j.mode,
        status: j.status,
        percent: j.percent,
        message: j.message,
        assetId: j.assetId,
        createdAt: new Date(j.createdAt).toISOString(),
        startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null,
        completedAt: j.completedAt ? new Date(j.completedAt).toISOString() : null,
      })),
      total: jobs.length,
      stats: jobStore.getStats(),
    });
  } catch (error) {
    logger.error('List jobs failed', { error: error.message });
    ctx.error(500, error.message);
  }
}
