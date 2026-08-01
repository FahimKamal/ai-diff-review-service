import { randomUUID } from 'crypto';
import { parseDiff } from './diffParser.js';
import { analyzeWithMock } from './mockProvider.js';
import { chunkDiff } from './chunker.js';

/**
 * Job Manager
 * Handles job lifecycle, state transitions, async queueing, and concurrency limits.
 */

// In-memory store: jobId -> Job
const jobs = new Map();

// Concurrency control
const MAX_CONCURRENT_JOBS = 4;
let activeJobCount = 0;
const jobQueue = []; // array of jobIds waiting to run

/**
 * Gets a job by its ID.
 * @param {string} jobId
 * @returns {object|null}
 */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Creates and registers a new job.
 * @param {string} diff - raw diff content
 * @param {object} options - { provider: 'mock'|'llm', maxFindings: number }
 * @param {boolean} cacheHit - whether this job was satisfied via cache
 * @param {string} [presetJobId] - optional preset jobId (e.g. from idempotency/cache)
 * @returns {object} Job
 */
export function createJob(diff, options = {}, cacheHit = false, presetJobId = null) {
  const jobId = presetJobId || randomUUID();
  const inputBytes = Buffer.byteLength(diff, 'utf8');

  const normalizedOptions = {
    provider: options.provider || 'mock',
    maxFindings: typeof options.maxFindings === 'number' ? options.maxFindings : 100
  };

  const job = {
    jobId,
    status: 'queued',
    diff,
    options: normalizedOptions,
    findings: [],
    usage: {
      inputBytes,
      chunks: 1,
      cacheHit
    },
    events: [
      { event: 'status', data: { status: 'queued' } }
    ],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  jobs.set(jobId, job);

  // If it's a cache hit, we don't need to re-run processing, but we can complete it instantly
  // If not, queue for async processing
  return job;
}

/**
 * Enqueues a job for async processing adhering to maxConcurrentJobs limit.
 * @param {string} jobId
 * @param {function} [executor] - optional custom executor (e.g. for mock vs llm vs cached)
 */
export function enqueueJob(jobId, executor = null) {
  const job = jobs.get(jobId);
  if (!job) return;

  jobQueue.push({ jobId, executor });
  processNextInQueue();
}

/**
 * Process the next job in the queue if concurrency slots are available.
 */
async function processNextInQueue() {
  if (activeJobCount >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) {
    return;
  }

  const { jobId, executor } = jobQueue.shift();
  const job = jobs.get(jobId);
  if (!job) {
    processNextInQueue();
    return;
  }

  activeJobCount++;

  // Transition to running
  job.status = 'running';
  job.updatedAt = Date.now();
  job.events.push({ event: 'status', data: { status: 'running' } });

  // Execute processing asynchronously
  setImmediate(async () => {
    try {
      if (executor) {
        await executor(job);
      } else {
        await defaultExecuteJob(job);
      }
    } catch (err) {
      job.status = 'failed';
      job.error = {
        code: 'internal',
        message: err.message || 'An internal error occurred during processing'
      };
      job.updatedAt = Date.now();
      job.events.push({ event: 'status', data: { status: 'failed', error: job.error } });
    } finally {
      activeJobCount--;
      processNextInQueue(); // process next queued job
    }
  });
}

/**
 * Default executor for mock provider & chunked scans.
 * @param {object} job
 */
export async function defaultExecuteJob(job) {
  const { diff, options, usage } = job;

  // Chunk diff if larger than 64 KiB (65536 bytes)
  const chunks = chunkDiff(diff);
  usage.chunks = chunks.length;

  let allFindingsMap = new Map();
  let totalScanCount = 0;

  if (options.provider === 'mock') {
    // Process each chunk through mock provider
    for (const chunk of chunks) {
      const parsedFiles = parseDiff(chunk);
      // Run mock analysis with high max limit to collect all candidate findings across chunks
      const { findings } = analyzeWithMock(parsedFiles, Number.MAX_SAFE_INTEGER);
      for (const finding of findings) {
        if (!allFindingsMap.has(finding.id)) {
          allFindingsMap.set(finding.id, finding);
        }
      }
    }

    // Sort all combined findings across chunks: path (lex) -> line (asc) -> ruleId
    const sortedFindings = Array.from(allFindingsMap.values()).sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      if (a.line < b.line) return -1;
      if (a.line > b.line) return 1;
      if (a.ruleId < b.ruleId) return -1;
      if (a.ruleId > b.ruleId) return 1;
      return 0;
    });

    totalScanCount = sortedFindings.length;

    // Apply maxFindings truncation to the ordered list
    const finalFindings = sortedFindings.slice(0, options.maxFindings);
    job.findings = finalFindings;

    // Record individual finding events for SSE
    for (const finding of finalFindings) {
      job.events.push({ event: 'finding', data: finding });
    }
  } else if (options.provider === 'llm') {
    // LLM provider path (will be wired up in Subtask 12)
    // For now, if LLM module isn't connected or fails, gracefully set to failed
    throw new Error('LLM provider is currently unconfigured or unreachable.');
  }

  // Complete job
  job.status = 'done';
  job.updatedAt = Date.now();

  const doneEventData = {
    total: job.findings.length,
    usage: {
      inputBytes: usage.inputBytes,
      chunks: usage.chunks,
      cacheHit: usage.cacheHit
    }
  };
  job.events.push({ event: 'status', data: { status: 'done' } });
  job.events.push({ event: 'done', data: doneEventData });
}
