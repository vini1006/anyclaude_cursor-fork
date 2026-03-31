import { describe, test, expect } from "bun:test";
import { getCursorStoragePath, TokenManager, type CursorTokens } from "./token-manager";
import * as os from "os";
import * as path from "path";

describe("getCursorStoragePath", () => {
  test("returns XDG_DATA_HOME path when env var is set", () => {
    const originalEnv = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/custom/data";
    expect(getCursorStoragePath()).toBe(
      "/custom/data/anyclaude/cursor-auth.json"
    );
    process.env.XDG_DATA_HOME = originalEnv;
  });

  test("returns default path when XDG_DATA_HOME is not set", () => {
    const originalEnv = process.env.XDG_DATA_HOME;
    delete process.env.XDG_DATA_HOME;
    const expected = path.join(
      os.homedir(),
      ".local",
      "share",
      "anyclaude",
      "cursor-auth.json"
    );
    expect(getCursorStoragePath()).toBe(expected);
    process.env.XDG_DATA_HOME = originalEnv;
  });
});

describe("TokenManager", () => {
  test("needsRefresh returns true when token is expired", () => {
    const manager = new TokenManager();
    const expiredTokens: CursorTokens = {
      accessToken: "test_access",
      refreshToken: "test_refresh",
      expires: Date.now() - 1000, // 1 second ago
    };
    expect(manager.needsRefresh(expiredTokens)).toBe(true);
  });

  test("needsRefresh returns false when token is valid", () => {
    const manager = new TokenManager();
    const validTokens: CursorTokens = {
      accessToken: "test_access",
      refreshToken: "test_refresh",
      expires: Date.now() + 60 * 60 * 1000, // 1 hour from now
    };
    expect(manager.needsRefresh(validTokens)).toBe(false);
  });

  test("needsRefresh returns true when token is within safety margin", () => {
    const manager = new TokenManager();
    const marginTokens: CursorTokens = {
      accessToken: "test_access",
      refreshToken: "test_refresh",
      expires: Date.now() + 2 * 60 * 1000, // 2 minutes from now
    };
    expect(manager.needsRefresh(marginTokens)).toBe(true);
  });
});
