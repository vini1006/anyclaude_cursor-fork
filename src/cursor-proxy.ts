import { startCursorProxyInternal, stopCursorProxyInternal } from "./cursor/cursor-proxy-internal";
import { TokenManager } from "./token-manager";
import { debug } from "./debug";

let proxyPort: number | undefined;

export async function findAvailablePort(): Promise<number> {
  // Return 0 - internal proxy handles port assignment
  return 0;
}

export async function startCursorProxy(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const tokenManager = new TokenManager();

  const getAccessToken = async () => {
    return await tokenManager.getValidAccessToken();
  };

  const port = await startCursorProxyInternal(getAccessToken, []);
  proxyPort = port;

  debug(1, `Internal Cursor proxy started on port ${port}`);

  return {
    url: `http://localhost:${port}`,
    stop: async () => {
      await stopCursorProxyInternal();
      proxyPort = undefined;
    },
  };
}
