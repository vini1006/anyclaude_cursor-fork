/**
 * Stream event types for cursor-agent stream-json output
 * 
 * Note: cursor-agent sends events with a nested structure:
 * - assistant events have { message: { role: "assistant", content: [{ type: "text", text: "..." }] } }
 * - thinking events have { text: "...", subtype?: "delta" | "completed" }
 * - tool_call events have { name: "...", input: {...}, call_id?: "..." }
 */

export interface StreamJsonEventBase {
  type: string;
  session_id?: string;
  timestamp?: number;
  timestamp_ms?: number;
  subtype?: string;
}

export interface SystemEvent extends StreamJsonEventBase {
  type: "system";
  subtype: "init";
  apiKeySource?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  data?: Record<string, unknown>;
}

export interface UserEvent extends StreamJsonEventBase {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
}

export interface AssistantTextEvent extends StreamJsonEventBase {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
  };
}

export interface AssistantThinkingEvent extends StreamJsonEventBase {
  type: "thinking";
  subtype?: "delta" | "completed";
  text: string;
  signature?: string;
}

export interface ToolCallEvent extends StreamJsonEventBase {
  type: "tool_call";
  name: string;
  input: Record<string, unknown>;
  call_id?: string;
}

export interface ToolResultEvent extends StreamJsonEventBase {
  type: "tool_result";
  call_id: string;
  name: string;
  output: string;
  is_error?: boolean;
}

export interface ErrorEvent extends StreamJsonEventBase {
  type: "error";
  error: string;
  message?: string;
}

export interface DoneEvent extends StreamJsonEventBase {
  type: "done";
}

export interface ResultEvent extends StreamJsonEventBase {
  type: "result";
  subtype: "success" | "error";
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  request_id?: string;
}

/**
 * Union type of all possible stream events from cursor-agent
 */
export type StreamJsonEvent =
  | SystemEvent
  | UserEvent
  | AssistantTextEvent
  | AssistantThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | DoneEvent
  | ResultEvent;

/**
 * Type guard for assistant text events
 * Checks for assistant type with nested message.content structure
 */
export function isAssistantText(event: StreamJsonEvent): event is AssistantTextEvent {
  if (event.type !== "assistant") return false;
  const maybeAssistantEvent = event as Partial<AssistantTextEvent>;
  return (
    maybeAssistantEvent.message != null &&
    typeof maybeAssistantEvent.message === "object" &&
    "content" in maybeAssistantEvent.message &&
    Array.isArray(maybeAssistantEvent.message.content) &&
    maybeAssistantEvent.message.content.length > 0 &&
    typeof maybeAssistantEvent.message.content[0] === "object" &&
    maybeAssistantEvent.message.content[0]?.type === "text" &&
    typeof maybeAssistantEvent.message.content[0]?.text === "string"
  );
}

/**
 * Type guard for thinking events
 */
export function isThinking(event: StreamJsonEvent): event is AssistantThinkingEvent {
  return event.type === "thinking" && typeof (event as AssistantThinkingEvent).text === "string";
}

/**
 * Type guard for tool call events
 */
export function isToolCall(event: StreamJsonEvent): event is ToolCallEvent {
  return event.type === "tool_call" && "name" in event && "input" in event;
}

/**
 * Type guard for tool result events
 */
export function isToolResult(event: StreamJsonEvent): event is ToolResultEvent {
  return event.type === "tool_result" && "call_id" in event && "output" in event;
}

/**
 * Type guard for error events
 */
export function isError(event: StreamJsonEvent): event is ErrorEvent {
  return event.type === "error";
}

/**
 * Extract text content from an assistant text event
 * Extracts from nested message.content[0].text structure
 */
export function extractText(event: AssistantTextEvent): string {
  if (!event.message?.content?.[0]?.text) {
    return "";
  }
  return event.message.content[0].text;
}

/**
 * Extract thinking content from a thinking event
 */
export function extractThinking(event: AssistantThinkingEvent): string {
  return event.text || "";
}
