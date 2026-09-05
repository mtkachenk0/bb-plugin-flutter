import { spawn, type ChildProcess } from "node:child_process";
import { findDartBin, getEnhancedEnv } from "./flutter-cli";
import http from "node:http";

export class DevToolsManager {
  private process: ChildProcess | null = null;
  private devtoolsUrl: string | null = null;
  private startPromise: Promise<string> | null = null;

  async ensureDevTools(dartBin = "dart", preferredPort?: number): Promise<string> {
    if (this.devtoolsUrl) {
      return this.devtoolsUrl;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start(dartBin, preferredPort);
    try {
      this.devtoolsUrl = await this.startPromise;
      return this.devtoolsUrl;
    } finally {
      this.startPromise = null;
    }
  }

  private async isUrlAccessible(urlStr: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const url = new URL(urlStr);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/",
            method: "HEAD",
            timeout: 1000,
          },
          (res) => {
            resolve(res.statusCode !== undefined && res.statusCode < 500);
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  private async start(dartBin: string, preferredPort?: number): Promise<string> {
    // 1. Check if preferredPort or default 9100 is already active
    const candidatePorts = preferredPort ? [preferredPort, 9100] : [9100];
    for (const port of candidatePorts) {
      const url = `http://127.0.0.1:${port}`;
      if (await this.isUrlAccessible(url)) {
        return url;
      }
    }

    // 2. Spawn dart devtools with --allow-embedding
    return new Promise<string>((resolve, reject) => {
      const args = ["devtools", "--machine", "--allow-embedding", "--no-launch-browser"];
      if (preferredPort) {
        args.push(`--port=${preferredPort}`);
      } else {
        args.push("--port=0");
      }

    const resolvedDartBin = findDartBin(dartBin);

      const proc = spawn(resolvedDartBin, args, {
        env: getEnhancedEnv(resolvedDartBin),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.process = proc;

      let resolved = false;
      let stderrOutput = "";

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.dispose();
          reject(new Error(`DevTools timed out starting: ${stderrOutput}`));
        }
      }, 15_000);

      proc.stdout.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.event === "server.started" && data.params) {
              const host = data.params.host || "127.0.0.1";
              const port = data.params.port;
              if (port) {
                resolved = true;
                clearTimeout(timeout);
                const url = `http://${host}:${port}`;
                resolve(url);
                return;
              }
            }
          } catch {
            // ignore non-JSON line
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString("utf8");
      });

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`DevTools failed to start: ${err.message}`));
        }
      });

      proc.on("exit", (code) => {
        this.process = null;
        this.devtoolsUrl = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`DevTools exited early with code ${code}: ${stderrOutput}`));
        }
      });
    });
  }

  getUrl(): string | null {
    return this.devtoolsUrl;
  }

  dispose(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // ignore kill errors
      }
      this.process = null;
    }
    this.devtoolsUrl = null;
  }
}