/**
 * Shared output-capping helpers. Every tool that can return unbounded text
 * (read_file, bash, grep, glob, list_dir) should route its result through
 * `truncateOutput` before it re-enters the model context.
 */

export interface TruncateOptions {
  /** Maximum characters to keep. Default 20_000. */
  maxChars?: number;
  /** Maximum lines to keep. If set, applied in addition to maxChars. */
  maxLines?: number;
  /**
   * When both head/tail are wanted (e.g. bash output), keep this many lines
   * from the start and this many from the end instead of a hard cutoff.
   * Only used when maxLines is exceeded and headLines/tailLines are set.
   */
  headLines?: number;
  tailLines?: number;
}

export const DEFAULT_MAX_CHARS = 20_000;
export const DEFAULT_MAX_LINES = 2_000;

/**
 * Truncates `text` per `opts`, appending a clear `... truncated N characters/lines ...`
 * marker when content was cut. Never throws; always returns a string.
 */
export function truncateOutput(text: string, opts: TruncateOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = opts.maxLines;

  if (maxLines !== undefined) {
    const lines = text.split("\n");
    if (lines.length > maxLines) {
      const omitted = lines.length - maxLines;
      let kept: string[];
      if (opts.headLines !== undefined || opts.tailLines !== undefined) {
        const head = opts.headLines ?? Math.ceil(maxLines / 2);
        const tail = opts.tailLines ?? Math.floor(maxLines / 2);
        const headLines = lines.slice(0, head);
        const tailLines = tail > 0 ? lines.slice(lines.length - tail) : [];
        kept = [...headLines, `... truncated ${omitted} lines ...`, ...tailLines];
      } else {
        kept = [...lines.slice(0, maxLines), `... truncated ${omitted} lines ...`];
      }
      text = kept.join("\n");
    }
  }

  if (text.length > maxChars) {
    const omitted = text.length - maxChars;
    text = `${text.slice(0, maxChars)}\n... truncated ${omitted} characters ...`;
  }

  return text;
}

/**
 * Caps a list of entries. Returns kept entries separately from the omitted count
 * so callers don't inject a fake path into the list.
 */
export function truncateList(entries: string[], maxEntries = 500): { entries: string[]; omitted: number } {
  if (entries.length <= maxEntries) return { entries, omitted: 0 };
  return { entries: entries.slice(0, maxEntries), omitted: entries.length - maxEntries };
}

/** Join a capped list for tool output (marker is a trailing note, not a path). */
export function formatTruncatedList(entries: string[], maxEntries = 500): string {
  const { entries: kept, omitted } = truncateList(entries, maxEntries);
  if (kept.length === 0) return "";
  if (omitted === 0) return kept.join("\n");
  return `${kept.join("\n")}\n... truncated ${omitted} entries ...`;
}
