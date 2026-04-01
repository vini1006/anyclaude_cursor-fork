import { spawn, type ChildProcess } from "child_process";
import { LineBuffer } from "./streaming/line-buffer.js";
import { parseStreamJsonLine } from "./streaming/parser.js";
import {
  type StreamJsonEvent,
  isAssistantText,
  extractText,
} from "./streaming/types.js";
import { debug } from "../debug.js";

export interface CursorClientConfig {
  timeout?: number;
  maxRetries?: number;
  streamOutput?: boolean;
  cursorAgentPath?: string;
}

export interface CursorResponse {
  content: string;
  done: boolean;
  error?: string;
}

/**
 * Simple cursor-agent client that uses stream-json output format
 */
export class SimpleCursorClient {
  private config: Required<CursorClientConfig>;

  constructor(config: CursorClientConfig = {}) {
    this.config = {
      timeout: 120000, // 2 minutes - cursor-agent can take time for complex requests
      maxRetries: 3,
      streamOutput: true,
      cursorAgentPath: process.env.CURSOR_AGENT_EXECUTABLE || "cursor-agent",
      ...config,
    };
  }

  /**
   * Execute a prompt and stream the response
   */
  async *executePromptStream(
    prompt: string,
    options: {
      cwd?: string;
      model?: string;
      mode?: "default" | "plan" | "ask";
      resumeId?: string;
    } = {}
  ): AsyncGenerator<StreamJsonEvent, void, unknown> {
    if (!prompt || typeof prompt !== "string") {
      throw new Error("Invalid prompt: must be a non-empty string");
    }

    const {
      cwd = process.cwd(),
      model = "auto",
      mode = "default",
      resumeId,
    } = options;

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--model",
      model,
    ];

    if (mode === "plan") {
      args.push("--plan");
    } else if (mode === "ask") {
      args.push("--mode", "ask");
    }

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    debug(2, "Executing prompt stream", {
      promptLength: prompt.length,
      mode,
      model,
      cwd,
    });

    const child = spawn(this.config.cursorAgentPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let processError: Error | null = null;
    const lineBuffer = new LineBuffer();

    // Write prompt to stdin when process is ready
    child.stdin.on("error", (error) => {
      debug(1, "stdin error", { error: error.message });
      processError = error;
    });

    if (prompt) {
      // Add newline at the end to signal end of input
      child.stdin.write(prompt + "\n", (err) => {
        if (err) {
          debug(1, "Failed to write prompt to stdin", { error: err.message });
          processError = err;
        }
        child.stdin.end();
      });
    } else {
      child.stdin.end();
    }

    // Handle stderr
    child.stderr.on("data", (data) => {
      const errorMsg = data.toString();
      debug(1, "cursor-agent stderr", { error: errorMsg });
      processError = new Error(errorMsg);
    });

    // Add timeout - kills process if it takes too long
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      processError = new Error(`Timeout after ${this.config.timeout}ms`);
    }, this.config.timeout);

    const streamEnded = new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code !== 0 && !processError) {
          debug(1, "cursor-agent exited with non-zero code", { code });
          processError = new Error(`cursor-agent exited with code ${code}`);
        }
        resolve(code);
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        debug(1, "cursor-agent process error", { error: error.message });
        processError = error;
        resolve(null);
      });
    });

    // Read stdout chunks and yield events as they arrive
    try {
      for await (const chunk of child.stdout) {
        const lines = lineBuffer.push(chunk);
        for (const line of lines) {
          const event = parseStreamJsonLine(line);
          if (event) {
            yield event;
          } else {
            debug(2, "Invalid JSON from cursor-agent", {
              line: line.substring(0, 100),
            });
          }
        }
      }
    } catch (error) {
      debug(1, "Stream read error", { error: (error as Error).message });
    }

    // Flush remaining lines
    for (const line of lineBuffer.flush()) {
      const event = parseStreamJsonLine(line);
      if (event) {
        yield event;
      }
    }

    // Wait for process to close (may already be closed)
    await streamEnded;

    if (processError) {
      throw processError;
    }
  }

  /**
   * Execute a prompt and return the complete response
   */
  async executePrompt(
    prompt: string,
    options: {
      cwd?: string;
      model?: string;
      mode?: "default" | "plan" | "ask";
      resumeId?: string;
    } = {}
  ): Promise<CursorResponse> {
    if (!prompt || typeof prompt !== "string") {
      throw new Error("Invalid prompt: must be a non-empty string");
    }

    const {
      cwd = process.cwd(),
      model = "auto",
      mode = "default",
      resumeId,
    } = options;

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--model",
      model,
    ];

    if (mode === "plan") {
      args.push("--plan");
    } else if (mode === "ask") {
      args.push("--mode", "ask");
    }

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    debug(2, "Executing prompt", {
      promptLength: prompt.length,
      mode,
      model,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cursorAgentPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let content = "";
      let stderrBuffer = "";
      let stdinError: Error | null = null;

      // Write prompt to stdin with error handling
      if (prompt) {
        // Add newline at the end to signal end of input
        child.stdin.write(prompt + "\n", (err) => {
          if (err) {
            debug(1, "Failed to write prompt to stdin", { error: err.message });
            stdinError = err;
          }
          child.stdin.end();
        });
      } else {
        child.stdin.end();
      }

      child.stdin.on("error", (error) => {
        debug(1, "stdin error", { error: error.message });
        stdinError = error;
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      child.stdout.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            const event = parseStreamJsonLine(line);
            if (event && isAssistantText(event)) {
              content += extractText(event);
            }
          }
        }
      });

      child.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          reject(
            new Error(
              `cursor-agent exited with code ${code}: ${stderrBuffer || "unknown error"}`
            )
          );
          return;
        }

        resolve({
          content,
          done: true,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Get list of available models from cursor-agent
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    // Fallback model list (cursor-agent doesn't expose model list via CLI)
    return [
      { id: "auto", name: "Cursor Agent Auto" },
      { id: "composer-2", name: "Composer 2" },
      { id: "claude-4.6-opus", name: "Claude 4.6 Opus" },
      { id: "claude-4.6-sonnet", name: "Claude 4.6 Sonnet" },
      { id: "claude-4.5-opus", name: "Claude 4.5 Opus" },
      { id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet" },
      { id: "gpt-5.4-high", name: "GPT-5.4 High" },
      { id: "gpt-5.4-medium", name: "GPT-5.4 Medium" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "grok", name: "Grok" },
    ];
  }

  /**
   * Validate cursor-agent installation
   */
  async validateInstallation(): Promise<boolean> {
    try {
      const testResponse = await this.executePrompt("test", { model: "auto" });
      return !!testResponse.content;
    } catch (error) {
      debug(1, "Cursor installation validation failed", {
        error: (error as Error).message,
      });
      return false;
    }
  }
}

/**
 * Factory function to create a SimpleCursorClient
 */
export function createSimpleCursorClient(
  config: CursorClientConfig = {}
): SimpleCursorClient {
  return new SimpleCursorClient(config);
}
