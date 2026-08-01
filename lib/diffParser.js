/**
 * Unified Diff Parser
 * Parses unified git diffs, tracking file paths and exact new-file line numbers for added (+) lines.
 */

/**
 * Validates whether a string looks like a parseable unified diff.
 * @param {string} diffString
 * @returns {boolean}
 */
export function isValidDiff(diffString) {
  if (!diffString || typeof diffString !== 'string' || !diffString.trim()) {
    return false;
  }

  // A valid unified diff should have hunk header @@ ... @@ or file header (--- / +++)
  const hasHunkHeader = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(diffString);
  const hasFileHeader = /^--- (?:a\/|\S+)/m.test(diffString) || /^\+\+\+ (?:b\/|\S+)/m.test(diffString);
  const hasGitHeader = /^diff --git /m.test(diffString);

  return hasHunkHeader || hasFileHeader || hasGitHeader;
}

/**
 * Parses unified diff into structured file objects containing added lines and line numbers.
 * @param {string} diffString
 * @returns {Array<{ path: string, addedLines: Array<{ line: number, content: string }> }>}
 */
export function parseDiff(diffString) {
  if (!isValidDiff(diffString)) {
    return [];
  }

  const lines = diffString.split(/\r?\n/);
  const files = [];
  let currentFile = null;
  let currentNewLineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header check: +++ b/filepath or +++ filepath
    if (line.startsWith('+++ ')) {
      let rawPath = line.substring(4).trim();
      // Remove leading b/ if present
      if (rawPath.startsWith('b/')) {
        rawPath = rawPath.substring(2);
      }
      // Ignore /dev/null
      if (rawPath !== '/dev/null') {
        currentFile = {
          path: rawPath,
          addedLines: []
        };
        files.push(currentFile);
      } else {
        currentFile = null;
      }
      continue;
    }

    // Ignore --- lines or diff --git lines
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      continue;
    }

    // Hunk header check: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Process lines inside a hunk if we have an active file and line number
    if (currentFile && currentNewLineNum > 0) {
      if (line.startsWith('+')) {
        // Exclude +++ headers (handled above)
        if (!line.startsWith('+++')) {
          const content = line.substring(1); // line content without leading '+'
          currentFile.addedLines.push({
            line: currentNewLineNum,
            content
          });
          currentNewLineNum++;
        }
      } else if (line.startsWith('-')) {
        // Deleted line — affects old file, does NOT affect new file line number
        // Do nothing to currentNewLineNum
      } else if (line.startsWith(' ') || line === '') {
        // Context line — affects new file line number
        currentNewLineNum++;
      }
    }
  }

  return files;
}
