/**
 * Mock Provider Rule Engine
 *
 * Applies 9 deterministic rules to added lines in parsed diff files.
 * Rules apply ONLY to added lines (+), not context or deleted lines.
 * Finding ordering: by path (lexicographic), then line (ascending), then ruleId.
 * Deduplication is by finding id = "<ruleId>:<path>:<line>".
 * maxFindings truncates the ordered list; usage still reflects the full scan.
 *
 * MOCK-INJ content is detected and reported as a finding but NEVER alters behavior.
 */

// Rule definitions: ordered for readability, sorting happens afterward
const RULES = [
  {
    ruleId: 'MOCK-001',
    severity: 'critical',
    category: 'security',
    title: 'eval usage',
    /**
     * Trigger: added line contains `eval(`
     */
    match(line) {
      return line.includes('eval(');
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-002',
    severity: 'critical',
    category: 'security',
    title: 'hardcoded credential',
    /**
     * Trigger: matches /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i
     */
    match(line) {
      const pattern = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
      return pattern.test(line);
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-003',
    severity: 'high',
    category: 'security',
    title: 'SQL string concatenation',
    /**
     * Trigger: SQL keyword (SELECT, INSERT, UPDATE, DELETE) inside a string
     * concatenated with +
     *
     * Strategy: check that line contains a SQL keyword inside quotes AND a + operator.
     * We look for patterns like: "... SELECT ..." + or + "... INSERT ..." etc.
     */
    match(line) {
      const sqlKeywords = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
      if (!sqlKeywords.test(line)) return false;
      // Must also be string concatenation — check for + operator alongside a string literal
      // Pattern: string literal followed by + or + followed by string literal, with SQL keyword present
      const concatWithString = /(['"`].*\b(SELECT|INSERT|UPDATE|DELETE)\b.*['"`]\s*\+)|(\+\s*['"`].*\b(SELECT|INSERT|UPDATE|DELETE)\b.*['"`])/i;
      return concatWithString.test(line);
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-004',
    severity: 'high',
    category: 'correctness',
    title: 'swallowed exception',
    /**
     * Trigger: empty catch block (may span lines; report the catch line)
     * Multi-line: needs to look ahead at subsequent added lines to see if catch body is empty.
     * A catch block is "empty" if the { ... } has no meaningful statements.
     */
    match: null, // handled separately via multiLine logic
    multiLine: true
  },
  {
    ruleId: 'MOCK-005',
    severity: 'medium',
    category: 'correctness',
    title: 'loose null comparison',
    /**
     * Trigger: contains `== null` or `!= null`
     */
    match(line) {
      return line.includes('== null') || line.includes('!= null');
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-006',
    severity: 'medium',
    category: 'performance',
    title: 'deep-clone via JSON',
    /**
     * Trigger: contains `JSON.parse(JSON.stringify(`
     */
    match(line) {
      return line.includes('JSON.parse(JSON.stringify(');
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-007',
    severity: 'low',
    category: 'style',
    title: 'console.log left in',
    /**
     * Trigger: contains `console.log(`
     */
    match(line) {
      return line.includes('console.log(');
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-008',
    severity: 'low',
    category: 'style',
    title: 'unresolved marker',
    /**
     * Trigger: contains `TODO` or `FIXME`
     */
    match(line) {
      return line.includes('TODO') || line.includes('FIXME');
    },
    multiLine: false
  },
  {
    ruleId: 'MOCK-INJ',
    severity: 'critical',
    category: 'security',
    title: 'prompt-injection content',
    /**
     * Trigger: contains (case-insensitive):
     *   - "ignore previous instructions"
     *   - "disregard all prior"
     *   - "you are now"
     *
     * IMPORTANT: detected and reported as finding, but NEVER alters behavior of other rules.
     */
    match(line) {
      const lower = line.toLowerCase();
      return (
        lower.includes('ignore previous instructions') ||
        lower.includes('disregard all prior') ||
        lower.includes('you are now')
      );
    },
    multiLine: false
  }
];

/**
 * Builds a finding object.
 * @param {string} ruleId
 * @param {string} path
 * @param {number} line
 * @param {string} evidence - verbatim added line content
 * @param {object} rule - rule metadata
 * @returns {object} Finding
 */
function makeFinding(ruleId, path, line, evidence, rule) {
  return {
    id: `${ruleId}:${path}:${line}`,
    ruleId,
    path,
    line,
    severity: rule.severity,
    category: rule.category,
    title: rule.title,
    evidence
  };
}

/**
 * Comparator for sorting findings by path (lexicographic), then line (ascending), then ruleId.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function findingComparator(a, b) {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  if (a.line < b.line) return -1;
  if (a.line > b.line) return 1;
  if (a.ruleId < b.ruleId) return -1;
  if (a.ruleId > b.ruleId) return 1;
  return 0;
}

/**
 * Detects empty catch blocks across added lines for a single file.
 * Reports a finding on the line containing `catch`.
 *
 * Strategy:
 * We look through the full diff content (both added and context lines, but
 * only report the catch line if the catch itself appears on an added line).
 * We rebuild a representation of all lines visible in the diff for multi-line
 * look-ahead.
 *
 * @param {Array<{ line: number, content: string }>} addedLines
 * @param {string} path
 * @returns {Array<object>} findings for MOCK-004
 */
function detectEmptyCatch(addedLines, path) {
  const findings = [];
  const addedSet = new Map(addedLines.map(l => [l.line, l.content]));

  // We need to look at the full set of added lines and scan for catch patterns
  // We'll iterate added lines looking for ones containing `catch`
  for (let i = 0; i < addedLines.length; i++) {
    const { line, content } = addedLines[i];

    // Check if this line has a catch keyword
    // Match: catch block opener — `catch` possibly followed by (error) and {
    const catchMatch = /\bcatch\b/.test(content);
    if (!catchMatch) continue;

    // Now we need to determine if the catch block body is empty.
    // We look at subsequent added lines (or even the current line) to find the { and }
    // Build a window of lines to parse for brace matching
    const catchLineContent = content;

    // Find the opening brace — could be on same line or later added lines
    let combinedText = catchLineContent;
    let lookaheadIndex = i + 1;
    // Look ahead up to 10 added lines to get the full catch block
    while (lookaheadIndex < addedLines.length && lookaheadIndex <= i + 10) {
      combinedText += '\n' + addedLines[lookaheadIndex].content;
      lookaheadIndex++;
    }

    // Find the opening brace after `catch`
    const catchPos = combinedText.search(/\bcatch\b/);
    if (catchPos === -1) continue;

    const afterCatch = combinedText.substring(catchPos + 5); // 'catch'.length = 5

    // Skip optional (error) parameter
    const parenSkip = afterCatch.match(/^\s*(\([^)]*\))?\s*\{/);
    if (!parenSkip) continue;

    // Find the opening brace
    const openBraceIndex = afterCatch.indexOf('{');
    if (openBraceIndex === -1) continue;

    const afterOpenBrace = afterCatch.substring(openBraceIndex + 1);

    // Find the closing brace — skip whitespace/comments to check if body is empty
    // We count nested braces for correctness
    let braceDepth = 1;
    let bodyContent = '';
    let closedEmpty = false;

    for (let ci = 0; ci < afterOpenBrace.length; ci++) {
      const ch = afterOpenBrace[ci];
      if (ch === '{') {
        braceDepth++;
        bodyContent += ch;
      } else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          // Check if body is effectively empty (only whitespace/comments)
          const stripped = bodyContent
            .replace(/\/\/[^\n]*/g, '') // remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // remove block comments
            .trim();
          if (stripped === '') {
            closedEmpty = true;
          }
          break;
        } else {
          bodyContent += ch;
        }
      } else {
        bodyContent += ch;
      }
    }

    if (closedEmpty) {
      findings.push(makeFinding('MOCK-004', path, line, content, {
        severity: 'high',
        category: 'correctness',
        title: 'swallowed exception'
      }));
    }
  }

  return findings;
}

/**
 * Applies all mock rules to parsed diff files and returns sorted, deduplicated findings.
 *
 * @param {Array<{ path: string, addedLines: Array<{ line: number, content: string }> }>} parsedFiles
 * @param {number} maxFindings - truncation limit (default 100)
 * @returns {{ findings: Array<object>, totalFound: number }}
 */
export function analyzeWithMock(parsedFiles, maxFindings = 100) {
  const findingsMap = new Map(); // id -> finding (for deduplication)

  for (const file of parsedFiles) {
    const { path, addedLines } = file;

    // Apply single-line rules
    for (const addedLine of addedLines) {
      const { line, content } = addedLine;

      for (const rule of RULES) {
        if (rule.multiLine) continue; // handled separately
        if (rule.match(content)) {
          const finding = makeFinding(rule.ruleId, path, line, content, rule);
          if (!findingsMap.has(finding.id)) {
            findingsMap.set(finding.id, finding);
          }
        }
      }
    }

    // Apply multi-line rules (MOCK-004 empty catch)
    const catchFindings = detectEmptyCatch(addedLines, path);
    for (const finding of catchFindings) {
      if (!findingsMap.has(finding.id)) {
        findingsMap.set(finding.id, finding);
      }
    }
  }

  // Sort all findings: path (lex) → line (asc) → ruleId
  const allFindings = Array.from(findingsMap.values()).sort(findingComparator);
  const totalFound = allFindings.length;

  // Apply maxFindings truncation to the ordered list
  const findings = allFindings.slice(0, maxFindings);

  return { findings, totalFound };
}
