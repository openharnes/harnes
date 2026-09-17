/**
 * Harnes tool-calling + outcome eval types.
 *
 * τ-bench is a customer-service domain sim — we intentionally do *not* vendor it.
 * Default live mode runs the full agent loop in a temp workspace and scores
 * post-tool outcomes (`checks`). `--first-step` keeps BFCL-style call accuracy only.
 */

export interface ExpectedToolCall {
  name: string;
  /** Partial arg match: every key here must equal the model's arg (string compare). Extra model args OK. */
  arguments?: Record<string, string>;
}

/** Seed files written into the temp workspace before the loop runs. */
export interface EvalSetup {
  files?: Record<string, string>;
  /** When true, `git init` + initial commit after writing files (for git_* tasks). */
  gitInit?: boolean;
}

/**
 * Assertions evaluated after the agent loop finishes (tools have actually run).
 * Paths are relative to the temp workspace root.
 */
export type OutcomeCheck =
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_equals"; path: string; text: string }
  | { type: "file_exists"; path: string }
  | { type: "file_not_exists"; path: string }
  | { type: "final_contains"; text: string }
  | { type: "final_matches"; pattern: string };

export interface EvalTask {
  /** Stable id, e.g. "list_dir_cwd" */
  id: string;
  /** Short human description */
  description?: string;
  /** User prompt sent to the model. */
  prompt: string;
  /**
   * Expected tool calls somewhere in the trajectory (any step in loop mode;
   * first completion only in first-step mode). Empty = abstain (no tools).
   */
  expect: ExpectedToolCall[];
  /** When true, expect[] must match in order as well as content. */
  ordered?: boolean;
  /** Optional tags for filtering: explore, edit, git, abstain, … */
  tags?: string[];
  /** Workspace seed for loop mode. */
  setup?: EvalSetup;
  /** Post-loop outcome checks (primary score signal in loop mode). */
  checks?: OutcomeCheck[];
  /** Cap agent steps in loop mode (default 8). */
  maxSteps?: number;
}

export interface ScoredCall {
  expected: ExpectedToolCall;
  matched: boolean;
  actualName?: string;
  detail: string;
}

export interface CheckResult {
  check: OutcomeCheck;
  passed: boolean;
  detail: string;
}

export interface TaskScore {
  taskId: string;
  passed: boolean;
  /** Combined score in [0,1] (tools and/or checks). */
  score: number;
  expectedCount: number;
  matchedCount: number;
  unexpected: string[];
  calls: ScoredCall[];
  actual: Array<{ name: string; arguments: Record<string, string> }>;
  /** Model text when it stalled with no tools but tools were expected. */
  contentPreview?: string;
  /** Loop-mode outcome check results. */
  checks?: CheckResult[];
  /** Agent loop steps completed (loop mode). */
  steps?: number;
  /** How this task was scored. */
  mode?: "first-step" | "loop" | "fixture";
}

export interface EvalReport {
  model: string;
  mode: "live" | "fixture" | "live-loop" | "live-first-step";
  tasks: TaskScore[];
  passed: number;
  failed: number;
  accuracy: number;
}
