import { readFile, access } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, OutcomeCheck } from "./types.ts";

export interface OutcomeContext {
  workspaceRoot: string;
  /** Last assistant text after the loop stopped. */
  finalContent: string;
}

function label(check: OutcomeCheck): string {
  switch (check.type) {
    case "file_contains":
      return `file_contains(${check.path})`;
    case "file_equals":
      return `file_equals(${check.path})`;
    case "file_exists":
      return `file_exists(${check.path})`;
    case "file_not_exists":
      return `file_not_exists(${check.path})`;
    case "final_contains":
      return "final_contains";
    case "final_matches":
      return `final_matches(/${check.pattern}/)`;
  }
}

async function fileExists(root: string, rel: string): Promise<boolean> {
  try {
    await access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

export async function scoreOutcomeChecks(checks: OutcomeCheck[], ctx: OutcomeContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      switch (check.type) {
        case "file_contains": {
          const body = await readFile(path.join(ctx.workspaceRoot, check.path), "utf8");
          const passed = body.includes(check.text);
          results.push({
            check,
            passed,
            detail: passed ? "ok" : `${label(check)}: missing ${JSON.stringify(check.text)}`,
          });
          break;
        }
        case "file_equals": {
          const body = await readFile(path.join(ctx.workspaceRoot, check.path), "utf8");
          const passed = body === check.text;
          results.push({
            check,
            passed,
            detail: passed ? "ok" : `${label(check)}: content mismatch`,
          });
          break;
        }
        case "file_exists": {
          const passed = await fileExists(ctx.workspaceRoot, check.path);
          results.push({
            check,
            passed,
            detail: passed ? "ok" : `${label(check)}: missing`,
          });
          break;
        }
        case "file_not_exists": {
          const exists = await fileExists(ctx.workspaceRoot, check.path);
          results.push({
            check,
            passed: !exists,
            detail: !exists ? "ok" : `${label(check)}: still present`,
          });
          break;
        }
        case "final_contains": {
          const passed = ctx.finalContent.includes(check.text);
          results.push({
            check,
            passed,
            detail: passed ? "ok" : `${label(check)}: missing ${JSON.stringify(check.text)}`,
          });
          break;
        }
        case "final_matches": {
          const re = new RegExp(check.pattern, "i");
          const passed = re.test(ctx.finalContent);
          results.push({
            check,
            passed,
            detail: passed ? "ok" : `${label(check)}: no match`,
          });
          break;
        }
      }
    } catch (error) {
      results.push({
        check,
        passed: false,
        detail: `${label(check)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}
