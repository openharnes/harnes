import type { ExpectedToolCall, ScoredCall, TaskScore } from "./types.ts";

function argsMatch(expected: Record<string, string> | undefined, actual: Record<string, string>): boolean {
  if (!expected || Object.keys(expected).length === 0) return true;
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) return false;
  }
  return true;
}

/**
 * Score first-step tool calls against an expect list (BFCL-style name + partial args).
 * Unexpected extra calls are recorded but do not fail the task if every expected call matched
 * (models often over-call; primary metric is recall of required tools).
 */
export function scoreToolCalls(
  taskId: string,
  expect: ExpectedToolCall[],
  actual: Array<{ name: string; arguments: Record<string, string> }>,
  opts: { ordered?: boolean; content?: string } = {}
): TaskScore {
  const unexpected: string[] = [];
  const calls: ScoredCall[] = [];
  const used = new Set<number>();

  if (expect.length === 0) {
    const passed = actual.length === 0;
    return {
      taskId,
      passed,
      score: passed ? 1 : 0,
      expectedCount: 0,
      matchedCount: 0,
      unexpected: actual.map((call) => call.name),
      calls: [],
      actual,
      contentPreview: opts.content?.slice(0, 120),
    };
  }

  if (opts.ordered) {
    for (let i = 0; i < expect.length; i += 1) {
      const exp = expect[i];
      const act = actual[i];
      if (!act) {
        calls.push({ expected: exp, matched: false, detail: "missing call at this index" });
        continue;
      }
      used.add(i);
      const nameOk = act.name === exp.name;
      const argsOk = argsMatch(exp.arguments, act.arguments);
      calls.push({
        expected: exp,
        matched: nameOk && argsOk,
        actualName: act.name,
        detail: !nameOk ? `wanted ${exp.name}, got ${act.name}` : !argsOk ? "argument mismatch" : "ok",
      });
    }
    for (let i = expect.length; i < actual.length; i += 1) {
      unexpected.push(actual[i].name);
    }
  } else {
    for (const exp of expect) {
      let found = -1;
      for (let i = 0; i < actual.length; i += 1) {
        if (used.has(i)) continue;
        if (actual[i].name === exp.name && argsMatch(exp.arguments, actual[i].arguments)) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        used.add(found);
        calls.push({
          expected: exp,
          matched: true,
          actualName: actual[found].name,
          detail: "ok",
        });
      } else {
        const sameName = actual.find((call, i) => !used.has(i) && call.name === exp.name);
        calls.push({
          expected: exp,
          matched: false,
          actualName: sameName?.name,
          detail: sameName ? "argument mismatch" : "tool not called",
        });
      }
    }
    for (let i = 0; i < actual.length; i += 1) {
      if (!used.has(i)) unexpected.push(actual[i].name);
    }
  }

  const matchedCount = calls.filter((call) => call.matched).length;
  const score = expect.length === 0 ? (actual.length === 0 ? 1 : 0) : matchedCount / expect.length;
  return {
    taskId,
    passed: matchedCount === expect.length,
    score,
    expectedCount: expect.length,
    matchedCount,
    unexpected,
    calls,
    actual,
    contentPreview: opts.content?.slice(0, 120),
  };
}
