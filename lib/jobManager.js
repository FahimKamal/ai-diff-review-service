import { randomUUID } from 'crypto';
import { parseDiff } from './diffParser.js';
import { analyzeWithMock } from './mockProvider.js';
import { chunkDiff } from './chunker.js';
import { emitJobEvent, closeJobSubscribers } from './sseManager.js';

/**
 * Job Manager
 * Handles job lifecycle, state transitions, async queueing, and concurrency limits.
 * Integrates with sseManager to push live events to SSE subscribers.
 */

// In-memory store: jobId -> Job
const jobs = new Map();

// Concurrency control
const MAX_CONCURRENT_JOBS = 4;
let activeJobCount = 0;
const jobQueue = []; // array of { jobId, executor } waiting to run

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
 * @param {boolean} cacheHit - whether this result came from payload cache
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

  // Initialize events array with the initial queued status event
  // (recorded BEFORE any SSE subscriber connects, so replay works even from t=0)
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
    // events is the canonical event log — used for SSE replay
    events: [
      { event: 'status', data: { status: 'queued' } }
    ],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  jobs.set(jobId, job);
  return job;
}

/**
 * Enqueues a job for async processing adhering to maxConcurrentJobs limit.
 * @param {string} jobId
 * @param {function} [executor] - optional custom executor override
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

  // Transition to running — emit live event to SSE subscribers
  job.status = 'running';
  job.updatedAt = Date.now();
  emitJobEvent(job, 'status', { status: 'running' });

  // Execute processing asynchronously without blocking
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
      emitJobEvent(job, 'status', { status: 'failed', error: job.error });
      closeJobSubscribers(jobId);
    } finally {
      activeJobCount--;
      processNextInQueue(); // open slot — process next queued job
    }
  });
}

/**
 * Default executor: runs mock or llm provider pipeline with chunking.
 * @param {object} job
 */
export async function defaultExecuteJob(job) {
  const { diff, options, usage } = job;

  // Chunk diff if larger than 64 KiB (65536 bytes)
  const chunks = chunkDiff(diff);
  usage.chunks = chunks.length;

  const allFindingsMap = new Map();

  if (options.provider === 'mock') {
    // Process each chunk through mock provider, collecting all findings
    for (const chunk of chunks) {
      const parsedFiles = parseDiff(chunk);
      // Use very large cap to collect everything; truncation happens after merge
      const { findings } = analyzeWithMock(parsedFiles, Number.MAX_SAFE_INTEGER);
      for (const finding of findings) {
        if (!allFindingsMap.has(finding.id)) {
          allFindingsMap.set(finding.id, finding);
        }
      }
    }

    // Sort merged findings: path (lex) → line (asc) → ruleId
    const sortedFindings = Array.from(allFindingsMap.values()).sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      if (a.line < b.line) return -1;
      if (a.line > b.line) return 1;
      if (a.ruleId < b.ruleId) return -1;
      if (a.ruleId > b.ruleId) return 1;
      return 0;
    });

    // Apply maxFindings truncation to ordered list
    const finalFindings = sortedFindings.slice(0, options.maxFindings);
    job.findings = finalFindings;

    // Emit each finding as a live SSE event (also records to job.events via emitJobEvent)
    for (const finding of finalFindings) {
      emitJobEvent(job, 'finding', finding);
    }

  } else if (options.provider === 'llm') {
    // LLM provider — wired in Subtask 12. Graceful failure if not yet configured.
    const { analyzeWithLLM } = await import('./llmProvider.js').catch(() => ({ analyzeWithLLM: null }));
    if (!analyzeWithLLM) {
      throw new Error('LLM provider module is unavailable.');
    }
    const parsedFiles = parseDiff(diff);
    const llmFindings = await analyzeWithLLM(parsedFiles, options.maxFindings);
    job.findings = llmFindings;
    for (const finding of llmFindings) {
      emitJobEvent(job, 'finding', finding);
    }
  }

  // Complete job — emit final status and done events, then close live subscribers
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

  emitJobEvent(job, 'status', { status: 'done' });
  emitJobEvent(job, 'done', doneEventData);
  closeJobSubscribers(job.jobId);
}
