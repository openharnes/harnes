/**
 * Session-scoped todo/plan tracking. The agent calls the `todo_write` tool
 * with the full desired list; we replace the in-memory list wholesale (same
 * shape as history: lives for the REPL session, cleared on /clear).
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (VALID_STATUSES as string[]).includes(value);
}

/**
 * Parses and validates a `todo_write` tool call's `items` argument (a JSON
 * array string). Throws a clear, model-readable error on malformed input
 * instead of silently dropping/guessing fields.
 */
export function parseTodoItems(raw: string | undefined): TodoItem[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new Error(
      'Missing "items". Pass a JSON array like [{"id":"1","content":"...","status":"pending"}].'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`"items" must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('"items" must be a JSON array of {id, content, status}.');
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Item ${index} must be an object with id, content, status.`);
    }
    const { id, content, status } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`Item ${index} is missing a non-empty string "id".`);
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`Item ${index} (id=${id}) is missing a non-empty string "content".`);
    }
    if (!isTodoStatus(status)) {
      throw new Error(`Item ${index} (id=${id}) has invalid "status" ${JSON.stringify(status)}; expected one of ${VALID_STATUSES.join(", ")}.`);
    }
    return { id, content, status };
  });
}

/**
 * Replaces `store`'s contents in place with `items` so callers holding a
 * reference to the same array (e.g. the REPL session) see the update
 * without needing to re-fetch it.
 */
export function setTodos(store: TodoItem[], items: TodoItem[]): TodoItem[] {
  store.length = 0;
  store.push(...items);
  return store;
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/** Renders a todo list for tool results and the /todos slash command. */
export function formatTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos)";
  return items.map((item) => `${STATUS_MARK[item.status]} ${item.id}. ${item.content}`).join("\n");
}
