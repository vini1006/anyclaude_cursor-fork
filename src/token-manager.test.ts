import { describe, test, expect, mock, afterEach } from "bun:test";
import { TokenManager } from "./token-manager";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), "anyclaude-token-tests");

describe("TokenManager", () => {
  afterEach(async () => {
    // Clean up test files
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("loadTokens()", () => {
    test("returns null when file doesn't exist", async () => {
      const manager = new TokenManager(join(testDir, "nonexistent.json"));
      const result = await manager.loadTokens();
      expect(result).toBeNull();
    });

    test("returns null when file contains invalid JSON", async () => {
      const tokenPath = join(testDir, "invalid.json");
      await mkdir(testDir, { recursive: true });
      await writeFile(tokenPath, "not valid json");

      const manager = new TokenManager(tokenPath);
      const result = await manager.loadTokens();
      expect(result).toBeNull();
    });

    test("returns null when accessToken field is missing", async () => {
      const tokenPath = join(testDir, "missing-access.json");
      await mkdir(testDir, { recursive: true });
      await writeFile(tokenPath, JSON.stringify({
        refreshToken: "some_refresh_token",
      }));

      const manager = new TokenManager(tokenPath);
      const result = await manager.loadTokens();
      expect(result).toBeNull();
    });

    test("returns null when refreshToken field is missing", async () => {
      const tokenPath = join(testDir, "missing-refresh.json");
      await mkdir(testDir, { recursive: true });
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "some_access_token",
      }));

      const manager = new TokenManager(tokenPath);
      const result = await manager.loadTokens();
      expect(result).toBeNull();
    });

    test("returns valid tokens when file is valid", async () => {
      const tokenPath = join(testDir, "valid.json");
      await mkdir(testDir, { recursive: true });
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "valid_access_token",
        refreshToken: "valid_refresh_token",
        expiresAt: Date.now() + 3600000,
      }));

      const manager = new TokenManager(tokenPath);
      const result = await manager.loadTokens();

      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe("valid_access_token");
      expect(result?.refreshToken).toBe("valid_refresh_token");
      expect(result?.expiresAt).toBeDefined();
    });

    test("returns valid tokens without expiresAt field", async () => {
      const tokenPath = join(testDir, "no-expires.json");
      await mkdir(testDir, { recursive: true });
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "valid_access_token",
        refreshToken: "valid_refresh_token",
      }));

      const manager = new TokenManager(tokenPath);
      const result = await manager.loadTokens();

      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe("valid_access_token");
      expect(result?.refreshToken).toBe("valid_refresh_token");
      expect(result?.expiresAt).toBeUndefined();
    });
  });

  describe("saveTokens()", () => {
    test("creates directory if it doesn't exist", async () => {
      const tokenPath = join(testDir, "nested", "path", "auth.json");
      const manager = new TokenManager(tokenPath);

      await manager.saveTokens({
        accessToken: "test_access",
        refreshToken: "test_refresh",
      });

      const content = await readFile(tokenPath, "utf-8");
      const data = JSON.parse(content);
      expect(data.accessToken).toBe("test_access");
      expect(data.refreshToken).toBe("test_refresh");
    });

    test("writes tokens with correct permissions", async () => {
      const tokenPath = join(testDir, "secure.json");
      const manager = new TokenManager(tokenPath);

      await manager.saveTokens({
        accessToken: "test_access",
        refreshToken: "test_refresh",
      });

      const stats = await Bun.file(tokenPath).stat();
      // Check that file permissions are 0o600 (owner read/write only)
      expect(stats.mode & 0o777).toBe(0o600);
    });

    test("writes tokens as valid JSON", async () => {
      const tokenPath = join(testDir, "output.json");
      const manager = new TokenManager(tokenPath);

      const tokens = {
        accessToken: "test_access",
        refreshToken: "test_refresh",
        expiresAt: 1234567890,
      };

      await manager.saveTokens(tokens);

      const content = await readFile(tokenPath, "utf-8");
      const data = JSON.parse(content);
      expect(data).toEqual(tokens);
    });
  });

  describe("refreshTokens()", () => {
    afterEach(() => {
      // Restore original fetch
      global.fetch = originalFetch;
    });

    const originalFetch = global.fetch;

    test("throws error when refreshToken is null", async () => {
      const manager = new TokenManager();
      await expect(manager.refreshTokens(null as any)).rejects.toThrow("Invalid refresh token");
    });

    test("throws error when refreshToken is undefined", async () => {
      const manager = new TokenManager();
      await expect(manager.refreshTokens(undefined as any)).rejects.toThrow("Invalid refresh token");
    });

    test("throws error when refreshToken is empty string", async () => {
      const manager = new TokenManager();
      await expect(manager.refreshTokens("")).rejects.toThrow("Invalid refresh token");
    });

    test("throws error when refreshToken is not a string", async () => {
      const manager = new TokenManager();
      await expect(manager.refreshTokens(123 as any)).rejects.toThrow("Invalid refresh token");
    });

    test("succeeds with valid response", async () => {
      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: "new_access_token",
          refreshToken: "new_refresh_token",
        }),
      } as Response));

      const manager = new TokenManager();
      const result = await manager.refreshTokens("valid_refresh_token");

      expect(result.accessToken).toBe("new_access_token");
      expect(result.refreshToken).toBe("new_refresh_token");
    });

    test("throws error when API returns error", async () => {
      global.fetch = mock(async () => ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response));

      const manager = new TokenManager();
      await expect(manager.refreshTokens("invalid_token")).rejects.toThrow("Token refresh failed: 401");
    });

    test("uses custom refresh URL from environment", async () => {
      const customUrl = "https://custom.example.com/refresh";
      const originalEnv = process.env.CURSOR_REFRESH_URL;
      process.env.CURSOR_REFRESH_URL = customUrl;

      let capturedUrl: string | undefined;
      global.fetch = mock(async (url: any) => {
        capturedUrl = url as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accessToken: "new_access_token",
            refreshToken: "new_refresh_token",
          }),
        } as Response;
      });

      const manager = new TokenManager();
      await manager.refreshTokens("valid_token");

      expect(capturedUrl).toBe(customUrl);

      // Restore
      if (originalEnv) {
        process.env.CURSOR_REFRESH_URL = originalEnv;
      } else {
        delete process.env.CURSOR_REFRESH_URL;
      }
    });
  });

  describe("parseTokenExpiry()", () => {
    test("returns 0 for invalid JWT format", () => {
      const manager = new TokenManager();
      const result = manager.parseTokenExpiry("not.a.jwt");
      expect(result).toBe(0);
    });

    test("returns 0 for non-JWT string", () => {
      const manager = new TokenManager();
      const result = manager.parseTokenExpiry("invalid");
      expect(result).toBe(0);
    });

    test("returns 0 for empty string", () => {
      const manager = new TokenManager();
      const result = manager.parseTokenExpiry("");
      expect(result).toBe(0);
    });

    test("returns 0 when exp claim is missing", () => {
      // Create a JWT with no exp claim
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
      const payload = Buffer.from(JSON.stringify({ sub: "1234567890", name: "Test" })).toString("base64");
      const signature = Buffer.from("signature").toString("base64");
      const token = `${header}.${payload}.${signature}`;

      const manager = new TokenManager();
      const result = manager.parseTokenExpiry(token);
      expect(result).toBe(0);
    });

    test("returns correct expiry with safety margin for valid JWT", () => {
      // Create a JWT with exp claim (5 minutes from now)
      const expSeconds = Math.floor((Date.now() + 300000) / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
      const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64");
      const signature = Buffer.from("signature").toString("base64");
      const token = `${header}.${payload}.${signature}`;

      const manager = new TokenManager();
      const result = manager.parseTokenExpiry(token);

      // Should be exp - 5 minutes safety margin
      const expectedExpiry = expSeconds * 1000 - 5 * 60 * 1000;
      expect(result).toBe(expectedExpiry);
    });

    test("handles JWT with base64url padding correctly", () => {
      // Some JWTs may have padding issues
      const expSeconds = Math.floor(Date.now() / 1000) + 300;
      const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
      const payload = JSON.stringify({ exp: expSeconds });

      // Use base64url encoding (no padding)
      const headerB64 = Buffer.from(header).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const payloadB64 = Buffer.from(payload).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const signatureB64 = Buffer.from("signature").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

      const token = `${headerB64}.${payloadB64}.${signatureB64}`;

      const manager = new TokenManager();
      const result = manager.parseTokenExpiry(token);

      const expectedExpiry = expSeconds * 1000 - 5 * 60 * 1000;
      expect(result).toBe(expectedExpiry);
    });
  });

  describe("getValidAccessToken()", () => {
    afterEach(() => {
      global.fetch = originalFetch;
    });

    const originalFetch = global.fetch;

    test("returns null when no tokens exist", async () => {
      const manager = new TokenManager(join(testDir, "nonexistent.json"));
      const result = await manager.getValidAccessToken();
      expect(result).toBeNull();
    });

    test("returns cached token when valid and not expired", async () => {
      const tokenPath = join(testDir, "valid.json");
      await mkdir(testDir, { recursive: true });

      const futureExpiry = Date.now() + 3600000; // 1 hour from now
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "cached_token",
        refreshToken: "cached_refresh",
        expiresAt: futureExpiry,
      }));

      const manager = new TokenManager(tokenPath);
      const result = await manager.getValidAccessToken();

      expect(result).toBe("cached_token");
    });

    test("refreshes token when expired", async () => {
      const tokenPath = join(testDir, "expired.json");
      await mkdir(testDir, { recursive: true });

      const pastExpiry = Date.now() - 3600000; // 1 hour ago
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "old_token",
        refreshToken: "valid_refresh",
        expiresAt: pastExpiry,
      }));

      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: "new_token",
          refreshToken: "new_refresh",
        }),
      } as Response));

      const manager = new TokenManager(tokenPath);
      const result = await manager.getValidAccessToken();

      expect(result).toBe("new_token");

      // Verify tokens were saved
      const content = await readFile(tokenPath, "utf-8");
      const data = JSON.parse(content);
      expect(data.accessToken).toBe("new_token");
    });

    test("refreshes token when expiresAt is missing", async () => {
      const tokenPath = join(testDir, "no-expiry.json");
      await mkdir(testDir, { recursive: true });

      await writeFile(tokenPath, JSON.stringify({
        accessToken: "old_token",
        refreshToken: "valid_refresh",
      }));

      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: "new_token",
          refreshToken: "new_refresh",
        }),
      } as Response));

      const manager = new TokenManager(tokenPath);
      const result = await manager.getValidAccessToken();

      expect(result).toBe("new_token");
    });

    test("forces refresh when forceRefresh is true", async () => {
      const tokenPath = join(testDir, "force-refresh.json");
      await mkdir(testDir, { recursive: true });

      const futureExpiry = Date.now() + 3600000;
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "valid_token",
        refreshToken: "valid_refresh",
        expiresAt: futureExpiry,
      }));

      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: "refreshed_token",
          refreshToken: "new_refresh",
        }),
      } as Response));

      const manager = new TokenManager(tokenPath);
      const result = await manager.getValidAccessToken(true);

      expect(result).toBe("refreshed_token");
    });

    test("returns null when refresh fails", async () => {
      const tokenPath = join(testDir, "refresh-fail.json");
      await mkdir(testDir, { recursive: true });

      const pastExpiry = Date.now() - 3600000;
      await writeFile(tokenPath, JSON.stringify({
        accessToken: "old_token",
        refreshToken: "invalid_refresh",
        expiresAt: pastExpiry,
      }));

      global.fetch = mock(async () => ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response));

      const manager = new TokenManager(tokenPath);
      const result = await manager.getValidAccessToken();

      expect(result).toBeNull();
    });
  });
});
