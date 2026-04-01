import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import open from "open";
import {
  TokenManager,
  type CursorTokens,
  getCursorStoragePath,
} from "./token-manager";
import { debug, queueErrorMessage } from "./debug";
import { generatePKCE, type PKCEParams } from "./cursor/cursor-pkce";

// Polling configuration for auth file detection
const AUTH_POLL_INTERVAL = 2000; // Check every 2 seconds
const AUTH_POLL_TIMEOUT = 5 * 60 * 1000; // 5 minutes total timeout
const URL_EXTRACTION_TIMEOUT = 10000; // Wait up to 10 seconds for URL

// Legacy PKCE flow configuration
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

// Re-export for backward compatibility
export { generatePKCE, type PKCEParams };

/**
 * Get the home directory, respecting CURSOR_ACP_HOME_DIR override
 */
function getHomeDir(): string {
  const override = process.env.CURSOR_ACP_HOME_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return homedir();
}

/**
 * Returns all possible auth file paths in priority order.
 * Checks both cli-config.json (current) and auth.json (legacy).
 */
export function getPossibleAuthPaths(): string[] {
  const home = getHomeDir();
  const paths: string[] = [];
  const isDarwin = platform() === "darwin";

  const authFiles = ["cli-config.json", "auth.json"];

  if (isDarwin) {
    // macOS: ~/.cursor/ (primary), ~/.config/cursor/ (fallback)
    for (const file of authFiles) {
      paths.push(join(home, ".cursor", file));
    }
    for (const file of authFiles) {
      paths.push(join(home, ".config", "cursor", file));
    }
  } else {
    // Linux: ~/.config/cursor/ (XDG), XDG_CONFIG_HOME/cursor/, ~/.cursor/
    for (const file of authFiles) {
      paths.push(join(home, ".config", "cursor", file));
    }

    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig && xdgConfig !== join(home, ".config")) {
      for (const file of authFiles) {
        paths.push(join(xdgConfig, "cursor", file));
      }
    }

    for (const file of authFiles) {
      paths.push(join(home, ".cursor", file));
    }
  }

  return paths;
}

/**
 * Check if cursor auth file exists at any of the possible paths
 */
export function verifyCursorAuth(): boolean {
  const possiblePaths = getPossibleAuthPaths();
  for (const authPath of possiblePaths) {
    if (existsSync(authPath)) {
      debug(2, "Auth file found", { path: authPath });
      return true;
    }
  }
  return false;
}

/**
 * Poll for auth file creation with timeout
 */
export async function pollForAuthFile(
  timeoutMs: number = AUTH_POLL_TIMEOUT,
  intervalMs: number = AUTH_POLL_INTERVAL
): Promise<boolean> {
  const startTime = Date.now();
  const possiblePaths = getPossibleAuthPaths();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;

      for (const authPath of possiblePaths) {
        if (existsSync(authPath)) {
          debug(2, "Auth file detected", { path: authPath });
          resolve(true);
          return;
        }
      }

      debug(2, "Polling for auth file", {
        checkedPaths: possiblePaths,
        elapsed: `${elapsed}ms`,
        timeout: `${timeoutMs}ms`,
      });

      if (elapsed >= timeoutMs) {
        debug(2, "Auth file polling timed out");
        resolve(false);
        return;
      }

      setTimeout(check, intervalMs);
    };

    check();
  });
}

/**
 * Extract OAuth URL from cursor-agent stdout
 */
function extractLoginUrl(stdout: string): string | null {
  // Strip ANSI codes and whitespace
  let cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  cleanOutput = cleanOutput.replace(/\s/g, "");
  
  // Extract the continuous URL
  const urlMatch = cleanOutput.match(/https:\/\/cursor\.com\/loginDeepControl[^\s]*/);
  if (urlMatch) {
    return urlMatch[0];
  }
  return null;
}

/**
 * Start cursor-agent login process and extract OAuth URL
 */
