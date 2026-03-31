import { describe, test, expect } from "bun:test";
import { generatePKCE, buildLoginUrl } from "./cursor-auth";

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
    const params = {
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
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }

    // Should not exceed max delay
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(10000);
  });
});
