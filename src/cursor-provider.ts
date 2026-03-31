import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { TokenManager } from "./token-manager";
import { debug } from "./debug";

export function createCursorProvider(): {
  languageModel: (
    modelId: string,
  ) => ReturnType<OpenAIProvider["chat"]>;
} {
  const tokenManager = new TokenManager();

  return {
    languageModel: (modelId: string) => {
      const cursorModelId = modelId.replace(/^cursor\//, "");
      debug(1, `Cursor provider: ${modelId} -> ${cursorModelId}`);

      const openaiProvider = createOpenAI({
        apiKey: "cursor-proxy",
        baseURL: "http://localhost:0/v1",
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          try {
            const accessToken = await tokenManager.getValidAccessToken();

            const headers = new Headers((init?.headers as Record<string, string>) || {});
            headers.set("Authorization", `Bearer ${accessToken}`);

            debug(2, `Cursor API request to ${url}`);

            return globalThis.fetch(url, { ...init, headers });
          } catch (error) {
            debug(1, `Cursor provider error: ${(error as Error).message}`);
            throw error;
          }
        }) as any,
      });

      // @ai-sdk/openai v2: languageModel() defaults to Responses API (/v1/responses).
      // Cursor proxy only implements Chat Completions (/v1/chat/completions).
      return openaiProvider.chat(cursorModelId);
    },
  };
}

export function createCursorProviderWithBaseUrl(baseUrl: string) {
  const tokenManager = new TokenManager();

  return {
    languageModel: (modelId: string) => {
      const cursorModelId = modelId.replace(/^cursor\//, "");
      debug(
        1,
        `Cursor provider (base: ${baseUrl}): ${modelId} -> ${cursorModelId}`,
      );

      const openaiProvider = createOpenAI({
        apiKey: "cursor-proxy",
        baseURL: `${baseUrl}/v1`,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const accessToken = await tokenManager.getValidAccessToken();

          const headers = new Headers((init?.headers as Record<string, string>) || {});
          headers.set("Authorization", `Bearer ${accessToken}`);

          return globalThis.fetch(url, { ...init, headers });
        }) as any,
      });

      return openaiProvider.chat(cursorModelId);
    },
  };
}
