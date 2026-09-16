import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLI_NAME, ONE_LINER, SHORT_NAME } from "./positioning.ts";

describe("positioning", () => {
  it("locks the one-liner and short name", () => {
    assert.equal(ONE_LINER, "Harnes is the open coding agent.");
    assert.equal(SHORT_NAME, "Harnes");
    assert.equal(CLI_NAME, "harnes");
    assert.equal(ONE_LINER.includes("OpenHost"), false);
  });
});
