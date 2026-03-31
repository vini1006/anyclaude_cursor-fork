import { describe, test, expect } from "bun:test";
import { findAvailablePort } from "./cursor-proxy";

describe("findAvailablePort", () => {
  test("finds an available port", async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe("startCursorProxy", () => {
  test.skip("starts proxy and returns URL", async () => {
    // Skip - requires opencode-cursor to be installed
    const { url, stop } = await startCursorProxy();
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    await stop();
  });
});
