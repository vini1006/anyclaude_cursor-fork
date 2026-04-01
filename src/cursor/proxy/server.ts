import { createServer, type Server } from "node:net";
import { debug } from "../../debug.js";
import type { ProxyConfig, ProxyServer } from "./types.js";
import { parseOpenAIRequest, messagesToPrompt, validateRequest } from "./handler.js";
import {
  createChatCompletionResponse,
  createChatCompletionChunk,
  createDoneChunk,
  createErrorResponse,
} from "./formatter.js";
import { SimpleCursorClient } from "../cursor-client.js";
import {
  isAssistantText,
  isThinking,
  isToolCall,
  extractText,
  extractThinking,
} from "../streaming/types.js";
import { sseToOpenAIChunk, createDoneSSE } from "../streaming/openai-sse.js";

const DEFAULT_PORT = 32125;
const PORT_RANGE_SIZE = 256;

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    server.listen({ port, host }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Find an available port in the range
 */
export async function findAvailablePort(
  host = "127.0.0.1"
): Promise<number> {
  const minPort = DEFAULT_PORT;
  const maxPort = DEFAULT_PORT + PORT_RANGE_SIZE;

  for (let p = minPort; p < maxPort; p++) {
    if (await isPortAvailable(p, host)) {
      return p;
    }
  }

  throw new Error(`No available port in range ${minPort}-${maxPort - 1}`);
}

/**
 * Create a proxy server that translates OpenAI API to cursor-agent stream-json
 */
export function createProxyServer(config: ProxyConfig = {}): ProxyServer {
  const requestedPort = config.port ?? 0;
  const host = config.host ?? "127.0.0.1";
  const healthCheckPath = config.healthCheckPath ?? "/health";

  let server: any = null;
  let baseURL = "";
  const client = new SimpleCursorClient();

  const bunAny = (globalThis as any).Bun;

  if (!bunAny || typeof bunAny.serve !== "function") {
    throw new Error(
      "Proxy server requires Bun runtime. Please run with Bun."
    );
  }

  const tryStart = (port: number): { success: boolean; error?: Error } => {
    try {
      server = bunAny.serve({
        port,
        hostname: host,
        idleTimeout: 120, // 2 minutes - cursor-agent can take time for complex requests
        fetch: async (request: Request): Promise<Response> => {
          const url = new URL(request.url);
          const path = url.pathname;
          const method = request.method;

          // Health check
          if (path === healthCheckPath && method === "GET") {
            return Response.json({ ok: true });
          }

          // Models endpoint
          if (path === "/v1/models" && method === "GET") {
            const models = await client.getAvailableModels();
            return Response.json({
              object: "list",
              data: models.map((m) => ({
                id: `cursor/${m.id}`,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "cursor",
              })),
            });
          }

          // Chat completions endpoint
          if (path === "/v1/chat/completions" && method === "POST") {
            try {
              const body = await request.json();
              const parsed = parseOpenAIRequest(body);
              const validationError = validateRequest(body as any);

              if (validationError) {
                return Response.json(createErrorResponse(validationError, "invalid_request", 400), {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                });
              }

              const prompt = messagesToPrompt(parsed.messages);
              const model = parsed.model.replace(/^cursor\//, "") || "auto";

              debug(2, "Chat completions request", {
                model,
                promptLength: prompt.length,
                stream: parsed.stream,
                cwd: process.cwd(),
              });

              if (parsed.stream) {
                // Streaming response
                const stream = client.executePromptStream(prompt, {
                  model,
                  cwd: process.cwd(),
                });

                debug(2, "Stream started", { model });

                const encoder = new TextEncoder();
                const readable = new ReadableStream({
                  async start(controller) {
                    try {
                      let hasContent = false;
                      let toolCalls: any[] = [];
                      let lastSentText = "";

                      for await (const event of stream) {
                        if (isAssistantText(event)) {
                          hasContent = true;
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
                              const chunk = createChatCompletionChunk(
                                { role: "assistant", content: delta },
                                model
                              );
                              controller.enqueue(
                                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                              );
                            }
                          }
                        } else if (isThinking(event)) {
                          // Skip thinking/reasoning content - don't send to client
                          // Thinking content is for internal use only
                          continue;
                        } else if (isToolCall(event)) {
                          const toolCall = {
                            id: event.call_id || `tool-${Date.now()}`,
                            type: "function" as const,
                            function: {
                              name: event.name,
                              arguments: JSON.stringify(event.input),
                            },
                          };
                          toolCalls.push(toolCall);
                          
                          const chunk = createChatCompletionChunk(
                            { role: "assistant", tool_calls: [toolCall] },
                            model
                          );
                          controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                          );
                        }
                      }

                      // Send final chunk
                      controller.enqueue(
                        encoder.encode(createDoneSSE(model))
                      );
                      controller.close();
                    } catch (error) {
                      debug(1, "Stream error", { error: (error as Error).message, stack: (error as Error).stack });
                      controller.error(error);
                    }
                  },
                });

                return new Response(readable, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                  },
                });
              } else {
                // Non-streaming response
                try {
                  const result = await client.executePrompt(prompt, { model });

                  return Response.json(
                    createChatCompletionResponse(result.content, model),
                    {
                      headers: { "Content-Type": "application/json" },
                    }
                  );
                } catch (error) {
                  debug(1, "Non-streaming prompt error", { error: (error as Error).message, stack: (error as Error).stack });
                  throw error;
                }
              }
            } catch (error) {
              debug(1, "Chat completions error", { error: (error as Error).message });
              return Response.json(
                createErrorResponse((error as Error).message, "server_error", 500),
                {
                  status: 500,
                  headers: { "Content-Type": "application/json" },
                }
              );
            }
          }

          // Not found
          return new Response("Not Found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        },
      });
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const isPortInUse =
        err.message.includes("EADDRINUSE") ||
        err.message.includes("address already in use");
      if (!isPortInUse) {
        debug(1, `Unexpected error starting on port ${port}: ${err.message}`);
      }
      return { success: false, error: err };
    }
  };

  return {
    async start(): Promise<string> {
      if (server) {
        return baseURL;
      }

      let port: number;
      if (requestedPort > 0) {
        const result = tryStart(requestedPort);
        if (result.success) {
          port = requestedPort;
        } else {
          debug(1, `Port ${requestedPort} unavailable, finding alternative`);
          port = await findAvailablePort(host);
          const fallbackResult = tryStart(port);
          if (!fallbackResult.success) {
            throw new Error(
              `Failed to start server: ${fallbackResult.error?.message}`
            );
          }
        }
      } else {
        port = await findAvailablePort(host);
        const result = tryStart(port);
        if (!result.success) {
          throw new Error(`Failed to start server: ${result.error?.message}`);
        }
      }

      const actualPort = server.port ?? port ?? DEFAULT_PORT;
      baseURL = `http://${host}:${actualPort}`;
      debug(1, `Proxy server started`, { url: baseURL });
      return baseURL;
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      server.stop(true);
      server = null;
      baseURL = "";
    },

    getBaseURL(): string {
      return baseURL;
    },
  };
}
