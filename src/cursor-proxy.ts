import { createProxyServer } from "./cursor/proxy/server.js";
import { debug } from "./debug.js";

let proxyInstance: ReturnType<typeof createProxyServer> | null = null;

/**
 * Find an available port for the proxy server
 */
export async function findAvailablePort(): Promise<number> {
  // This is now handled internally by createProxyServer
  return 0;
}

/**
 * Start the Cursor proxy server
 * Returns a URL and stop function for managing the proxy
 */
export async function startCursorProxy(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  if (proxyInstance) {
    debug(1, "Cursor proxy already running, returning existing instance");
    return {
      url: proxyInstance.getBaseURL(),
      stop: async () => {
        await proxyInstance?.stop();
        proxyInstance = null;
      },
    };
  }

  debug(1, "Starting new Cursor proxy server");
  
  proxyInstance = createProxyServer({
    port: 0, // Auto-assign port
    host: "127.0.0.1",
    healthCheckPath: "/health",
  });

  const url = await proxyInstance.start();
  
  debug(1, `Cursor proxy started`, { url });

  return {
    url,
    stop: async () => {
      if (proxyInstance) {
        await proxyInstance.stop();
        proxyInstance = null;
        debug(1, "Cursor proxy stopped");
      }
    },
  };
}
