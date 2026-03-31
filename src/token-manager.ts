import { debug } from "./debug";
import { mkdir, writeFile, readFile, access } from "fs/promises";
import { dirname } from "path";
import { join } from "path";

const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export interface CursorCredentials {
  access: string;        // JWT access token
  refresh: string;       // Refresh token
  expires: number;       // Expiry timestamp (ms)
}

export interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  expires: number;
}

export interface TokenFile {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

export function getCursorStoragePath(): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".local",
    "share",
    "opencode",
    "auth.json"
  );
}

export class TokenManager {
  private tokenPath: string;

  constructor(tokenPath?: string) {
    this.tokenPath = tokenPath || join(
      process.env.HOME || process.env.USERPROFILE || "~",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
  }

  /**
   * Load tokens from the token file
   * @returns TokenFile if valid, null if file doesn't exist or is invalid
   */
  async loadTokens(): Promise<TokenFile | null> {
    try {
      await access(this.tokenPath);
    } catch {
      debug(2, `Token file not found: ${this.tokenPath}`);
      return null;
    }

    try {
      const content = await readFile(this.tokenPath, "utf-8");
      const data = JSON.parse(content);

      // Validate required fields
      if (!data.accessToken || !data.refreshToken) {
        debug(1, "Token file missing required fields");
        return null;
      }

      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
      };
    } catch (error) {
      debug(1, `Failed to load tokens: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Save tokens to the token file
   */
  async saveTokens(tokens: TokenFile): Promise<void> {
    try {
      const dir = dirname(this.tokenPath);
      await mkdir(dir, { recursive: true });
      await writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), {
        mode: 0o600, // Read/write for owner only
      });
      debug(2, `Tokens saved to ${this.tokenPath}`);
    } catch (error) {
      debug(1, `Failed to save tokens: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Refresh tokens using the refresh token
   * @param refreshToken - The refresh token to use
   * @returns New access and refresh tokens
   */
  async refreshTokens(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new Error('Invalid refresh token');
    }

    const url = process.env.CURSOR_REFRESH_URL || "https://api2.cursor.sh/auth/exchange_user_api_key";

    debug(2, `Refreshing tokens from ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${refreshToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      debug(1, `Token refresh failed: ${response.status} ${errorText}`);
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = await response.json() as { accessToken: string; refreshToken: string };
    debug(2, "Tokens refreshed successfully");

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  }

  /**
   * Parse the expiry time from a JWT token
   * @param token - The JWT access token
   * @returns Expiry timestamp in milliseconds, or 0 if parsing fails
   */
  parseTokenExpiry(token: string): number {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        debug(2, "Invalid JWT format");
        return 0;
      }

      const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf-8"));
      if (payload.exp) {
        const expiry = payload.exp * 1000 - SAFETY_MARGIN_MS;
        debug(2, `Token expires at ${new Date(expiry).toISOString()}`);
        return expiry;
      }
      debug(2, "No exp claim in token");
      return 0;
    } catch (error) {
      debug(2, `Failed to parse token expiry: ${(error as Error).message}`);
      // Ignore parsing errors, use default
      return 0;
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   * @param forceRefresh - Force a token refresh even if current token is valid
   * @returns Valid access token, or null if unable to get one
   */
  async getValidAccessToken(forceRefresh = false): Promise<string | null> {
    const tokens = await this.loadTokens();

    if (!tokens) {
      debug(1, "No tokens available");
      return null;
    }

    const now = Date.now();
    const needsRefresh = forceRefresh || !tokens.expiresAt || tokens.expiresAt < now;

    if (needsRefresh) {
      debug(2, "Token needs refresh");
      try {
        const refreshed = await this.refreshTokens(tokens.refreshToken);
        const expiresAt = this.parseTokenExpiry(refreshed.accessToken);

        const newTokens: TokenFile = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt,
        };

        await this.saveTokens(newTokens);
        return refreshed.accessToken;
      } catch (error) {
        debug(1, `Failed to refresh token: ${(error as Error).message}`);
        return null;
      }
    }

    debug(2, "Using cached access token");
    return tokens.accessToken;
  }
}
