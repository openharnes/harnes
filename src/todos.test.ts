import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTodoList, parseTodoItems, setTodos, type TodoItem } from "./todos.ts";

describe("parseTodoItems", () => {
  it("parses a valid JSON array of items", () => {
    const items = parseTodoItems(
      JSON.stringify([
        { id: "1", content: "Read the docs", status: "pending" },
        { id: "2", content: "Write code", status: "in_progress" },
      ])
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { id: "1", content: "Read the docs", status: "pending" });
    assert.deepEqual(items[1], { id: "2", content: "Write code", status: "in_progress" });
  });

  it("throws a clear error when items is missing", () => {
    assert.throws(() => parseTodoItems(undefined), /Missing "items"/);
    assert.throws(() => parseTodoItems(""), /Missing "items"/);
  });

  it("throws a clear error on invalid JSON", () => {
    assert.throws(() => parseTodoItems("{not json"), /must be valid JSON/);
  });

  it("throws when items is not an array", () => {
    assert.throws(() => parseTodoItems(JSON.stringify({ id: "1" })), /must be a JSON array/);
  });

  it("throws when an item is missing id or content", () => {
    assert.throws(
      () => parseTodoItems(JSON.stringify([{ content: "x", status: "pending" }])),
      /missing a non-empty string "id"/
    );
    assert.throws(
      () => parseTodoItems(JSON.stringify([{ id: "1", status: "pending" }])),
      /missing a non-empty string "content"/
    );
  });

  it("throws on an invalid status", () => {
    assert.throws(
      () => parseTodoItems(JSON.stringify([{ id: "1", content: "x", status: "done" }])),
      /invalid "status"/
    );
  });
});

describe("setTodos", () => {
  it("replaces the store's contents in place, keeping the same array reference", () => {
    const store: TodoItem[] = [{ id: "1", content: "old", status: "pending" }];
    const ref = store;
    const next: TodoItem[] = [
      { id: "1", content: "old", status: "completed" },
      { id: "2", content: "new", status: "pending" },
    ];
    const result = setTodos(store, next);
    assert.equal(result, ref, "should mutate and return the same array reference");
    assert.deepEqual(store, next);
  });

  it("drops items omitted from a later call (full replace, not a delta)", () => {
    const store: TodoItem[] = [
      { id: "1", content: "a", status: "pending" },
      { id: "2", content: "b", status: "pending" },
    ];
    setTodos(store, [{ id: "1", content: "a", status: "completed" }]);
    assert.equal(store.length, 1);
    assert.equal(store[0].id, "1");
  });
});

describe("formatTodoList", () => {
  it("renders a placeholder for an empty list", () => {
    assert.equal(formatTodoList([]), "(no todos)");
  });

  it("renders status marks and content for each item", () => {
    const text = formatTodoList([
      { id: "1", content: "first", status: "pending" },
      { id: "2", content: "second", status: "in_progress" },
      { id: "3", content: "third", status: "completed" },
    ]);
    assert.match(text, /\[ ] 1\. first/);
    assert.match(text, /\[~] 2\. second/);
    assert.match(text, /\[x] 3\. third/);
  });
});
