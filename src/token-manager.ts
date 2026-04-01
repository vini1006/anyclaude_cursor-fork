import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { debug } from "./debug";
import { getPossibleAuthPaths } from "./cursor-auth";

export interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  expires: number;
}

/**
 * Get the anyclaude-specific token storage path
 */
export function getCursorStoragePath(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  const baseDir = dataHome || path.join(os.homedir(), ".local", "share");
  return path.join(baseDir, "anyclaude", "cursor-auth.json");
}

function ensureStorageDirectory(storagePath: string): void {
  const dir = path.dirname(storagePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read tokens from cursor's native auth file (cli-config.json or auth.json)
 */
function readCursorNativeAuth(): CursorTokens | null {
  const possiblePaths = getPossibleAuthPaths();
  
  for (const authPath of possiblePaths) {
    if (!fs.existsSync(authPath)) {
      continue;
    }
    
    try {
      const content = fs.readFileSync(authPath, "utf8");
      const data = JSON.parse(content);
      
      // cli-config.json format
      if (data.accessToken || data.refreshToken) {
        debug(2, "Found cursor auth file", { path: authPath, format: "cli-config.json" });
        return {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expires: data.expires || (Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000),
        };
      }
      
      // auth.json format (legacy)
      if (data.token || data.access_token) {
        debug(2, "Found cursor auth file", { path: authPath, format: "auth.json" });
        return {
          accessToken: data.token || data.access_token,
          refreshToken: data.refresh_token || "",
          expires: data.expires || (Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000),
        };
      }
    } catch (error) {
      debug(2, "Failed to read cursor auth file", { path: authPath, error: (error as Error).message });
    }
  }
  
  return null;
}

export class TokenManager {
  constructor(private storagePath: string = getCursorStoragePath()) {}

  async loadTokens(): Promise<CursorTokens | null> {
    // Priority 1: Check anyclaude-specific storage
    try {
      if (fs.existsSync(this.storagePath)) {
        const content = await fs.promises.readFile(this.storagePath, "utf8");
        const tokens = JSON.parse(content) as CursorTokens;

        if (tokens.accessToken && tokens.refreshToken && tokens.expires) {
          debug(2, "Loaded tokens from anyclaude storage", { path: this.storagePath });
          return tokens;
        }
      }
    } catch (error) {
      debug(2, "Failed to load tokens from anyclaude storage", { error: (error as Error).message });
    }

    // Priority 2: Check cursor's native auth file
    const nativeAuth = readCursorNativeAuth();
    if (nativeAuth) {
      debug(2, "Using tokens from cursor native auth");
      return nativeAuth;
    }

    return null;
  }

  async saveTokens(tokens: CursorTokens): Promise<void> {
    ensureStorageDirectory(this.storagePath);

    const content = JSON.stringify(tokens, null, 2);
    await fs.promises.writeFile(this.storagePath, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    
    debug(2, "Saved tokens to anyclaude storage", { path: this.storagePath });
  }

  needsRefresh(tokens: CursorTokens): boolean {
    const now = Date.now();
    const safetyMargin = 5 * 60 * 1000;
    return now >= tokens.expires - safetyMargin;
  }

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

    const data = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!data.accessToken || !data.refreshToken) {
      throw new Error("Invalid token refresh response");
    }

    const expiry = this.parseTokenExpiry(data.accessToken);

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expires: expiry,
    };
  }

  private parseTokenExpiry(token: string): number {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new Error("Invalid JWT format");
      }

      const payload = parts[1];
      const decoded = Buffer.from(payload ?? "", "base64url").toString("utf8");
      const payloadObj = JSON.parse(decoded);

      if (payloadObj.exp) {
        return payloadObj.exp * 1000 - 5 * 60 * 1000;
      }
    } catch (error) {
      // Ignore parsing errors
    }

    return Date.now() + 60 * 60 * 1000 - 5 * 60 * 1000;
  }

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
