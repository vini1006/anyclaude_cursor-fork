import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { TokenManager } from "./token-manager.js";
import { debug } from "./debug.js";
import { SimpleCursorClient } from "./cursor/cursor-client.js";
import {
  isAssistantText,
  isThinking,
  isToolCall,
  extractText,
  extractThinking,
} from "./cursor/streaming/types.js";

export interface CursorProviderOptions {
  mode?: "direct" | "proxy";
  proxyBaseUrl?: string;
}

/**
 * Create a Cursor provider for AI SDK
 * Supports both direct mode (spawns cursor-agent) and proxy mode (HTTP proxy)
 */
export function createCursorProvider(
  options: CursorProviderOptions = {}
): {
  languageModel: (modelId: string) => ReturnType<OpenAIProvider["chat"]>;
} {
  const mode = options.mode || "proxy";

  if (mode === "direct") {
    return createDirectCursorProvider();
  } else {
    return createProxyCursorProvider(options.proxyBaseUrl);
  }
}

/**
 * Direct mode: Spawns cursor-agent directly for each request
 */
function createDirectCursorProvider(): {
  languageModel: (modelId: string) => any;
} {
  const client = new SimpleCursorClient();

  return {
    languageModel: (modelId: string) => {
      const cursorModelId = modelId.replace(/^cursor\//, "");
      debug(1, `Cursor provider (direct): ${modelId} -> ${cursorModelId}`);

      return {
        modelId,
        provider: "cursor",

        async doGenerate(options: any = {}) {
          // Extract prompt from messages
          let prompt = "";
          if (options.prompt) {
            if (Array.isArray(options.prompt)) {
              const lines = options.prompt
                .filter((msg: any) => msg?.content)
                .map((msg: any) => `${msg.role || "user"}: ${msg.content}`);
              prompt = lines.join("\n\n");
            } else if (typeof options.prompt === "string") {
              prompt = options.prompt;
            }
          } else if (options.messages) {
            const messages = Array.isArray(options.messages)
              ? options.messages
              : [];
            const lines = messages
              .filter((msg: any) => msg?.content)
              .map((msg: any) => `${msg.role || "user"}: ${msg.content}`);
            prompt = lines.join("\n\n");
          }

          if (!prompt) {
            prompt = "Hello";
          }

          const result = await client.executePrompt(prompt, {
            model: cursorModelId,
          });

          return {
            text: result.content || "No response",
            finishReason: result.done ? "stop" : "other",
            usage: {
              promptTokens: 0,
              completionTokens: 0,
            },
          };
        },

        async doStream(options: any = {}) {
          // Extract prompt from messages
          let prompt = "";
          if (options.prompt) {
            if (Array.isArray(options.prompt)) {
              const lines = options.prompt
                .filter((msg: any) => msg?.content)
                .map((msg: any) => `${msg.role || "user"}: ${msg.content}`);
              prompt = lines.join("\n\n");
            } else if (typeof options.prompt === "string") {
              prompt = options.prompt;
            }
          } else if (options.messages) {
            const messages = Array.isArray(options.messages)
              ? options.messages
              : [];
            const lines = messages
              .filter((msg: any) => msg?.content)
              .map((msg: any) => `${msg.role || "user"}: ${msg.content}`);
            prompt = lines.join("\n\n");
          }

          if (!prompt) {
            prompt = "Hello";
          }

          const stream = client.executePromptStream(prompt, {
            model: cursorModelId,
          });

          const readableStream = new ReadableStream({
            async start(controller) {
              try {
                let lastSentText = "";
                
                for await (const event of stream) {
                  if (isAssistantText(event)) {
                    const text = extractText(event);
                    
                    // cursor-agent sends each response twice:
                    // 1. First with timestamp_ms (the actual response)
                    // 2. Then without timestamp_ms (summary event - same text)
                    // We only want to send the first one
                    const hasTimestamp = (event as any).timestamp_ms !== undefined;
                    
                    if (!hasTimestamp) {
                      // Skip summary event (no timestamp_ms)
                      continue;
                    }
                    
                    if (text) {
                      // cursor-agent sends accumulated text, not deltas
                      // We need to send only the delta (new text since last chunk)
                      const delta = text.startsWith(lastSentText) 
                        ? text.slice(lastSentText.length)
                        : text;
                      lastSentText = text;
                      
                      if (delta) {
                        controller.enqueue({
                          type: "text-delta",
                          textDelta: delta,
                        });
                      }
                    }
                  } else if (isThinking(event)) {
                    // Skip thinking/reasoning content - don't send to client
                    // Thinking content is for internal use only
                    continue;
                  } else if (isToolCall(event)) {
                    // Tool calls in direct mode - emit as text for now
                    controller.enqueue({
                      type: "text-delta",
                      textDelta: `[tool_call: ${event.name}]`,
                    });
                  }
                }
                controller.enqueue({ type: "text-delta", textDelta: "" });
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          });

          return {
            stream: readableStream,
            rawResponse: { headers: {} },
          };
        },
      };
    },
  };
}

/**
 * Proxy mode: Uses HTTP proxy with OpenAI-compatible API
 */
function createProxyCursorProvider(proxyBaseUrl?: string): {
  languageModel: (modelId: string) => ReturnType<OpenAIProvider["chat"]>;
} {
  const tokenManager = new TokenManager();

  return {
    languageModel: (modelId: string) => {
      const cursorModelId = modelId.replace(/^cursor\//, "");
      const baseUrl = proxyBaseUrl || "http://localhost:32125";
      debug(1, `Cursor provider (proxy: ${baseUrl}): ${modelId} -> ${cursorModelId}`);

      const openaiProvider = createOpenAI({
        apiKey: "cursor-proxy",
        baseURL: `${baseUrl}/v1`,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          try {
            const accessToken = await tokenManager.getValidAccessToken();

            const headers = new Headers(
              (init?.headers as Record<string, string>) || {}
            );
            headers.set("Authorization", `Bearer ${accessToken}`);

            return globalThis.fetch(url, { ...init, headers });
          } catch (error) {
            debug(1, `Cursor provider error: ${(error as Error).message}`);
            throw error;
          }
        }) as any,
      });

      return openaiProvider.chat(cursorModelId);
    },
  };
}

/**
 * Create Cursor provider with explicit base URL (for proxy mode)
 */
export function createCursorProviderWithBaseUrl(
  baseUrl: string
): {
  languageModel: (modelId: string) => ReturnType<OpenAIProvider["chat"]>;
} {
  return createProxyCursorProvider(baseUrl);
}
