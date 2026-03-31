import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  generatePKCE,
  buildLoginUrl,
  parseTokenExpiry,
  pollForTokens,
  setSleepImplementation,
  clearSleepImplementation,
  type PKCEParams,
} from "./cursor-auth";

describe("generatePKCE", () => {
  test("generates valid PKCE parameters", async () => {
    const pkce = await generatePKCE();

    expect(pkce.verifier).toBeDefined();
    expect(pkce.challenge).toBeDefined();
    expect(pkce.uuid).toBeDefined();

    // Verifier should be base64url encoded
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);

    // Challenge should be base64url encoded
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // UUID should be valid format
    expect(pkce.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test("generates different values each time", async () => {
    const pkce1 = await generatePKCE();
    const pkce2 = await generatePKCE();

    expect(pkce1.verifier).not.toBe(pkce2.verifier);
    expect(pkce1.challenge).not.toBe(pkce2.challenge);
    expect(pkce1.uuid).not.toBe(pkce2.uuid);
  });
});

describe("buildLoginUrl", () => {
  test("builds correct login URL", () => {
    const params: PKCEParams = {
      verifier: "test_verifier",
      challenge: "test_challenge",
      uuid: "test-uuid-123",
    };

    const url = buildLoginUrl(params);

    expect(url).toContain("https://cursor.com/loginDeepControl");
    expect(url).toContain("challenge=test_challenge");
    expect(url).toContain("uuid=test-uuid-123");
    expect(url).toContain("mode=login");
    expect(url).toContain("redirectTarget=cli");
  });

  test("URL encodes special characters in parameters", () => {
    const params: PKCEParams = {
      verifier: "test_verifier",
      challenge: "test+challenge/with=special&chars",
      uuid: "test-uuid-123",
    };

    const url = buildLoginUrl(params);
    expect(url).toContain(
      "challenge=test%2Bchallenge%2Fwith%3Dspecial%26chars"
    );
  });
});

describe("parseTokenExpiry", () => {
  test("parses valid JWT with exp claim", () => {
    // Create a valid JWT with exp claim (exp is in seconds)
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ exp: futureExp, sub: "user123" })
    ).toString("base64url");
    const signature = "fake-signature";
    const token = `${header}.${payload}.${signature}`;

    const expiry = parseTokenExpiry(token);

    // Should be exp * 1000 - 5 minutes safety margin
    const expectedExpiry = futureExp * 1000 - 5 * 60 * 1000;
    expect(expiry).toBeCloseTo(expectedExpiry, -2); // Allow 100ms tolerance
  });

  test("returns default expiry for invalid JWT format", () => {
    const invalidToken = "not.a.valid.jwt";
    const expiry = parseTokenExpiry(invalidToken);

    // Should return default: Date.now() + 1 hour - 5 minutes
    const expectedDefault = Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
    expect(expiry).toBeCloseTo(expectedDefault, -2);
  });

  test("returns default expiry for JWT without exp claim", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "user123", name: "Test" })
    ).toString("base64url");
    const signature = "fake-signature";
    const token = `${header}.${payload}.${signature}`;

    const expiry = parseTokenExpiry(token);

    const expectedDefault = Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
    expect(expiry).toBeCloseTo(expectedDefault, -2);
  });

  test("returns default expiry for malformed base64", () => {
    const header = "invalid-base64!@#";
    const payload = "also-invalid$$$";
    const signature = "fake";
    const token = `${header}.${payload}.${signature}`;

    const expiry = parseTokenExpiry(token);

    const expectedDefault = Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
    expect(expiry).toBeCloseTo(expectedDefault, -2);
  });

  test("returns default expiry for non-JSON payload", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
      "base64url"
    );
    const payload = Buffer.from("not-json-string").toString("base64url");
    const signature = "fake";
    const token = `${header}.${payload}.${signature}`;

    const expiry = parseTokenExpiry(token);

    const expectedDefault = Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
    expect(expiry).toBeCloseTo(expectedDefault, -2);
  });
});

