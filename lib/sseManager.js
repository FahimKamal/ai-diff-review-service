/**
 * SSE Manager
 *
 * Manages Server-Sent Events streaming for review jobs.
 * - For in-progress jobs: live events are pushed as they happen.
 * - For completed jobs: ALL recorded events are replayed identically, then connection closes.
 *
 * SSE format per spec:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 */

// Map: jobId -> Set of active response objects (live subscribers)
const subscribers = new Map();

/**
 * Formats a single SSE event string.
 * @param {string} event - event name (status | finding | done)
 * @param {object} data  - JSON-serializable data
 * @returns {string}
 */
function formatSSEEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Sends all currently recorded events for a job to a response, then closes the stream.
 * Used for replay on already-finished jobs.
 * @param {object} res - Express response
 * @param {Array<{event: string, data: object}>} events
 */
function replayEvents(res, events) {
  for (const ev of events) {
    res.write(formatSSEEvent(ev.event, ev.data));
  }
  res.end();
}

/**
 * Attaches an SSE client to a job stream.
 * If the job is already done/failed, replay events immediately.
 * Otherwise, subscribe for live events.
 *
 * @param {string} jobId
 * @param {object} job - Job object from jobManager
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export function attachSSEClient(jobId, job, req, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering if behind proxy
  res.flushHeaders();

  // If job is already done or failed — replay all recorded events and close
  if (job.status === 'done' || job.status === 'failed') {
    replayEvents(res, job.events);
    return;
  }

  // Job is still in progress — stream live events
  // First, replay all events recorded so far (e.g. queued/running status transitions already emitted)
  for (const ev of job.events) {
    res.write(formatSSEEvent(ev.event, ev.data));
  }

  // Register as a live subscriber
  if (!subscribers.has(jobId)) {
    subscribers.set(jobId, new Set());
  }
  subscribers.get(jobId).add(res);

  // Clean up if client disconnects early
  req.on('close', () => {
    const subs = subscribers.get(jobId);
    if (subs) {
      subs.delete(res);
      if (subs.size === 0) {
        subscribers.delete(jobId);
      }
    }
  });
}

/**
 * Pushes a new event to all live subscribers of a job AND records it to the job's event log.
 * @param {object} job - Job object (will mutate job.events)
 * @param {string} event - event name
 * @param {object} data  - event data
 */
export function emitJobEvent(job, event, data) {
  // Record event in the job's event history for future replay
  job.events.push({ event, data });

  // Push to all live subscribers
  const subs = subscribers.get(job.jobId);
  if (subs && subs.size > 0) {
    const chunk = formatSSEEvent(event, data);
    for (const res of subs) {
      try {
        res.write(chunk);
      } catch {
        // Client disconnected
        subs.delete(res);
      }
    }
  }
}

/**
 * Closes and removes all live subscribers for a job (call when job completes/fails).
 * @param {string} jobId
 */
export function closeJobSubscribers(jobId) {
  const subs = subscribers.get(jobId);
  if (subs) {
    for (const res of subs) {
      try {
        res.end();
      } catch {
        // Already closed
      }
    }
    subscribers.delete(jobId);
  }
}
