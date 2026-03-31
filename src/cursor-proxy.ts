import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { debug } from "./debug";

export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address && address.port) {
        server.close(() => resolve(address.port));
      } else {
        reject(new Error("Failed to get port"));
      }
    });
    server.on("error", reject);
  });
}

async function waitForProxy(port: number, maxAttempts = 30): Promise<void> {
  const delay = 100;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}/v1/models`, {
        method: "GET",
        headers: { Authorization: "Bearer cursor-proxy" },
      });

      if (response.ok || response.status === 401) {
        debug(1, `Cursor proxy ready on port ${port}`);
        return;
      }
    } catch (error) {
      // Connection refused, keep trying
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    `Cursor proxy failed to start on port ${port} after ${maxAttempts} attempts`,
  );
}

export async function startCursorProxy(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const port = await findAvailablePort();
  debug(1, `Starting Cursor proxy on port ${port}`);

  let proxy: ChildProcess;

  try {
    proxy = spawn("opencode-cursor", ["--port", port.toString()], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (error) {
    throw new Error(
      "opencode-cursor not found. Please install it: npm install -g opencode-cursor",
    );
  }

  proxy.stdout?.on("data", (data) => {
    debug(2, `[opencode-cursor] ${data.toString().trim()}`);
  });

  proxy.stderr?.on("data", (data) => {
    debug(1, `[opencode-cursor] ${data.toString().trim()}`);
  });

  proxy.on("exit", (code, signal) => {
    debug(1, `Cursor proxy exited with code ${code}, signal ${signal}`);
  });

  proxy.on("error", (error) => {
    debug(1, `Cursor proxy error: ${error.message}`);
  });

  try {
    await waitForProxy(port);
  } catch (error) {
    proxy.kill();
    throw error;
  }

  return {
    url: `http://localhost:${port}`,
    stop: async () => {
      return new Promise((resolve) => {
        if (proxy.killed || proxy.exitCode !== null) {
          resolve();
          return;
        }

        proxy.once("exit", resolve);
        proxy.kill("SIGTERM");

        setTimeout(() => {
          if (!proxy.killed) {
            proxy.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    },
  };
}
