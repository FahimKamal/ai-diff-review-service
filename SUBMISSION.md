# SUBMISSION.md — AI Diff Review Service

## Submission Overview

- **Service Base URL**: `https://<your-railway-app-name>.up.railway.app` *(or custom URL)*
- **Bearer Token**: `<configured-bearer-token>`
- **Repository URL**: `https://github.com/<username>/ai-diff-review-service`

---

## 1. Architecture Summary (~10 lines)

The service is built on Node.js and Express using an asynchronous, event-driven worker architecture:
- **API Server & Routing**: Express application with strict middleware validation for payload limits (1 MiB), JSON syntax (400), diff format (422), and Bearer authentication (401).
- **Concurrency & Job Management**: In-memory job queue (`lib/jobManager.js`) maintaining an active job count capped at `maxConcurrentJobs: 4`. Queued jobs wait asynchronously without failing.
- **Provider Abstraction**: Unified review pipeline supporting `mock` (deterministic regex/AST rules) and `llm` (Google Gemini 1.5/2.5 Flash API) providers.
- **Event Streaming & Replay**: Server-Sent Events manager (`lib/sseManager.js`) emitting real-time status transitions and findings during execution, and replaying full event logs for completed job streams.
- **Caching & Idempotency**: SHA-256 payload hashing for result caching (`cacheHit: true`) and per-key state mapping for `Idempotency-Key` headers (returning `409 Conflict` on payload mismatches).

---

## 2. Provider Design

The service decouples the API lifecycle (queueing, status polling, streaming, caching, chunking) from the underlying analysis engine via a clean Provider interface:

1. **`mock` Provider (`lib/mockProvider.js`)**:
   - Implements 9 deterministic rules scanning added lines (`+` lines) only.
   - Accurately tracks new-file line numbers derived from unified diff hunk headers (`@@ -a,b +c,d @@`).
   - Supports multi-line analysis (e.g. `MOCK-004` empty catch block detection across lines, reporting the `catch` line).
   - Handles prompt injection (`MOCK-INJ`) as inert text: reported as a critical finding without altering pipeline execution or remaining rules.
   - Enforces deterministic ordering: `path` (lexicographic) $\rightarrow$ `line` (ascending) $\rightarrow$ `ruleId`, deduplicating by composite ID `ruleId:path:line`.

2. **`llm` Provider (`lib/llmProvider.js`)**:
   - Integrates Google Gemini API using environment variable `GEMINI_API_KEY`.
   - Passes parsed added lines to Gemini with structured output instructions.
   - **Graceful Failure**: If `GEMINI_API_KEY` is missing or the external API is unreachable, the job transitions to `status: "failed"` with a clear error payload. The service never crashes under LLM failures.

---

## 3. How Cross-Cutting Behaviors Were Verified

All cross-cutting behaviors were verified using an automated bash test suite (`test.sh`):

- **Chunking (`lib/chunker.js`)**:
  - Diffs $> 64\text{ KiB}$ are split strictly on file boundaries (`diff --git` / `--- a/` headers) into $\le 64\text{ KiB}$ chunks. Single files exceeding 64 KiB become individual chunks.
  - Results across chunks are merged, deduplicated, and sorted identically to an unchunked scan.
- **Caching (`lib/cache.js`)**:
  - SHA-256 canonical payload hashing (`{diff, options}`) guarantees that byte-identical resubmissions bypass re-execution and return `"cacheHit": true`.
- **Idempotency**:
  - Verified that repeating a request with the same `Idempotency-Key` and byte-identical body returns the original `jobId`.
  - Verified that reusing the key with a modified body returns HTTP `409 Conflict` (`idempotency_conflict`).
- **SSE Replay (`lib/sseManager.js`)**:
  - Verified live streaming of `status`, `finding`, and `done` events for active jobs.
  - Verified that connecting to `/v1/reviews/{jobId}/stream` for an already finished job replays all recorded events in exact sequence.
- **Rate Limiting (`lib/rateLimiter.js`)**:
  - Verified sliding-window rate limit (30 POSTs/minute). Exceeding requests return HTTP `429` with `Retry-After` header and `rate_limited` code without 5xx errors.

---

## 4. AI Tools Used

- **Google Antigravity Agentic AI**: Used for architectural design, code generation, refactoring, and integration test suite creation.
- **Claude Sonnet 4.6 (Thinking)**: Used for designing complex multi-line rule parsing (empty catch blocks) and SSE event replay synchronization.
- **Gemini 3.6 Flash**: Used for fast iteration on boilerplate Express routes, validation middleware, and unit test logic.

---

## 5. AI Suggestion Rejected & Why

**Rejected Suggestion**: An initial AI proposal suggested using `JSON.stringify(req.body)` directly as the key for idempotency checks.

**Why Rejected**:
In JavaScript/Express, `JSON.stringify(req.body)` does not preserve key order across different client implementations (e.g. `{"diff": "...", "options": {}}` vs `{"options": {}, "diff": "..."}`). Additionally, re-serializing an already parsed JSON object loses subtle whitespace differences in the raw request payload. 

**Our Solution**: Instead, we captured the exact, raw unparsed byte buffer (`req.rawBody`) via `express.json({ verify: ... })` and hashed the actual incoming bytes using SHA-256. This ensures 100% byte-accurate idempotency and payload caching matching the specification.

---

## 6. What I'd Do Next with More Time

1. **Persistent Storage (Redis / SQLite)**: Replace in-memory stores with Redis/SQLite so job state, payload cache, and idempotency mappings survive server restarts and scale horizontally.
2. **Worker Pool (BullMQ / Celery)**: Separate the HTTP API server from worker processes to process diff chunks across multiple background worker threads.
3. **Advanced AST Parsing**: Replace regex-based diff matching with AST parsers (e.g., Babel for JS/TS, tree-sitter for multi-language) to eliminate false positives in string comments.
4. **Prometheus Metrics**: Expose `/metrics` endpoint tracking active job queue depth, chunk processing latency, cache hit ratio, and LLM error rates.
