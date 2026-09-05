import { findFlutterBin, getEnhancedEnv, resolveUserPath } from "./flutter-cli";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  FlutterDevice,
  LogEntry,
  ServiceExtensionState,
  SessionConfig,
  SessionState,
  SessionStatus,
} from "./types";
import { VmServiceClient } from "./vm-service-client";

export class FlutterSession {
  private process: ChildProcess | null = null;
  private vmClient = new VmServiceClient();
  private reqId = 1;
  private pendingRequests = new Map<
    string | number,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >();

  private status: SessionStatus = "idle";
  private config: SessionConfig | null = null;
  private isPaused = false;
  private progressMessage: string | null = null;
  private appId: string | null = null;
  private wsUri: string | null = null;
  private devtoolsUrl: string | null = null;
  private inspectorUrl: string | null = null;
  private debuggerUrl: string | null = null;
  private activeDevice: FlutterDevice | null = null;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private error: string | null = null;

  private logIdCounter = 0;
  private readonly maxLogs = 1000;
  private logs: LogEntry[] = [];

  private extensionStates: ServiceExtensionState = {
    debugPaint: false,
    selectWidgetMode: false,
    performanceOverlay: false,
    slowAnimations: false,
  };

  private stdoutBuffer = "";

  private logQueue: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs = 100;

  constructor(
    private onStateChange?: (state: SessionState) => void,
    private onLog?: (logs: LogEntry[]) => void,
  ) {}

  getState(): SessionState {
    return {
      status: this.status,
      config: this.config,
      isPaused: this.isPaused,
      progressMessage: this.progressMessage,
      appId: this.appId,
      wsUri: this.wsUri,
      devtoolsUrl: this.devtoolsUrl,
      inspectorUrl: this.inspectorUrl,
      debuggerUrl: this.debuggerUrl,
      activeDevice: this.activeDevice,
      pid: this.pid,
      startedAt: this.startedAt,
      error: this.error,
    };
  }

  getLogs(sinceId = 0, limit = 200): LogEntry[] {
    const filtered = this.logs.filter((l) => l.id > sinceId);
    return filtered.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
  }

