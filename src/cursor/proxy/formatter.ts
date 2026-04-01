import type { ChatCompletionResponse, ChatCompletionChunk, OpenAIToolCall } from "./types.js";

/**
 * Create a complete chat completion response
 */
export function createChatCompletionResponse(
  content: string,
  model: string,
  toolCalls?: OpenAIToolCall[]
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
  };
}

/**
 * Create a streaming chat completion chunk
 */
export function createChatCompletionChunk(
  delta: {
    role?: string;
    content?: string;
    tool_calls?: OpenAIToolCall[];
  },
  model: string,
  finishReason: string | null = null
): ChatCompletionChunk {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Create the final [DONE] chunk for streaming
 */
export function createDoneChunk(): string {
  return "data: [DONE]\n\n";
}

/**
 * Create an error response
 */
export function createErrorResponse(
  message: string,
  type: string = "api_error",
  statusCode: number = 500
): { error: { message: string; type: string; code: string } } {
  return {
    error: {
      message,
      type,
      code: `status_${statusCode}`,
    },
  };
}
