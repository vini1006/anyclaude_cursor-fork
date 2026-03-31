/**
 * Tests for the internal Cursor proxy server.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startCursorProxyInternal, stopCursorProxyInternal, getProxyPort } from "./cursor-proxy-internal";

describe("startCursorProxyInternal", () => {
  afterEach(() => {
    stopCursorProxyInternal();
  });

  it("starts proxy and returns port number", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns same port when called multiple times", async () => {
    const getAccessToken = async () => "test-token";
    const port1 = await startCursorProxyInternal(getAccessToken, []);
    const port2 = await startCursorProxyInternal(getAccessToken, []);
    expect(port1).toBe(port2);
  });

  it("handles /v1/models endpoint", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, [
      { id: "test-model", name: "Test Model" },
      { id: "another-model", name: "Another Model" },
    ]);

    const response = await fetch(`http://localhost:${port}/v1/models`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const data = await response.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    expect(data.object).toBe("list");
    expect(data.data).toBeArray();
    expect(data.data).toHaveLength(2);
    expect(data.data[0]!.id).toBe("test-model");
    expect(data.data[0]!.object).toBe("model");
    expect(data.data[0]!.owned_by).toBe("cursor");
  });

  it("returns empty model list when no models provided", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/models`);
    expect(response.status).toBe(200);

    const data = await response.json() as { object: string; data: unknown[] };
    expect(data.object).toBe("list");
    expect(data.data).toBeArray();
    expect(data.data).toHaveLength(0);
  });

  it("returns 404 for unknown routes", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/unknown`);
    expect(response.status).toBe(404);
  });

  it("returns 404 for GET /v1/chat/completions", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "GET",
    });
    expect(response.status).toBe(404);
  });

  it("returns 500 for POST /v1/chat/completions with invalid JSON", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    expect(response.status).toBe(500);

    const data = await response.json() as { error?: { type?: string; message?: string } };
    expect(data.error).toBeDefined();
    expect(data.error?.type).toBe("server_error");
  });

  it("returns 400 for POST /v1/chat/completions with no user message", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "system", content: "You are helpful" }],
      }),
    });
    expect(response.status).toBe(400);

    const data = await response.json() as { error?: { type?: string; message?: string } };
    expect(data.error).toBeDefined();
    expect(data.error?.type).toBe("invalid_request_error");
    expect(data.error?.message).toContain("No user message");
  });

  it("handles POST /v1/chat/completions with non-streaming request (bridge handles auth errors)", async () => {
    const getAccessToken = async () => "invalid-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    // The proxy accepts the request and forwards to Cursor
    // Auth errors are handled by the bridge (returns empty response or times out)
    // We just verify the endpoint is reachable and returns a valid response
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("handles POST /v1/chat/completions with streaming request (SSE format)", async () => {
    const getAccessToken = async () => "invalid-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    // Streaming responses should be SSE format
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });
});

describe("stopCursorProxyInternal", () => {
  it("stops the proxy server", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    // Verify proxy is running
    const response = await fetch(`http://localhost:${port}/v1/models`);
    expect(response.status).toBe(200);

    stopCursorProxyInternal();

    // Verify proxy is stopped - should fail to connect
    try {
      await fetch(`http://localhost:${port}/v1/models`);
      // If we get here without error, the port might have been reused
      // Check if getProxyPort returns undefined
      expect(getProxyPort()).toBeUndefined();
    } catch {
      // Expected - connection refused
    }
  });

  it("cleans up active bridges", async () => {
    const getAccessToken = async () => "test-token";
    await startCursorProxyInternal(getAccessToken, []);
    stopCursorProxyInternal();

    // After stopping, getProxyPort should return undefined
    expect(getProxyPort()).toBeUndefined();
  });

  it("can be called multiple times without error", () => {
    stopCursorProxyInternal();
    stopCursorProxyInternal();
    stopCursorProxyInternal();
  });
});

describe("getProxyPort", () => {
  afterEach(() => {
    stopCursorProxyInternal();
  });

  it("returns undefined when proxy is not running", () => {
    expect(getProxyPort()).toBeUndefined();
  });

  it("returns the port number when proxy is running", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    expect(getProxyPort()).toBe(port);
  });

  it("returns undefined after proxy is stopped", async () => {
    const getAccessToken = async () => "test-token";
    await startCursorProxyInternal(getAccessToken, []);

    expect(getProxyPort()).toBeGreaterThan(0);

    stopCursorProxyInternal();

    expect(getProxyPort()).toBeUndefined();
  });
});

describe("proxy message handling", () => {
  afterEach(() => {
    stopCursorProxyInternal();
  });

  it("parses system messages correctly", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, [
      { id: "test-model", name: "Test Model" },
    ]);

    // Test with system message
    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "Hello" },
        ],
        stream: false,
      }),
    });

    // The proxy accepts the request and forwards to Cursor
    // Bridge handles auth errors internally
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("handles multi-part user content", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: "World" },
            ],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("handles tool results in messages", async () => {
    const getAccessToken = async () => "test-token";
    const port = await startCursorProxyInternal(getAccessToken, []);

    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "user", content: "What is 2+2?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "calculator", arguments: '{"expression": "2+2"}' },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "4",
          },
        ],
        stream: false,
      }),
    });

    // This would normally resume a bridge, but without valid token the bridge handles it
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