  private addLog(
    type: "stdout" | "stderr" | "system" | "progress",
    message: string,
  ): void {
    const entry: LogEntry = {
      id: ++this.logIdCounter,
      timestamp: Date.now(),
      type,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (!this.onLog) return;
    this.logQueue.push(entry);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushLogs(), this.flushIntervalMs);
    }
  }

  private flushLogs(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.logQueue.length === 0) return;
    const batch = this.logQueue;
    this.logQueue = [];
    this.onLog?.(batch);
  }

  private updateStatus(status: SessionStatus, error?: string): void {
    this.status = status;
    if (error) this.error = error;
    this.onStateChange?.(this.getState());
  }

  private updateProgress(msg: string | null): void {
    this.progressMessage = msg;
    this.onStateChange?.(this.getState());
  }

  async start(
    config: SessionConfig,
    options: {
      flutterBin?: string;
      devtoolsUrl?: string;
      device?: FlutterDevice;
    } = {},
  ): Promise<SessionState> {
    if (this.process && this.status !== "stopped" && this.status !== "error") {
      throw new Error("A Flutter session is already running. Stop it before starting a new one.");
    }

    const resolvedBin = findFlutterBin(options.flutterBin || "flutter");
    const resolvedProjectPath = resolveUserPath(config.projectPath);

    this.config = {
      ...config,
      projectPath: resolvedProjectPath,
    };
    this.activeDevice = options.device || {
      id: config.deviceId,
      name: config.deviceId,
      targetPlatform: "unknown",
      emulator: false,
      isSupported: true,
    };
    this.devtoolsUrl = options.devtoolsUrl || null;
    this.appId = null;
    this.wsUri = null;
    this.inspectorUrl = null;
    this.debuggerUrl = null;
    this.isPaused = false;
    this.error = null;
    this.progressMessage = "Launching flutter run...";
    this.startedAt = Date.now();
    this.updateStatus("starting");

    const args = ["run", "--machine", "-d", config.deviceId];
    if (config.target) {
      args.push("--target", config.target);
    }
    if (config.flavor) {
      args.push("--flavor", config.flavor);
    }
    if (config.mode) {
      args.push(`--${config.mode}`);
    }
    if (this.devtoolsUrl) {
      args.push("--devtools-server-address", this.devtoolsUrl);
    }
    if (config.additionalArgs) {
      args.push(...config.additionalArgs);
    }

    this.addLog("system", `Executing: ${resolvedBin} ${args.join(" ")} (in ${resolvedProjectPath})`);

    const proc = spawn(resolvedBin, args, {
      cwd: resolvedProjectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: getEnhancedEnv(resolvedBin),
    });
    this.stdoutBuffer = "";
    this.process = proc;
    this.pid = proc.pid ?? null;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutData(chunk.toString("utf8"));
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.addLog("stderr", text.trimEnd());
    });

    proc.on("error", (err) => {
      this.addLog("stderr", `Process error: ${err.message}`);
      this.updateStatus("error", err.message);
    });

    proc.on("exit", (code, signal) => {
      this.addLog(
        "system",
        `Flutter process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
      );
      this.process = null;
      this.pid = null;
      this.flushLogs();
      this.updateProgress(null);
      this.updateStatus(code === 0 ? "stopped" : "error", code === 0 ? undefined : `Exited with code ${code}`);
      this.rejectPending(new Error("Flutter process exited"));
      this.vmClient.disconnect();
    });

    return this.getState();
  }

  private handleStdoutData(data: string): void {
    this.stdoutBuffer += data;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Flutter machine messages start with '[' or '{'
      if (trimmed.startsWith("[{") || trimmed.startsWith("{")) {
        try {
          let payload = JSON.parse(trimmed);
          if (Array.isArray(payload)) {
            for (const item of payload) {
              this.handleMachineMessage(item);
            }
          } else {
            this.handleMachineMessage(payload);
          }
          continue;
        } catch {
          // fall through to normal log
        }
      }

      this.addLog("stdout", trimmed);
    }
  }

  private handleMachineMessage(msg: any): void {
    // Response to a JSON-RPC request sent by us
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }

    const event = msg.event;
    const params = msg.params || {};

    switch (event) {
      case "app.start": {
        this.appId = params.appId || null;
        this.updateStatus("building");
        this.activeDevice = {
          id: params.deviceId || this.config?.deviceId || "",
          name: params.deviceId || "",
          targetPlatform: params.targetPlatform || "unknown",
          emulator: Boolean(params.emulator),
          isSupported: true,
        };
        this.addLog("system", `App started on device "${this.activeDevice?.name || this.config?.deviceId}" (mode: ${params.mode || "debug"})`);
        break;
      }
      case "app.progress": {
        const message = params.message || "";
        this.updateProgress(params.finished ? null : message);
        if (message) {
          this.addLog("progress", message);
        }
        break;
      }
      case "app.debugPort": {
        const wsUri = params.wsUri;
        if (wsUri) {
          this.wsUri = wsUri;
          this.addLog("system", `Connected Dart VM Service: ${wsUri}`);

          // Compute embedded DevTools URLs
          if (this.devtoolsUrl) {
            const encodedWs = encodeURIComponent(wsUri);
            this.inspectorUrl = `${this.devtoolsUrl}/?uri=${encodedWs}&embed=true&page=inspector`;
            this.debuggerUrl = `${this.devtoolsUrl}/?uri=${encodedWs}&embed=true&page=debugger`;

          // Connect VM service client for pause/resume and extensions
          this.vmClient.connect(wsUri, (isPaused) => {
            this.isPaused = isPaused;
            this.updateStatus(isPaused ? "paused" : "running");
          }).catch((err) => {
            this.addLog("stderr", `VM service connection warning: ${err.message}`);
          });
          }
        }
        break;
      }
      case "app.started": {
        this.updateStatus("running");
        this.updateProgress(null);
        this.addLog("system", "🚀 Application is running.");
        break;
      }
      case "app.log": {
        this.addLog(params.error ? "stderr" : "stdout", params.log || "");
        break;
      }
      case "app.stop": {
        this.updateStatus("stopped");
        this.addLog("system", "App stopped.");
        break;
      }
      case "app.webLaunchUrl": {
        this.addLog("system", `Web application launched at: ${params.url}`);
        break;
      }
      default: {
        // Unhandled event
        break;
      }
    }
  }

  private rejectPending(err: Error): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const req of pending) req.reject(err);
  }

  private sendCommand<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error("No active Flutter process"));
    }

    const id = this.reqId++;
    const payload = JSON.stringify([{ id, method, params }]) + "\n";

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(payload, "utf8", (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  async hotReload(): Promise<{ code: number; message: string }> {
    if (!this.appId) throw new Error("App is not running or appId is not available");
    this.addLog("system", "⚡️ Performing Hot Reload...");
    const result = await this.sendCommand("app.restart", {
      appId: this.appId,
      fullRestart: false,
      pause: false,
    });
    const message = result.message || "Hot reload complete";
    this.addLog("system", `⚡️ ${message}`);
    return { code: result.code ?? 0, message };
  }

  async hotRestart(): Promise<{ code: number; message: string }> {
    if (!this.appId) throw new Error("App is not running or appId is not available");
    this.addLog("system", "🔄 Performing Hot Restart...");
    const result = await this.sendCommand("app.restart", {
      appId: this.appId,
      fullRestart: true,
      pause: false,
    });
    const message = result.message || "Hot restart complete";
    this.addLog("system", `🔄 ${message}`);
    return { code: result.code ?? 0, message };
  }

  async pause(): Promise<void> {
    await this.vmClient.pause();
    this.isPaused = true;
    this.updateStatus("paused");
  }

  async resume(): Promise<void> {
    await this.vmClient.resume();
    this.isPaused = false;
    this.updateStatus("running");
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.updateStatus("stopped");
      return;
    }

    this.addLog("system", "Stopping Flutter application...");
    if (this.appId) {
      try {
        await Promise.race([
          this.sendCommand("app.stop", { appId: this.appId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000)),
        ]);
      } catch {
        // ignore and force kill
      }
    }

    if (this.process) {
      try {
        this.process.kill("SIGINT");
        setTimeout(() => {
          if (this.process) {
            this.process.kill("SIGKILL");
          }
        }, 3000);
      } catch {
        // ignore kill error
      }
    }

    this.vmClient.disconnect();
    this.rejectPending(new Error("Flutter session stopped"));
    this.flushLogs();
    this.updateStatus("stopped");
  }

  async toggleExtension(
    name: "selectWidgetMode" | "debugPaint" | "performanceOverlay" | "slowAnimations",
    explicitValue?: boolean,
  ): Promise<boolean> {
    const current = this.extensionStates[name];
    const next = explicitValue !== undefined ? explicitValue : !current;

    const extensionNames: Record<typeof name, string> = {
      selectWidgetMode: "ext.flutter.inspector.selectMode",
      debugPaint: "ext.flutter.debugPaint",
      performanceOverlay: "ext.flutter.showPerformanceOverlay",
      slowAnimations: "ext.flutter.timeDilation",
    };

    const extName = extensionNames[name];
    let extValue: any = next;
    if (name === "slowAnimations") {
      extValue = next ? 5.0 : 1.0;
    }

    if (this.appId) {
      try {
        await this.sendCommand("app.callServiceExtension", {
          appId: this.appId,
          method: extName,
          params: { value: extValue },
        });
      } catch {
        // Try direct vmClient fallback
        await this.vmClient.callExtension(extName, { value: extValue });
      }
    } else {
      await this.vmClient.callExtension(extName, { value: extValue });
    }

    this.extensionStates[name] = next;
    this.addLog("system", `Service extension ${name} set to ${next}`);
    return next;
  }
}