export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`).
 * Returns null to serve the whole file (no header, multiple ranges or an
 * unknown unit) and 'unsatisfiable' for ranges outside the file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;

  let start: number;
  let end: number;
  if (first === '') {
    // Suffix range: the last n bytes
    const length = Number(last);
    if (length === 0) return 'unsatisfiable';
    start = Math.max(size - length, 0);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
