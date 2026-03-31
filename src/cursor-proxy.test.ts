import { describe, test, expect } from "bun:test";
import { findAvailablePort, startCursorProxy } from "./cursor-proxy";

describe("findAvailablePort", () => {
  test("returns 0 for internal proxy", async () => {
    const port = await findAvailablePort();
    expect(port).toBe(0);
  });
});

describe("startCursorProxy", () => {
  test.skip("starts internal proxy and returns URL", async () => {
    // Skip - requires valid Cursor authentication
    const { url, stop } = await startCursorProxy();
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    await stop();
  });
});
