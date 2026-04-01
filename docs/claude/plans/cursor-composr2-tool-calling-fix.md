# Fix: cursor/composer-2 tool calling failures on `/init`

## Context

When running `/init` with `cursor/composer-2`, the first tool call (Read package.json) succeeds but all subsequent tool calls (Read, Search) fail with red dots. This happens because multi-turn tool call conversations produce message chains like:

```
user → assistant(tool_call) → tool(result) → assistant(tool_call) → tool(result) → ...
```

Two bugs in `parseMessages()` cause tool call context to be lost after the first round-trip.

## Root Causes

### Bug 1: `parseMessages` drops assistant tool-call messages after the first pair

The old code only created a user-assistant pair when `pendingUser` was set. After the first pair consumed `pendingUser`, subsequent assistant messages (which are tool-call-only with empty text) were silently discarded. Cursor never saw prior tool execution context.

### Bug 2: All tool results collected globally, ignoring turn boundaries

Every `tool` message was pushed to a flat `toolResults[]` array, so the bridge resume path sent ALL tool results (including already-completed ones) as a batch.

## Changes (already in working tree, uncommitted)

All changes are in `src/cursor/cursor-proxy-internal.ts`:

1. **`parseMessages` rewritten** (lines 611-683): Separates trailing tool results (after last assistant) from history turns. Only trailing results are used for bridge resume.

2. **`ConversationTurn` interface** added with `hasToolCalls` field so tool-call-only assistant messages are tracked.

3. **`buildCursorRequest`** (line 761): Creates `ConversationStep` for turns where `hasToolCalls` is true, even when `assistantText` is empty. Previously these were skipped entirely.

4. **`handleToolResultResume`** (lines 1591-1629): Properly maps `isError` tool results to `McpError` instead of `McpSuccess`.

5. **`is_error` field** added to `OpenAIMessage` interface for error propagation.

6. **`textContent` fix**: `p.text != null` instead of `p.text` for proper empty-string handling.

## Optional Enhancement

Add orphan-assistant handling for robustness when the bridge has died and we fall back to checkpoint-less rebuild. In `parseMessages`, when an assistant message has no preceding user (multi-tool-call chain), include it with empty user text:

```typescript
} else if (msg.role === "assistant") {
  const text = textContent(msg.content);
  const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
  if (pendingUser) {
    pairs.push({ userText: pendingUser, assistantText: text, hasToolCalls });
    pendingUser = "";
  } else if (hasToolCalls || text) {
    pairs.push({ userText: "", assistantText: text, hasToolCalls });
  }
}
```

This is low-priority since on the happy path (bridge alive), `turns` are not used for resume.

## Critical File

- `src/cursor/cursor-proxy-internal.ts` — the only file that needs changes

## Verification

1. `clc --model cursor/composer-2` — start proxy and connect with composer-2
2. Run `/init` — all tool calls (Read, Search, etc.) should complete with green dots
3. `ANYCLAUDE_DEBUG=2` — confirm each `mcpResult` is sent exactly once per tool call
4. Test a multi-step conversation with 3+ sequential tool calls to verify the full chain works
