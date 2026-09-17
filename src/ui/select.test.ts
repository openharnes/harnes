import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampIndex } from "./select.ts";

describe("clampIndex", () => {
  it("clamps into range", () => {
    assert.equal(clampIndex(-1, 5), 0);
    assert.equal(clampIndex(0, 5), 0);
    assert.equal(clampIndex(4, 5), 4);
    assert.equal(clampIndex(99, 5), 4);
  });

  it("returns 0 for empty lists", () => {
    assert.equal(clampIndex(3, 0), 0);
  });
});