export async function startCursorOAuth(): Promise<{
  url: string;
  instructions: string;
  callback: () => Promise<AuthResult>;
}> {
  return new Promise((resolve, reject) => {
    debug(1, "Starting cursor-agent login process");

    const proc = spawn("cursor-agent", ["login"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let urlExtracted = false;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Poll for URL extraction with timeout
    const urlPollStart = Date.now();
    const pollForUrl = () => {
      if (urlExtracted) return;

      const elapsed = Date.now() - urlPollStart;
      if (elapsed >= URL_EXTRACTION_TIMEOUT) {
        proc.kill();
        const errorMsg = stderr ? stripAnsi(stderr) : "No login URL received within timeout";
        debug(1, "Failed to extract login URL", { error: errorMsg, elapsed: `${elapsed}ms` });
        reject(new Error(`Failed to get login URL: ${errorMsg}`));
        return;
      }

      const url = extractLoginUrl(stdout);
      if (url && !urlExtracted) {
        urlExtracted = true;
        debug(2, "Captured stdout", { length: stdout.length });
        debug(2, "Extracted URL", { url: url.substring(0, 50) + "..." });
        debug(1, "Got login URL, waiting for browser auth");

        resolve({
          url,
          instructions: "Click 'Continue with Cursor' in your browser to authenticate",
          callback: async () => {
            return new Promise((resolveCallback) => {
              let resolved = false;

              const resolveOnce = (result: AuthResult) => {
                if (!resolved) {
                  resolved = true;
                  resolveCallback(result);
                }
              };

              proc.on("close", async (code) => {
                debug(2, "Login process closed", { code });

                if (code === 0) {
                  debug(1, "Process exited successfully, polling for auth file...");
                  const isAuthenticated = await pollForAuthFile();

                  if (isAuthenticated) {
                    debug(1, "Authentication successful");
                    resolveOnce({
                      type: "success",
                      provider: "cursor",
                      key: "cursor-auth",
                    });
                  } else {
                    debug(1, "Auth file not found after polling");
                    resolveOnce({
                      type: "failed",
                      error: "Authentication was not completed. Please try again.",
                    });
                  }
                } else {
                  debug(1, "Login process failed", { code });
                  resolveOnce({
                    type: "failed",
                    error: stderr ? stripAnsi(stderr) : `Authentication failed with code ${code}`,
                  });
                }
              });

              // Timeout after 5 minutes
              setTimeout(() => {
                debug(1, "Authentication timed out after 5 minutes");
                proc.kill();
                resolveOnce({
                  type: "failed",
                  error: "Authentication timed out. Please try again.",
                });
              }, AUTH_POLL_TIMEOUT);
            });
          },
        });
        return;
      }

      setTimeout(pollForUrl, 100); // Check every 100ms
    };

    pollForUrl();
  });
}

/**
 * Strip ANSI escape codes from string
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface AuthResult {
  type: "success" | "failed";
  provider?: string;
  key?: string;
  error?: string;
}

// ============ Legacy PKCE Flow (for backward compatibility) ============

export function buildLoginUrl(params: PKCEParams): string {
  const baseUrl = "https://cursor.com/loginDeepControl";
  const queryParams = new URLSearchParams({
    challenge: params.challenge,
    uuid: params.uuid,
    mode: "login",
    redirectTarget: "cli",
  });

  return `${baseUrl}?${queryParams.toString()}`;
}

export async function pollForTokens(
  uuid: string,
  verifier: string
): Promise<CursorTokens> {
  const apiUrl = process.env.CURSOR_API_URL || "https://api2.cursor.sh";
  const pollUrl = `${apiUrl}/auth/poll`;

  let delay = POLL_BASE_DELAY_MS;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(
        `${pollUrl}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        { method: "GET" }
      );

      if (response.status === 200) {
        const data = (await response.json()) as {
          accessToken?: string;
          refreshToken?: string;
        };
        if (data.accessToken && data.refreshToken) {
          debug(1, "Cursor authentication successful (PKCE flow)");
          const expiry = parseTokenExpiry(data.accessToken);
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expires: expiry,
          };
        }
      } else if (response.status === 404) {
        debug(2, `Poll attempt ${attempt}/${POLL_MAX_ATTEMPTS}, waiting...`);
      } else {
        throw new Error(
          `Unexpected response status: ${response.status} ${response.statusText}`
        );
      }
    } catch (error) {
      if (attempt === POLL_MAX_ATTEMPTS) {
        throw error;
      }
      debug(2, `Poll attempt ${attempt} failed, retrying...`);
    }

    await sleep(delay);
    delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
  }

  throw new Error(
    `Authentication timeout after ${POLL_MAX_ATTEMPTS} attempts. Please try again.`
  );
}

export function parseTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }

    const payload = parts[1];
    const decoded = Buffer.from(payload ?? "", "base64url").toString("utf8");
    const payloadObj = JSON.parse(decoded);

    if (payloadObj.exp) {
      return payloadObj.exp * 1000 - TOKEN_SAFETY_MARGIN_MS;
    }
  } catch (error) {
    debug(2, `Failed to parse token expiry: ${(error as Error).message}`);
  }

  return Date.now() + 60 * 60 * 1000 - TOKEN_SAFETY_MARGIN_MS;
}

// Configurable sleep function for testing
let sleepImpl: ((ms: number) => Promise<void>) | undefined;

export function setSleepImplementation(
  impl: (ms: number) => Promise<void>
): void {
  sleepImpl = impl;
}

export function clearSleepImplementation(): void {
  sleepImpl = undefined;
}

export function sleep(ms: number): Promise<void> {
  if (sleepImpl) {
    return sleepImpl(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main authentication entry point
 * Uses cursor-agent login by default, falls back to PKCE if CURSOR_AUTH_METHOD=pkce
 */
export async function runCursorAuth(): Promise<void> {
  console.log("Starting Cursor authentication...");

  const authMethod = process.env.CURSOR_AUTH_METHOD || "agent";

  try {
    if (authMethod === "pkce") {
      // Legacy PKCE flow
      console.log("Using legacy PKCE authentication flow...");
      await runPkceAuth();
    } else {
      // New cursor-agent flow (default)
      console.log("Using cursor-agent authentication flow...");
      await runAgentAuth();
    }
  } catch (error) {
    queueErrorMessage(`✗ Authentication failed: ${(error as Error).message}`);
    debug(1, `Cursor auth error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Legacy PKCE authentication flow
 */
async function runPkceAuth(): Promise<void> {
  const pkce = await generatePKCE();
  debug(2, "Generated PKCE parameters");

  const loginUrl = buildLoginUrl(pkce);
  debug(2, `Login URL: ${loginUrl}`);

  console.log("Opening browser for authentication...");
  await open(loginUrl);
  console.log(
    "Please complete authentication in your browser. This may take a moment..."
  );

  const tokens = await pollForTokens(pkce.uuid, pkce.verifier);

  const tokenManager = new TokenManager();
  await tokenManager.saveTokens(tokens);

  console.log("✓ Authentication successful. Tokens saved.");
  console.log(`  Storage: ${getCursorStoragePath()}`);
}

/**
 * New cursor-agent authentication flow
 */
async function runAgentAuth(): Promise<void> {
  try {
    const { url, instructions, callback } = await startCursorOAuth();
    
    console.log("Opening browser for authentication...");
    console.log(`URL: ${url.substring(0, 60)}...`);
    await open(url);
    console.log(instructions);
    console.log("Waiting for authentication to complete...");

    const result = await callback();

    if (result.type === "success") {
      console.log("✓ Authentication successful.");
      console.log(`  Auth file location: ${getPossibleAuthPaths().find(existsSync)}`);
    } else {
      throw new Error(result.error || "Authentication failed");
    }
  } catch (error) {
    throw new Error(`cursor-agent auth failed: ${(error as Error).message}`);
  }
}
