// Lossless text segmentation for free-model review. Bound each request, not the complete intake.
export const DEFAULT_SOURCE_CHUNK_CHARS = 20_000;

export function splitTextIntoChunks(value, maxChars = DEFAULT_SOURCE_CHUNK_CHARS) {
  const source = String(value ?? '');
  if (!source.length) return [];
  const limit = Math.max(2, Math.floor(Number(maxChars) || DEFAULT_SOURCE_CHUNK_CHARS));
  const chunks = [];
  let start = 0;

  while (start < source.length) {
    let end = Math.min(source.length, start + limit);
    if (end < source.length) {
      const minimumBoundary = start + Math.floor(limit * 0.6);
      const newline = source.lastIndexOf('\n', end - 1);
      const space = source.lastIndexOf(' ', end - 1);
      const boundary = Math.max(newline >= minimumBoundary ? newline + 1 : 0, space >= minimumBoundary ? space + 1 : 0);
      if (boundary > start) end = boundary;

      // Avoid splitting a UTF-16 surrogate pair at a hard boundary.
      const lastUnit = source.charCodeAt(end - 1);
      if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF && end < source.length) end -= 1;
    }
    if (end <= start) end = Math.min(source.length, start + limit);
    chunks.push(source.slice(start, end));
    start = end;
  }

  return chunks;
}

export function buildReviewSegments(input, files = {}, maxChars = DEFAULT_SOURCE_CHUNK_CHARS) {
  const sources = [];
  if (String(input ?? '').length) sources.push({ type: 'request', path: 'Project request', content: String(input) });
  for (const [path, content] of Object.entries(files || {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof content === 'string' && content.length) sources.push({ type: 'file', path, content });
  }

  const segments = [];
  for (const source of sources) {
    const parts = splitTextIntoChunks(source.content, maxChars);
    parts.forEach((content, index) => segments.push({
      type: source.type,
      path: source.path,
      part: index + 1,
      parts: parts.length,
      content,
    }));
  }
  return segments;
}
