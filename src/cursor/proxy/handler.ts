import type { ChatCompletionRequest, ParsedRequest } from "./types.js";

/**
 * Parse OpenAI chat completion request to internal format
 */
export function parseOpenAIRequest(body: any): ParsedRequest {
  const model = body.model || "auto";
  const stream = body.stream === true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = body.tools;
  const tool_choice = body.tool_choice;
  const temperature = body.temperature;
  const max_tokens = body.max_tokens;

  return {
    model,
    messages,
    stream,
    tools,
    tool_choice,
    temperature,
    max_tokens,
  };
}

/**
 * Convert OpenAI messages to a simple text prompt
 * Filters out system messages and special commands that cursor-agent doesn't understand
 */
export function messagesToPrompt(
  messages: Array<{ role: string; content: any }>
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (!msg) continue;

    // Skip system messages - cursor-agent handles system context differently
    if (msg.role === "system") {
      continue;
    }

    const role = (msg.role || "user").toUpperCase();
    
    // Handle both string and array content
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content array
      content = msg.content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join(" ");
    }

    // Skip empty content
    if (!content) {
      continue;
    }

    // Pass through all user messages including Claude Code commands like /init, /help, etc.
    // These are legitimate commands that cursor-agent should handle
    lines.push(`${role}: ${content}`);
  }

  // If no user messages, provide a default prompt
  if (lines.length === 0) {
    return "Hello, how can I help you today?";
  }

  return lines.join("\n\n");
}

/**
 * Validate chat completion request
 * Note: We allow requests with only system messages, as they will be filtered
 * and replaced with a default prompt in messagesToPrompt
 */
export function validateRequest(request: ChatCompletionRequest): string | null {
  if (!request.messages || !Array.isArray(request.messages)) {
    return "Missing or invalid 'messages' field";
  }

  // Allow empty messages array - messagesToPrompt will provide a default
  if (request.messages.length === 0) {
    return null;
  }

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];
    if (!msg || !msg.role || typeof msg.role !== "string") {
      return `Message ${i}: missing or invalid 'role' field`;
    }

    if (!["system", "user", "assistant", "tool"].includes(msg.role)) {
      return `Message ${i}: invalid role '${msg.role}'`;
    }
  }

  return null;
}
