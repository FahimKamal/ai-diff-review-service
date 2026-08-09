/**
 * LLM Provider Integration
 *
 * Supports both:
 * 1. Local LLM via LM Studio (or any OpenAI-compatible server at http://127.0.0.1:1234/v1/chat/completions)
 * 2. Google Gemini API via GEMINI_API_KEY
 *
 * Credentials and local configuration live on the server via environment variables.
 * Must fail gracefully if unreachable (status: "failed"), NEVER crash.
 */

/**
 * Analyzes parsed diff files using either LM Studio (Local LLM) or Google Gemini API.
 * @param {Array<{ path: string, addedLines: Array<{ line: number, content: string }> }>} parsedFiles
 * @param {number} maxFindings
 * @returns {Promise<Array<object>>} Findings array
 */
export async function analyzeWithLLM(parsedFiles, maxFindings = 100) {
  const localUrl = process.env.LOCAL_LLM_URL || process.env.LM_STUDIO_URL;
  const apiKey = process.env.GEMINI_API_KEY;

  // Check if LM Studio / Local LLM mode is explicitly requested or configured
  const isLocalMode = process.env.LLM_PROVIDER === 'lmstudio' || Boolean(localUrl);

  if (!isLocalMode && (!apiKey || !apiKey.trim())) {
    throw new Error('No LLM configuration found. Set GEMINI_API_KEY or LOCAL_LLM_URL (e.g., http://127.0.0.1:1234/v1/chat/completions for LM Studio).');
  }

  // Format diff for LLM prompt
  let diffSummary = '';
  for (const file of parsedFiles) {
    diffSummary += `File: ${file.path}\n`;
    for (const added of file.addedLines) {
      diffSummary += `Line ${added.line}: ${added.content}\n`;
    }
    diffSummary += '\n';
  }

  if (!diffSummary.trim()) {
    return [];
  }

  const systemPrompt = `You are an expert AI code reviewer. Analyze the added lines from the code diff for bugs, security issues, performance problems, and style issues.
Return ONLY a valid JSON array of finding objects, matching this exact structure:
[
  {
    "id": "LLM-001:path/file.ext:41",
    "ruleId": "LLM-REVIEW",
    "path": "path/file.ext",
    "line": 41,
    "severity": "critical" | "high" | "medium" | "low",
    "category": "security" | "correctness" | "performance" | "style",
    "title": "short title description",
    "evidence": "exact added line text"
  }
]
Do NOT include markdown code fences (\`\`\`json), explanations, or intro text. Output raw JSON array only.`;

  const userPrompt = `Code Diff to review:\n${diffSummary}\n\nLimit findings to at most ${maxFindings}.`;

  let rawText = '';

  if (isLocalMode) {
    // -----------------------------------------------------------------------
    // LM Studio / OpenAI-Compatible Local Endpoint Path
    // -----------------------------------------------------------------------
    let targetUrl = localUrl || 'http://127.0.0.1:1234/v1/chat/completions';
    if (!targetUrl.endsWith('/chat/completions')) {
      targetUrl = targetUrl.replace(/\/+$/, '');
      if (!targetUrl.endsWith('/v1')) {
        targetUrl += '/v1';
      }
      targetUrl += '/chat/completions';
    }
    const modelName = process.env.LOCAL_LLM_MODEL || 'local-model';

    let response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 2048
        })
      });
    } catch (netErr) {
      throw new Error(`Failed to reach LM Studio local LLM at ${targetUrl}: ${netErr.message}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LM Studio returned HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    rawText = data.choices?.[0]?.message?.content || '';
  } else {
    // -----------------------------------------------------------------------
    // Google Gemini API Path
    // -----------------------------------------------------------------------
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048
          }
        })
      });
    } catch (netErr) {
      throw new Error(`Failed to reach Gemini LLM API: ${netErr.message}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini LLM API returned HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Clean rawText from potential markdown fences (```json ... ```)
  const cleanJsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let rawFindings = [];
  try {
    rawFindings = JSON.parse(cleanJsonText);
  } catch {
    return [];
  }

  if (!Array.isArray(rawFindings)) {
    return [];
  }

  // Sanitize and format findings
  const sanitized = rawFindings.map((item, idx) => ({
    id: item.id || `LLM-${String(idx + 1).padStart(3, '0')}:${item.path || 'unknown'}:${item.line || 1}`,
    ruleId: item.ruleId || 'LLM-REVIEW',
    path: item.path || 'unknown',
    line: typeof item.line === 'number' ? item.line : 1,
    severity: ['critical', 'high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium',
    category: ['security', 'correctness', 'performance', 'style'].includes(item.category) ? item.category : 'correctness',
    title: item.title || 'LLM Code Review finding',
    evidence: item.evidence || ''
  }));

  // Sort per specification: path (lex) -> line (asc) -> ruleId
  sanitized.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.line < b.line) return -1;
    if (a.line > b.line) return 1;
    if (a.ruleId < b.ruleId) return -1;
    if (a.ruleId > b.ruleId) return 1;
    return 0;
  });

  return sanitized.slice(0, maxFindings);
}
