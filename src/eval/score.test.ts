import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreToolCalls } from "./score.ts";

describe("scoreToolCalls", () => {
  it("passes when name + partial args match (extras on model OK)", () => {
    const result = scoreToolCalls(
      "read",
      [{ name: "read_file", arguments: { path: "index.html" } }],
      [{ name: "read_file", arguments: { path: "index.html", offset: "1" } }]
    );
    assert.equal(result.passed, true);
    assert.equal(result.score, 1);
    assert.equal(result.matchedCount, 1);
  });

  it("fails on wrong tool name", () => {
    const result = scoreToolCalls(
      "read",
      [{ name: "read_file", arguments: { path: "a.txt" } }],
      [{ name: "bash", arguments: { command: "cat a.txt" } }]
    );
    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
    assert.equal(result.calls[0]?.detail, "tool not called");
  });

  it("fails on argument mismatch", () => {
    const result = scoreToolCalls(
      "read",
      [{ name: "read_file", arguments: { path: "a.txt" } }],
      [{ name: "read_file", arguments: { path: "b.txt" } }]
    );
    assert.equal(result.passed, false);
    assert.equal(result.calls[0]?.detail, "argument mismatch");
  });

  it("matches by name only when expect has no arguments", () => {
    const result = scoreToolCalls("glob", [{ name: "glob" }], [
      { name: "glob", arguments: { pattern: "**/*.ts" } },
    ]);
    assert.equal(result.passed, true);
  });

  it("is order-insensitive by default", () => {
    const result = scoreToolCalls(
      "multi",
      [{ name: "list_dir" }, { name: "read_file", arguments: { path: "x" } }],
      [
        { name: "read_file", arguments: { path: "x" } },
        { name: "list_dir", arguments: {} },
      ]
    );
    assert.equal(result.passed, true);
  });

  it("enforces order when ordered=true", () => {
    const result = scoreToolCalls(
      "multi",
      [{ name: "list_dir" }, { name: "read_file" }],
      [
        { name: "read_file", arguments: {} },
        { name: "list_dir", arguments: {} },
      ],
      { ordered: true }
    );
    assert.equal(result.passed, false);
  });

  it("abstains when expect is empty and model called no tools", () => {
    const result = scoreToolCalls("hi", [], []);
    assert.equal(result.passed, true);
    assert.equal(result.score, 1);
  });

  it("fails abstain when model still calls tools", () => {
    const result = scoreToolCalls("hi", [], [{ name: "list_dir", arguments: {} }]);
    assert.equal(result.passed, false);
    assert.deepEqual(result.unexpected, ["list_dir"]);
  });

  it("passes when all expected matched even with unexpected extras", () => {
    const result = scoreToolCalls(
      "list",
      [{ name: "list_dir" }],
      [
        { name: "list_dir", arguments: {} },
        { name: "bash", arguments: { command: "ls" } },
      ]
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.unexpected, ["bash"]);
  });

  it("scores partial credit for multi-expect", () => {
    const result = scoreToolCalls(
      "two",
      [{ name: "list_dir" }, { name: "read_file" }],
      [{ name: "list_dir", arguments: {} }]
    );
    assert.equal(result.passed, false);
    assert.equal(result.score, 0.5);
    assert.equal(result.matchedCount, 1);
  });
});
