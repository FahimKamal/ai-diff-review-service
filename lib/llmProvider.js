/**
 * LLM Provider (Google Gemini API Integration)
 *
 * Provides real LLM code review analysis behind the same pipeline.
 * Credentials live on the server via GEMINI_API_KEY environment variable.
 * Must fail gracefully if API key is missing or model is unreachable (status: "failed"), NEVER crash.
 */

/**
 * Analyzes parsed diff files using Google Gemini API.
 * @param {Array<{ path: string, addedLines: Array<{ line: number, content: string }> }>} parsedFiles
 * @param {number} maxFindings
 * @returns {Promise<Array<object>>} Findings array
 */
export async function analyzeWithLLM(parsedFiles, maxFindings = 100) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY environment variable is not configured on the server.');
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

  const prompt = `You are an expert AI code reviewer. Analyze the following added lines from a code diff for bugs, security issues, performance problems, and style issues.

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

Do NOT include any markdown code blocks, explanation text, or preambles. Output raw JSON only. Limit findings to at most ${maxFindings}.

Code Diff to review:
${diffSummary}`;

  // Call Gemini REST API (v1beta) using native fetch
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
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
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Clean rawText from potential markdown fences (```json ... ```)
  const cleanJsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let rawFindings = [];
  try {
    rawFindings = JSON.parse(cleanJsonText);
  } catch {
    // If LLM returned non-JSON, return a fallback single finding or empty array
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