describe("pollForTokens", () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof mock> | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Mock sleep to resolve immediately for fast tests
    setSleepImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearSleepImplementation();
    if (fetchMock) {
      fetchMock.mockRestore();
    }
  });

  test("succeeds on first attempt with 200 response", async () => {
    const mockTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    };

    fetchMock = mock(((url: string) =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve(mockTokens),
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const result = await pollForTokens("test-uuid", "test-verifier");

    expect(result.accessToken).toBe("mock-access-token");
    expect(result.refreshToken).toBe("mock-refresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("succeeds after multiple 404 responses", async () => {
    const mockTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    };

    let callCount = 0;
    fetchMock = mock(((url: string) => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          status: 404,
          statusText: "Not Found",
        } as Response);
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve(mockTokens),
      } as Response);
    }) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const result = await pollForTokens("test-uuid", "test-verifier");

    expect(result.accessToken).toBe("mock-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("times out after max attempts with 404 responses", async () => {
    fetchMock = mock((() =>
      Promise.resolve({
        status: 404,
        statusText: "Not Found",
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(pollForTokens("test-uuid", "test-verifier")).rejects.toThrow(
      "Authentication timeout after 150 attempts"
    );
  });

  test("handles non-200/404 error responses", async () => {
    fetchMock = mock((() =>
      Promise.resolve({
        status: 500,
        statusText: "Internal Server Error",
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(pollForTokens("test-uuid", "test-verifier")).rejects.toThrow(
      "Unexpected response status: 500"
    );
  });

  test("handles fetch network errors", async () => {
    fetchMock = mock((() =>
      Promise.reject(new Error("Network error"))) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    // Network errors cause immediate throw on first attempt
    await expect(pollForTokens("test-uuid", "test-verifier")).rejects.toThrow(
      "Network error"
    );
  });

  test("handles incomplete token response (missing accessToken)", async () => {
    fetchMock = mock((() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ refreshToken: "only-refresh" }),
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(pollForTokens("test-uuid", "test-verifier")).rejects.toThrow(
      "Authentication timeout"
    );
  });

  test("handles incomplete token response (missing refreshToken)", async () => {
    fetchMock = mock((() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ accessToken: "only-access" }),
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(pollForTokens("test-uuid", "test-verifier")).rejects.toThrow(
      "Authentication timeout"
    );
  });
});

describe("CURSOR_API_URL environment variable", () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof mock> | undefined;
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalApiUrl = process.env.CURSOR_API_URL;
    // Mock sleep to resolve immediately for fast tests
    setSleepImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearSleepImplementation();
    if (fetchMock) {
      fetchMock.mockRestore();
    }
    if (originalApiUrl !== undefined) {
      process.env.CURSOR_API_URL = originalApiUrl;
    } else {
      delete process.env.CURSOR_API_URL;
    }
  });

  test("uses default API URL when CURSOR_API_URL is not set", async () => {
    delete process.env.CURSOR_API_URL;

    const mockTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    };

    fetchMock = mock((() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve(mockTokens),
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await pollForTokens("test-uuid", "test-verifier");

    const callArg = fetchMock!.mock.calls[0]![0] as string;
    expect(callArg).toContain("https://api2.cursor.sh/auth/poll");
  });

  test("uses custom API URL when CURSOR_API_URL is set", async () => {
    process.env.CURSOR_API_URL = "https://custom.cursor.api";

    const mockTokens = {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    };

    fetchMock = mock((() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve(mockTokens),
      } as Response)) as unknown as typeof fetch);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await pollForTokens("test-uuid", "test-verifier");

    const callArg = fetchMock!.mock.calls[0]![0] as string;
    expect(callArg).toContain("https://custom.cursor.api/auth/poll");
  });
});

describe("poll backoff", () => {
  test("calculates correct backoff delays", () => {
    const baseDelay = 1000;
    const maxDelay = 10000;
    const backoffMultiplier = 1.2;

    let delay = baseDelay;
    const delays: number[] = [];

    for (let i = 0; i < 10; i++) {
      delays.push(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }

    // First delay should be base delay
    expect(delays[0]).toBe(1000);

    // Delays should increase
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }

    // Should not exceed max delay
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(10000);
  });

  test("reaches max delay after sufficient iterations", () => {
    const baseDelay = 1000;
    const maxDelay = 10000;
    const backoffMultiplier = 1.2;

    let delay = baseDelay;
    let iterations = 0;

    while (delay < maxDelay) {
      delay = Math.min(delay * backoffMultiplier, maxDelay);
      iterations++;
    }

    // Should reach max delay within reasonable iterations
    expect(iterations).toBeLessThan(20);
    expect(delay).toBe(maxDelay);
  });
});
