import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTruncatedList, truncateList, truncateOutput } from "./output.ts";

describe("truncateOutput", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncateOutput("hello"), "hello");
  });

  it("caps by character count with a characters truncation marker", () => {
    const text = "a".repeat(100);
    const result = truncateOutput(text, { maxChars: 10 });
    assert.equal(result, `${"a".repeat(10)}\n... truncated 90 characters ...`);
  });

  it("caps by line count with a line truncation marker", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const result = truncateOutput(lines.join("\n"), { maxLines: 5, maxChars: 10_000 });
    assert.match(result, /^line0\nline1\nline2\nline3\nline4\n\.\.\. truncated 5 lines \.\.\.$/);
  });

  it("keeps head and tail lines when headLines/tailLines are set", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const result = truncateOutput(lines.join("\n"), {
      maxLines: 6,
      maxChars: 10_000,
      headLines: 3,
      tailLines: 3,
    });
    const resultLines = result.split("\n");
    assert.deepEqual(resultLines.slice(0, 3), ["line0", "line1", "line2"]);
    assert.deepEqual(resultLines.slice(-3), ["line17", "line18", "line19"]);
    assert.ok(resultLines.some((line) => line.includes("truncated 14 lines")));
  });

  it("does not truncate when under both caps", () => {
    const text = "line1\nline2\nline3";
    assert.equal(truncateOutput(text, { maxLines: 10, maxChars: 1000 }), text);
  });
});

describe("truncateList", () => {
  it("returns short lists unchanged", () => {
    assert.deepEqual(truncateList(["a", "b"], 5), { entries: ["a", "b"], omitted: 0 });
  });

  it("caps long lists without injecting a fake path entry", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `entry${i}`);
    const result = truncateList(entries, 4);
    assert.deepEqual(result.entries, ["entry0", "entry1", "entry2", "entry3"]);
    assert.equal(result.omitted, 6);
  });

  it("formatTruncatedList puts the marker as a trailing note", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `entry${i}`);
    const text = formatTruncatedList(entries, 4);
    assert.equal(text.split("\n").at(-1), "... truncated 6 entries ...");
    assert.ok(!text.split("\n").slice(0, 4).some((line) => line.includes("truncated")));
  });
});
