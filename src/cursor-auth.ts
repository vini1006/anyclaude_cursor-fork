import * as os from "os";
import * as path from "path";
import open from "open";
import { TokenManager, type CursorTokens, getCursorStoragePath } from "./token-manager";
import { debug, queueErrorMessage } from "./debug";

// Polling configuration constants
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

// Token expiry safety margin (5 minutes)
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

interface PKCEParams {
  verifier: string;
  challenge: string;
  uuid: string;
}

export async function generatePKCE(): Promise<PKCEParams> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(96));
  const verifier = Buffer.from(verifierBytes).toString("base64url");

  const encoder = new TextEncoder();
  const verifierData = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", verifierData);
  const challenge = Buffer.from(hashBuffer).toString("base64url");

  const uuid = crypto.randomUUID();

  return { verifier, challenge, uuid };
}

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
        const data = await response.json();
        if (data.accessToken && data.refreshToken) {
          debug(1, "Cursor authentication successful");
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
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const payloadObj = JSON.parse(decoded);

    if (payloadObj.exp) {
      return payloadObj.exp * 1000 - TOKEN_SAFETY_MARGIN_MS;
    }
  } catch (error) {
    debug(2, `Failed to parse token expiry: ${error.message}`);
  }

  return Date.now() + 60 * 60 * 1000 - TOKEN_SAFETY_MARGIN_MS;
}

// Configurable sleep function for testing
let sleepImpl: (ms: number) => Promise<void> | undefined;

export function setSleepImplementation(impl: (ms: number) => Promise<void>): void {
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

export async function runCursorAuth(): Promise<void> {
  console.log("Starting Cursor authentication...");

  try {
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
  } catch (error) {
    queueErrorMessage(`✗ Authentication failed: ${error.message}`);
    debug(1, `Cursor auth error: ${error.message}`);
    process.exit(1);
  }
}
