/**
 * Chunker for Large Diffs
 *
 * Splits unified diffs over 64 KiB (65,536 bytes) into chunks of at most 64 KiB,
 * splitting only on file boundaries.
 */

const MAX_CHUNK_BYTES = 65536; // 64 KiB

/**
 * Splits a unified diff into file-level blocks.
 * @param {string} diffString
 * @returns {Array<string>} Array of raw file diff strings
 */
export function splitDiffByFiles(diffString) {
  if (!diffString || typeof diffString !== 'string') {
    return [];
  }

  const lines = diffString.split(/\r?\n/);
  const fileBlocks = [];
  let currentBlockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for start of a new file diff
    const isGitDiffHeader = line.startsWith('diff --git ');
    const isFileHeader = line.startsWith('--- ') && (i === 0 || lines[i - 1].startsWith('diff --git ') === false);

    if ((isGitDiffHeader || isFileHeader) && currentBlockLines.length > 0) {
      fileBlocks.push(currentBlockLines.join('\n'));
      currentBlockLines = [];
    }

    currentBlockLines.push(line);
  }

  if (currentBlockLines.length > 0) {
    fileBlocks.push(currentBlockLines.join('\n'));
  }

  return fileBlocks;
}

/**
 * Chunks a unified diff string into pieces of at most 64 KiB each, strictly on file boundaries.
 * @param {string} diffString
 * @returns {Array<string>} Array of diff chunk strings
 */
export function chunkDiff(diffString) {
  const totalBytes = Buffer.byteLength(diffString, 'utf8');

  // If diff is <= 64 KiB, return as a single chunk
  if (totalBytes <= MAX_CHUNK_BYTES) {
    return [diffString];
  }

  const fileBlocks = splitDiffByFiles(diffString);
  const chunks = [];
  let currentChunkBlocks = [];
  let currentChunkBytes = 0;

  for (const block of fileBlocks) {
    const blockBytes = Buffer.byteLength(block, 'utf8');

    // If adding this file block exceeds 64 KiB, push the current chunk (if non-empty)
    if (currentChunkBytes + blockBytes > MAX_CHUNK_BYTES && currentChunkBlocks.length > 0) {
      chunks.push(currentChunkBlocks.join('\n'));
      currentChunkBlocks = [];
      currentChunkBytes = 0;
    }

    // Add block to current chunk
    currentChunkBlocks.push(block);
    currentChunkBytes += blockBytes + 1; // +1 for newline join
  }

  if (currentChunkBlocks.length > 0) {
    chunks.push(currentChunkBlocks.join('\n'));
  }

  return chunks;
}
