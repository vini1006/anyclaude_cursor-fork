import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { TokenManager } from "./token-manager";
import { debug } from "./debug";

export function createCursorProvider(): {
  languageModel: (
    modelId: string,
  ) => ReturnType<OpenAIProvider["languageModel"]>;
} {
  const tokenManager = new TokenManager();

  return {
    languageModel: (modelId: string) => {
      const cursorModelId = modelId.replace(/^cursor\//, "");
      debug(1, `Cursor provider: ${modelId} -> ${cursorModelId}`);

      const openaiProvider = createOpenAI({
        apiKey: "cursor-proxy",
        baseURL: "http://localhost:0/v1",
        fetch: async (url, init) => {
          try {
            const accessToken = await tokenManager.getValidAccessToken();

            const headers = new Headers((init?.headers as HeadersInit) || {});
            headers.set("Authorization", `Bearer ${accessToken}`);

            debug(2, `Cursor API request to ${url}`);

            return globalThis.fetch(url, { ...init, headers });
          } catch (error) {
            debug(1, `Cursor provider error: ${error.message}`);
            throw error;
          }
        },
      });

      return openaiProvider.languageModel(cursorModelId);
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
        fetch: async (url, init) => {
          const accessToken = await tokenManager.getValidAccessToken();

          const headers = new Headers((init?.headers as HeadersInit) || {});
          headers.set("Authorization", `Bearer ${accessToken}`);

          return globalThis.fetch(url, { ...init, headers });
        },
      });

      return openaiProvider.languageModel(cursorModelId);
    },
  };
}
