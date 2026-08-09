# AI Diff Review Service

An asynchronous HTTP service that analyzes unified code diffs and returns structured review findings using a deterministic mock rule engine or Google Gemini LLM API.

---

## Features

- ⚡ **Asynchronous Job Pipeline**: Accepts diffs instantly (`202 Accepted`), processing jobs concurrently (up to 4 jobs).
- 🛡️ **Mock Provider**: Fully deterministic rule engine implementing 9 scoring rules with exact path, line, severity, and evidence matching.
- 🤖 **LLM Provider**: Real AI code review path via Google Gemini API with graceful fallback on model errors.
- 📡 **Server-Sent Events (SSE)**: Real-time event streaming (`status`, `finding`, `done`) with full event replay on finished jobs.
- 💾 **Caching & Idempotency**: SHA-256 payload caching (`cacheHit: true`) and strict `Idempotency-Key` conflict checks (`409 Conflict`).
- 🧩 **Smart Chunking**: Automatically splits diffs $> 64\text{ KiB}$ on file boundaries into $\le 64\text{ KiB}$ chunks.
- 🔒 **Bearer Token Auth**: All `/v1/*` routes protected by Bearer token authentication.
- ⏱️ **Rate Limiting**: Sliding-window 30 req/min rate limit on `POST /v1/reviews` with `Retry-After` header.

---

## Quick Start (Local Setup)

### 1. Requirements
- **Node.js**: v18+ (v22 recommended)
- **npm**: v9+

### 2. Installation
```bash
# Install dependencies
npm install
```

### 3. Environment Variables
Create a `.env` file from `.env.example`:
```bash
cp .env.example .env
```

Configure your environment variables:
```env
PORT=3000
BEARER_TOKEN=my-secret-token-12345
GEMINI_API_KEY=your_google_gemini_api_key_here
```

### 4. Running the Service
```bash
# Start in production mode
npm start

# Start in development mode (with auto-reload)
npm run dev
```

The service will start on `http://localhost:3000`.

---

## Running Automated Verification Tests

The project includes an automated test script (`test.sh`) that verifies all API contracts, error taxonomies, mock rules, idempotency, caching, SSE replay, and authentication:

```bash
npm test
```

---

## API Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | Public | Returns service health status and uptime in seconds. |
| `GET` | `/spec` | Public | Returns machine-readable system limits declaration. |
| `POST` | `/v1/reviews` | Bearer | Submit unified diff for async review (`202 Accepted`). |
| `GET` | `/v1/reviews/:jobId` | Bearer | Poll review job status, usage, and findings. |
| `GET` | `/v1/reviews/:jobId/stream` | Bearer | Stream job progress and findings via SSE. |

### Example Request

```bash
curl -X POST http://localhost:3000/v1/reviews \
  -H "Authorization: Bearer my-secret-token-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "diff": "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1,1 +1,2 @@\n old line\n+const result = eval(input);",
    "options": {
      "provider": "mock",
      "maxFindings": 100
    }
  }'
```

---

## 💡 Semantic Review Showcase: LLM vs. Mock Engine

While the `mock` provider checks for explicit string patterns (e.g. `eval()`, hardcoded keys), the `llm` provider understands **code logic and semantics**, catching complex bugs that traditional regex engines miss.

### Sample Code Diff

```diff
diff --git a/src/authService.js b/src/authService.js
--- a/src/authService.js
+++ b/src/authService.js
@@ -10,6 +10,8 @@ async function authenticateUser(username, password) {
+  // Insecure reset token generation
+  const resetToken = Math.floor(Math.random() * 1000000).toString();
+  saveToken(user.id, resetToken);

diff --git a/src/userManager.js b/src/userManager.js
--- a/src/userManager.js
+++ b/src/userManager.js
@@ -25,6 +25,8 @@ async function notifyActiveUsers(users) {
+  // Off-by-one array index error
+  for (let i = 0; i <= users.length; i++) {
+    sendEmail(users[i].email);
+  }
```

### Analysis Comparison

| Provider | Findings Count | Findings Detected |
|----------|----------------|-------------------|
| **`mock`** | `0` | None (No matching string pattern like `eval` or `console.log`) |
| **`llm`** | `2` | 1. `[Critical/Security]` Insecure random number generation for security tokens<br>2. `[High/Correctness]` Off-by-one error in loop condition (`i <= users.length`) |

---

## Deployment (Railway / Render / Cloudflared)

### Railway Deployment (Recommended)
1. Push this repository to GitHub.
2. Sign in to [Railway.com](https://railway.com) using GitHub.
3. Click **New Project** $\rightarrow$ **Deploy from GitHub repo** and select this repository.
4. Go to **Variables** tab and set:
   - `BEARER_TOKEN`: your chosen token
   - `GEMINI_API_KEY`: (optional) your Gemini API key
   - `PORT`: `3000`
5. Go to **Settings** $\rightarrow$ **Networking** $\rightarrow$ Click **Generate Domain**.
6. Your live public API URL will be `https://<your-app-name>.up.railway.app`.

---

## File Structure

```
├── server.js              # Express app setup, routing, error handling
├── lib/
│   ├── auth.js            # Bearer token auth middleware
│   ├── diffParser.js      # Unified diff parser and validator
│   ├── mockProvider.js    # 9 deterministic mock rules engine
│   ├── llmProvider.js     # Google Gemini API integration
│   ├── jobManager.js      # Queue, lifecycle, concurrency control
│   ├── chunker.js         # File-boundary diff chunker (>64 KiB)
│   ├── cache.js           # SHA-256 payload caching & idempotency
│   ├── rateLimiter.js     # Sliding window rate limiter (30 req/min)
│   └── sseManager.js      # SSE event streaming and replay manager
├── test.sh                # Integration test suite
├── SUBMISSION.md          # Submission architecture walkthrough
└── README.md              # Project documentation
```
