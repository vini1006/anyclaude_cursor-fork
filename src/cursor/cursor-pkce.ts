// src/cursor/cursor-pkce.ts
export interface PKCEParams {
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
