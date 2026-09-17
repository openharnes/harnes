import { stdin as input, stdout as output } from "node:process";

export interface SelectItem<T> {
  value: T;
  /** Primary label shown in the list. */
  label: string;
  /** Optional muted trailing detail (id, ctx, …). */
  detail?: string;
  /** Shown after the label when this is the currently active choice. */
  current?: boolean;
}

export interface SelectOptions<T> {
  title: string;
  items: SelectItem<T>[];
  /** Initial highlight index (clamped). Default 0. */
  initialIndex?: number;
  /** Max visible rows (scrolls). Default 12. */
  pageSize?: number;
  /** Called with the filter query to rebuild the visible list. When omitted, simple substring filter on label+detail. */
  filter?: (query: string, items: SelectItem<T>[]) => SelectItem<T>[];
  paint: (color: string, text: string) => string;
  colors: {
    accent: string;
    accentBright: string;
    muted: string;
    soft: string;
    warm: string;
  };
}

/**
 * Interactive ↑/↓ (or click) + Enter picker for TTY REPLs.
 * Returns the selected value, or null if cancelled (Esc / Ctrl+C / q).
 */
export async function selectFromList<T>(opts: SelectOptions<T>): Promise<T | null> {
  if (!input.isTTY || !output.isTTY) {
    output.write(`${opts.title}\n`);
    for (let i = 0; i < Math.min(opts.items.length, 20); i += 1) {
      const item = opts.items[i];
      output.write(`  ${i + 1}. ${item.label}${item.detail ? `  ${item.detail}` : ""}\n`);
    }
    return null;
  }

  const pageSize = Math.max(4, opts.pageSize ?? 12);
  const filterFn =
    opts.filter ??
    ((query: string, items: SelectItem<T>[]) => {
      const q = query.trim().toLowerCase();
      if (!q) return items;
      return items.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(q));
    });

  let query = "";
  let filtered = filterFn(query, opts.items);
  let index = clampIndex(opts.initialIndex ?? 0, filtered.length);
  let windowStart = 0;
  let drawnLines = 0;
  let closed = false;
  /** 1-based screen row where the picker's title line starts. */
  let anchorRow = 1;

  const wasRaw = input.isRaw === true;

  const ensureWindow = () => {
    if (filtered.length === 0) {
      windowStart = 0;
      return;
    }
    if (index < windowStart) windowStart = index;
    if (index >= windowStart + pageSize) windowStart = index - pageSize + 1;
  };

  const clearDrawn = () => {
    if (drawnLines <= 0) return;
    output.write(`\x1b[${drawnLines}A\r\x1b[0J`);
    drawnLines = 0;
  };

  const buildLines = (): string[] => {
    ensureWindow();
    const lines: string[] = [];
    lines.push(opts.paint(opts.colors.accentBright, opts.title));
    lines.push(
      opts.paint(opts.colors.muted, "↑↓ / click  ·  Enter pin  ·  Esc cancel  ·  type to filter")
    );
    lines.push(
      query
        ? opts.paint(opts.colors.warm, `filter: ${query}█`)
        : opts.paint(opts.colors.muted, "filter: (type to narrow)")
    );

    if (filtered.length === 0) {
      lines.push(opts.paint(opts.colors.muted, "  (no matches)"));
      return lines;
    }

    const end = Math.min(filtered.length, windowStart + pageSize);
    if (windowStart > 0) lines.push(opts.paint(opts.colors.muted, `  ↑ ${windowStart} more`));
    for (let i = windowStart; i < end; i += 1) {
      const item = filtered[i];
      const selected = i === index;
      const mark = selected ? "▸" : " ";
      const cur = item.current ? opts.paint(opts.colors.soft, " *") : "";
      const label = selected
        ? opts.paint(opts.colors.accentBright, item.label)
        : opts.paint(opts.colors.accent, item.label);
      const detail = item.detail ? opts.paint(opts.colors.muted, `  ${item.detail}`) : "";
      lines.push(`${selected ? opts.paint(opts.colors.soft, mark) : mark} ${label}${detail}${cur}`);
    }
    const hiddenBelow = filtered.length - end;
    if (hiddenBelow > 0) lines.push(opts.paint(opts.colors.muted, `  ↓ ${hiddenBelow} more`));
    return lines;
  };

  const render = () => {
    clearDrawn();
    const lines = buildLines();
    output.write(lines.join("\n") + "\n");
    drawnLines = lines.length;
  };

  /** Map absolute mouse row → filtered index, or null if outside the item rows. */
  const indexFromMouseRow = (row1: number): number | null => {
    if (filtered.length === 0) return null;
    // title, help, filter = 3 header lines at anchorRow..anchorRow+2
    let row = anchorRow + 3;
    if (windowStart > 0) row += 1;
    const end = Math.min(filtered.length, windowStart + pageSize);
    for (let i = windowStart; i < end; i += 1) {
      if (row1 === row) return i;
      row += 1;
    }
    return null;
  };

  let resolve!: (value: T | null) => void;
  const done = new Promise<T | null>((r) => {
    resolve = r;
  });

  let escTimer: ReturnType<typeof setTimeout> | undefined;
  let buf = "";

  const finish = (value: T | null): T | null => {
    if (closed) return value;
    closed = true;
    if (escTimer) clearTimeout(escTimer);
    clearDrawn();
    output.write("\x1b[?1000l\x1b[?1006l");
    if (input.setRawMode) input.setRawMode(wasRaw);
    input.removeListener("data", onData);
    return value;
  };

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    index = (index + delta + filtered.length) % filtered.length;
    render();
  };

  const applyFilter = (next: string) => {
    query = next;
    filtered = filterFn(query, opts.items);
    index = 0;
    windowStart = 0;
    render();
  };

  const onData = (chunk: Buffer | string) => {
    if (closed) return;
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    while (buf.length > 0) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
      if (mouse) {
        buf = buf.slice(mouse[0].length);
        const btn = Number(mouse[1]);
        const row = Number(mouse[3]);
        const press = mouse[4] === "M";
        if (press && btn === 0) {
          const hit = indexFromMouseRow(row);
          if (hit != null) {
            index = hit;
            render();
          }
        } else if (press && btn === 64) move(-1);
        else if (press && btn === 65) move(1);
        continue;
      }

      // Cursor-position reply (from DSR) — ignore if any slip through
      const dsr = /^\x1b\[(\d+);(\d+)R/.exec(buf);
      if (dsr) {
        buf = buf.slice(dsr[0].length);
        continue;
      }

      if (buf[0] === "\x1b") {
        if (buf.startsWith("\x1b[A") || buf.startsWith("\x1bOA")) {
          buf = buf.slice(3);
          if (escTimer) clearTimeout(escTimer);
          move(-1);
          continue;
        }
        if (buf.startsWith("\x1b[B") || buf.startsWith("\x1bOB")) {
          buf = buf.slice(3);
          if (escTimer) clearTimeout(escTimer);
          move(1);
          continue;
        }
        if (buf.startsWith("\x1b[C") || buf.startsWith("\x1b[D") || buf.startsWith("\x1bOC") || buf.startsWith("\x1bOD")) {
          buf = buf.slice(3);
          if (escTimer) clearTimeout(escTimer);
          continue;
        }
        // Incomplete CSI — wait for more (or bare Esc timeout)
        if (buf.length === 1 || (buf[1] === "[" && !/[\x40-\x7e]/.test(buf.slice(2)))) {
          if (escTimer) clearTimeout(escTimer);
          escTimer = setTimeout(() => {
            if (closed) return;
            buf = "";
            resolve(finish(null));
          }, 40);
          return;
        }
        // Unknown Esc seq — drop the Esc
        buf = buf.slice(1);
        continue;
      }

      if (escTimer) clearTimeout(escTimer);
      const ch = buf[0];
      buf = buf.slice(1);

      if (ch === "\u0003") {
        resolve(finish(null));
        return;
      }
      if (ch === "\r" || ch === "\n") {
        if (filtered.length === 0) continue;
        resolve(finish(filtered[index].value));
        return;
      }
      if (ch === "\u007f" || ch === "\b") {
        if (query.length > 0) applyFilter(query.slice(0, -1));
        continue;
      }
      if (ch === "q" && query.length === 0) {
        resolve(finish(null));
        return;
      }
      if (ch === "\u0015") {
        if (query) applyFilter("");
        continue;
      }
      if (ch >= " " && ch <= "~") applyFilter(query + ch);
    }
  };

  if (input.setRawMode) input.setRawMode(true);
  input.resume();

  // Learn where the picker will start so mouse Y maps onto item rows.
  anchorRow = await readCursorRow();
  output.write("\x1b[?1000h\x1b[?1006h");
  input.on("data", onData);
  render();

  return done;
}

/** Clamp helper used by tests and callers that pre-compute an initial index. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

function readCursorRow(): Promise<number> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(1);
    }, 100);
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const m = /\x1b\[(\d+);(\d+)R/.exec(s);
      if (!m) return;
      cleanup();
      resolve(Number(m[1]));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      input.removeListener("data", onData);
    };
    input.on("data", onData);
    output.write("\x1b[6n");
  });
}
