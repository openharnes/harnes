import { SESSION_MODE_LABELS } from "../exec/types.ts";
import type { HarnesSession } from "../session-manager/types.ts";
import {
  ALL_MODE_MAX_PANES,
  ALL_MODE_MIN_TERM_ROWS,
  ALL_MODE_MIN_TERM_WIDTH,
} from "./contract.ts";

export type PaneAccent = "orange" | "green" | "pink" | "yellow";

export const PANE_ACCENTS: PaneAccent[] = ["orange", "green", "pink", "yellow"];

export interface AllModeLayoutInput {
  /** Up to 4 sessions; missing slots render as empty placeholders. */
  sessions: Array<HarnesSession | null>;
  /** Overlay transcript lines keyed by session id (not persisted on HarnesSession). */
  transcripts: Record<string, string[]>;
  focusedId: string;
  termWidth: number;
  termRows: number;
  hostLabel?: string;
}

export type AllModeLayoutOk = {
  ok: true;
  lines: string[];
  paneWidth: number;
  paneHeight: number;
};

export type AllModeLayoutErr = {
  ok: false;
  reason: string;
};

export type AllModeLayoutResult = AllModeLayoutOk | AllModeLayoutErr;

function shortPath(cwd: string, max = 18): string {
  const home = process.env.HOME ?? "";
  let s = cwd;
  if (home && s.startsWith(home)) s = `~${s.slice(home.length)}`;
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

function modelLabel(session: HarnesSession): string {
  if (!session.pinnedModelId) return "auto";
  const id = session.pinnedModelId;
  const leaf = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return leaf.length > 16 ? `${leaf.slice(0, 15)}…` : leaf;
}

function statusGlyph(session: HarnesSession): string {
  if (session.status === "running") return "●";
  if (session.status === "error") return "!";
  return "○";
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/** One pane's interior lines (no outer grid borders) — header + body + footer. */
export function formatPaneLines(
  session: HarnesSession | null,
  opts: {
    width: number;
    height: number;
    slot: number;
    focused: boolean;
    accent: PaneAccent;
    hostLabel: string;
    transcript: string[];
  }
): string[] {
  const { width, height, slot, focused, hostLabel, transcript } = opts;
  const lines: string[] = [];
  const focusMark = focused ? "▸" : " ";
  const accentBar = "─".repeat(Math.max(1, width));

  if (!session) {
    lines.push(accentBar);
    lines.push(pad(`${focusMark} [${slot}] empty — /pane ${slot}`, width));
    while (lines.length < height) lines.push(pad("", width));
    return lines.map((l) => pad(l, width));
  }

  const header = `${focusMark} ${modelLabel(session)}  ${clip(session.title, Math.max(6, width - 28))}  ${shortPath(session.cwd)}`;
  const meta = `${statusGlyph(session)} ${SESSION_MODE_LABELS[session.sessionMode]} · ${hostLabel} · ${session.id.slice(0, 8)}`;
  lines.push(accentBar);
  lines.push(pad(clip(header, width), width));
  lines.push(pad(clip(meta, width), width));
  lines.push(pad("·".repeat(Math.min(width, 12)), width));

  const bodyBudget = Math.max(1, height - lines.length - 1);
  const body = transcript.length
    ? transcript.slice(-bodyBudget)
    : session.status === "running"
      ? ["… running"]
      : ["(idle — focus + type a task)"];
  for (let i = 0; i < bodyBudget; i += 1) {
    lines.push(pad(clip(body[i] ?? "", width), width));
  }

  const spend =
    session.usage.costUsd > 0
      ? session.usage.costUsd < 0.01
        ? `$${session.usage.costUsd.toFixed(4)}`
        : `$${session.usage.costUsd.toFixed(2)}`
      : "$0.00";
  lines.push(pad(clip(`${session.status} · ${spend} · todos ${session.todos.length}`, width), width));

  while (lines.length < height) lines.push(pad("", width));
  return lines.slice(0, height).map((l) => pad(l, width));
}

/**
 * Build a 2×2 All-mode grid as plain lines (no ANSI). Caller paints accents.
 */
export function formatAllModeGrid(input: AllModeLayoutInput): AllModeLayoutResult {
  const width = input.termWidth;
  const rows = input.termRows;
  if (width < ALL_MODE_MIN_TERM_WIDTH || rows < ALL_MODE_MIN_TERM_ROWS) {
    return {
      ok: false,
      reason: `All mode needs ≥${ALL_MODE_MIN_TERM_WIDTH}×${ALL_MODE_MIN_TERM_ROWS} terminal (now ${width}×${rows}). Resize or /single.`,
    };
  }

  const gap = 1;
  const paneWidth = Math.floor((width - gap) / 2);
  const usable = rows - 8;
  const paneHeight = Math.max(8, Math.floor(usable / 2));
  const host = input.hostLabel ?? "local";

  const slots: Array<HarnesSession | null> = [null, null, null, null];
  for (let i = 0; i < ALL_MODE_MAX_PANES; i += 1) {
    slots[i] = input.sessions[i] ?? null;
  }

  const panes = slots.map((session, i) =>
    formatPaneLines(session, {
      width: paneWidth,
      height: paneHeight,
      slot: i + 1,
      focused: Boolean(session && session.id === input.focusedId),
      accent: PANE_ACCENTS[i]!,
      hostLabel: host,
      transcript: session ? (input.transcripts[session.id] ?? []) : [],
    })
  );

  const joinRow = (left: string[], right: string[]): string[] => {
    const out: string[] = [];
    for (let r = 0; r < paneHeight; r += 1) {
      out.push(`${left[r] ?? pad("", paneWidth)} ${right[r] ?? pad("", paneWidth)}`);
    }
    return out;
  };

  const lines: string[] = [];
  lines.push(pad("All mode · ⌃P cycle panes · /pane 1-4 · /single to exit", width));
  lines.push(...joinRow(panes[0]!, panes[1]!));
  lines.push("");
  lines.push(...joinRow(panes[2]!, panes[3]!));
  lines.push(pad(`focused → ${input.focusedId ? input.focusedId.slice(0, 8) : "(none)"}`, width));

  return { ok: true, lines, paneWidth, paneHeight };
}

export function canEnterAllMode(
  termWidth: number,
  termRows: number
): { ok: true } | { ok: false; reason: string } {
  if (termWidth < ALL_MODE_MIN_TERM_WIDTH || termRows < ALL_MODE_MIN_TERM_ROWS) {
    return {
      ok: false,
      reason: `All mode needs ≥${ALL_MODE_MIN_TERM_WIDTH}×${ALL_MODE_MIN_TERM_ROWS} (now ${termWidth}×${termRows}).`,
    };
  }
  return { ok: true };
}
