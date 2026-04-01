import type { StreamJsonEvent } from "./types.js";

/**
 * Format a stream event as OpenAI-compatible SSE chunk
 */
export interface SSEChunk {
  type: "text-delta" | "thinking-delta" | "tool-call" | "done";
  data: string | object;
}

/**
 * Convert a cursor stream event to OpenAI SSE format
 */
export function formatEventAsSSE(event: StreamJsonEvent): SSEChunk[] {
  const chunks: SSEChunk[] = [];

  switch (event.type) {
    case "assistant":
      // Extract text from nested message.content[0].text structure
      const assistantText = event.message?.content?.[0]?.text;
      if (assistantText) {
        chunks.push({
          type: "text-delta",
          data: assistantText,
        });
      }
      break;

    case "thinking":
      if (event.text) {
        chunks.push({
          type: "thinking-delta",
          data: event.text,
        });
      }
      break;

    case "tool_call":
      chunks.push({
        type: "tool-call",
        data: {
          id: event.call_id || `tool-${Date.now()}`,
          type: "function",
          function: {
            name: event.name,
            arguments: JSON.stringify(event.input),
          },
        },
      });
      break;

    case "done":
      chunks.push({
        type: "done",
        data: "",
      });
      break;
  }

  return chunks;
}

/**
 * Convert SSE chunk to OpenAI API response format
 */
export function sseToOpenAIChunk(chunk: SSEChunk, model: string): string {
  const baseData: any = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: {} as any,
        finish_reason: null as string | null,
      },
    ],
  };

  switch (chunk.type) {
    case "text-delta":
      baseData.choices[0].delta = {
        role: "assistant",
        content: chunk.data as string,
      };
      break;

    case "thinking-delta":
      // Thinking content in OpenAI format (using reasoning field if supported)
      baseData.choices[0].delta = {
        role: "assistant",
        content: `[thinking: ${chunk.data as string}]`,
      };
      break;

    case "tool-call":
      baseData.choices[0].delta = {
        role: "assistant",
        tool_calls: [chunk.data as object],
      };
      break;

    case "done":
      baseData.choices[0].finish_reason = "stop";
      break;
  }

  return `data: ${JSON.stringify(baseData)}\n\n`;
}

/**
 * Create the final SSE chunk to signal stream end
 */
export function createDoneSSE(model: string): string {
  return `data: [DONE]\n\n`;
}
