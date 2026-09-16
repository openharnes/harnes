import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpToolAllowed, needsApproval } from "./types.ts";

describe("mcpToolAllowed", () => {
  it("plan mode only allows tools confidently classified as read-only", () => {
    assert.equal(mcpToolAllowed("plan", "read"), true);
    assert.equal(mcpToolAllowed("plan", "write"), false);
    assert.equal(mcpToolAllowed("plan", "unknown"), false);
  });

  it("build mode allows any classification (approval is a separate gate)", () => {
    assert.equal(mcpToolAllowed("build", "read"), true);
    assert.equal(mcpToolAllowed("build", "write"), true);
    assert.equal(mcpToolAllowed("build", "unknown"), true);
  });
});

describe("needsApproval for mcp__ tools", () => {
  it("auto and plan never prompt, regardless of classification", () => {
    assert.equal(needsApproval("auto", "mcp__x__y", "write"), false);
    assert.equal(needsApproval("plan", "mcp__x__y", "write"), false);
  });

  it("manual always prompts, regardless of classification", () => {
    assert.equal(needsApproval("manual", "mcp__x__y", "read"), true);
  });

  it("ask mode auto-runs a confidently read-only mcp tool but prompts for write/unknown", () => {
    assert.equal(needsApproval("ask", "mcp__x__y", "read"), false);
    assert.equal(needsApproval("ask", "mcp__x__y", "write"), true);
    assert.equal(needsApproval("ask", "mcp__x__y", "unknown"), true);
    assert.equal(needsApproval("ask", "mcp__x__y", undefined), true);
  });

  it("non-mcp tools are unaffected by the mcpClass argument", () => {
    assert.equal(needsApproval("ask", "write_file", "read"), true); // still an EDIT_TOOLS member
    assert.equal(needsApproval("ask", "git_status", "write"), false); // not an edit tool
  });
});
