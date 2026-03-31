import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  expires: number; // Timestamp in milliseconds
}

/**
 * Get the storage path for Cursor auth tokens.
 * Respects XDG_DATA_HOME env var, falls back to ~/.local/share
 */
export function getCursorStoragePath(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  const baseDir = dataHome || path.join(os.homedir(), ".local", "share");
  return path.join(baseDir, "anyclaude", "cursor-auth.json");
}

/**
 * Ensure the directory for token storage exists
 */
function ensureStorageDirectory(storagePath: string): void {
  const dir = path.dirname(storagePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * TokenManager handles Cursor authentication token storage and refresh
 */
export class TokenManager {
  constructor(private storagePath: string = getCursorStoragePath()) {}

  /**
   * Load tokens from storage, returns null if not found
   */
  async loadTokens(): Promise<CursorTokens | null> {
    try {
      if (!fs.existsSync(this.storagePath)) {
        return null;
      }

      const content = await fs.promises.readFile(this.storagePath, "utf8");
      const tokens = JSON.parse(content) as CursorTokens;

      // Validate required fields
      if (
        !tokens.accessToken ||
        !tokens.refreshToken ||
        !tokens.expires
      ) {
        return null;
      }

      return tokens;
    } catch (error) {
      // File corrupted or unreadable
      return null;
    }
  }

  /**
   * Save tokens to storage with secure permissions (600)
   */
  async saveTokens(tokens: CursorTokens): Promise<void> {
    ensureStorageDirectory(this.storagePath);

    const content = JSON.stringify(tokens, null, 2);
    await fs.promises.writeFile(this.storagePath, content, {
      encoding: "utf8",
      mode: 0o600, // Owner read/write only
    });
  }

  /**
   * Check if tokens need refresh (within 5-minute safety margin)
   */
  needsRefresh(tokens: CursorTokens): boolean {
    const now = Date.now();
    const safetyMargin = 5 * 60 * 1000; // 5 minutes
    return now >= tokens.expires - safetyMargin;
  }

  /**
   * Refresh expired tokens using the refresh token
   */
  async refreshTokens(refreshToken: string): Promise<CursorTokens> {
    const apiUrl = process.env.CURSOR_API_URL || "https://api2.cursor.sh";
    const refreshUrl = `${apiUrl}/auth/exchange_user_api_key`;

    const response = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    if (!data.accessToken || !data.refreshToken) {
      throw new Error("Invalid token refresh response");
    }

    // Parse expiry from JWT or use default (1 hour)
    const expiry = this.parseTokenExpiry(data.accessToken);

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expires: expiry,
    };
  }

  /**
   * Parse expiry timestamp from JWT token
   * Falls back to 1 hour from now if parsing fails
   */
  private parseTokenExpiry(token: string): number {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new Error("Invalid JWT format");
      }

      // Base64url decode the payload
      const payload = parts[1];
      const decoded = Buffer.from(payload, "base64url").toString("utf8");
      const payloadObj = JSON.parse(decoded);

      if (payloadObj.exp) {
        // Convert from seconds to milliseconds, subtract 5-minute safety margin
        return payloadObj.exp * 1000 - 5 * 60 * 1000;
      }
    } catch (error) {
      // Ignore parsing errors, use default
    }

    // Default: 1 hour from now, minus 5-minute safety margin
    return Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
  }

  /**
   * Get valid access token, refreshing if necessary
   */
  async getValidAccessToken(): Promise<string> {
    const tokens = await this.loadTokens();

    if (!tokens) {
      throw new Error(
        "Cursor authentication not found. Run 'anyclaude cursor-auth' to authenticate."
      );
    }

    if (this.needsRefresh(tokens)) {
      try {
        const refreshed = await this.refreshTokens(tokens.refreshToken);
        await this.saveTokens(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        throw new Error(
          "Cursor token refresh failed. Please run 'anyclaude cursor-auth' to re-authenticate."
        );
      }
    }

    return tokens.accessToken;
  }
}
