export interface VmIsolate {
  id: string;
  name: string;
  isPaused: boolean;
}

export class VmServiceClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pendingRequests = new Map<
    string | number,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >();
  private isolates: VmIsolate[] = [];
  private onPauseChangeCallback?: (isPaused: boolean) => void;
  private isConnected = false;

  async connect(
    wsUri: string,
    onPauseChange?: (isPaused: boolean) => void,
  ): Promise<void> {
    this.disconnect();
    this.onPauseChangeCallback = onPauseChange;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      try {
        const ws = new WebSocket(wsUri);
        this.ws = ws;

        ws.onopen = async () => {
          this.isConnected = true;
          settled = true;
          // Subscribe to streams
          try {
            await Promise.all([
              this.call("streamListen", { streamId: "Debug" }),
              this.call("streamListen", { streamId: "Isolate" }),
            ]);
            await this.refreshVM();
          } catch {
            // non-fatal stream listen error
          }
          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data.toString());
            this.handleMessage(data);
          } catch {
            // ignore malformed message
          }
        };

        ws.onerror = (err) => {
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket error connecting to Dart VM: ${String(err)}`));
          }
        };

        ws.onclose = () => {
          this.isConnected = false;
          this.ws = null;
          this.isolates = [];
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(data: any): void {
    // 1. JSON-RPC response
    if (data.id !== undefined && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      if (data.error) {
        pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
      } else {
        pending.resolve(data.result);
      }
      return;
    }

    // 2. Stream event
    if (data.method === "streamNotify" && data.params) {
      const streamId = data.params.streamId;
      const event = data.params.event;
      if (!event) return;

      if (streamId === "Debug") {
        const isolateId = event.isolate?.id;
        const kind = event.kind;
        if (
          kind === "PauseStart" ||
          kind === "PauseExit" ||
          kind === "PauseInterrupted" ||
          kind === "PauseBreakpoint" ||
          kind === "PauseException"
        ) {
          this.setIsolatePaused(isolateId, true);
        } else if (kind === "Resume") {
          this.setIsolatePaused(isolateId, false);
        }
      } else if (streamId === "Isolate") {
        if (event.kind === "IsolateStart") {
          if (event.isolate?.id) {
            this.isolates.push({
              id: event.isolate.id,
              name: event.isolate.name || "isolate",
              isPaused: false,
            });
          }
        } else if (event.kind === "IsolateExit") {
          if (event.isolate?.id) {
            this.isolates = this.isolates.filter((iso) => iso.id !== event.isolate.id);
            this.notifyPauseChange();
          }
        }
      }
    }
  }

  private setIsolatePaused(isolateId: string | undefined, isPaused: boolean): void {
    if (isolateId) {
      const target = this.isolates.find((iso) => iso.id === isolateId);
      if (target) {
        target.isPaused = isPaused;
      } else {
        this.isolates.push({ id: isolateId, name: "isolate", isPaused });
      }
    } else {
      for (const iso of this.isolates) {
        iso.isPaused = isPaused;
      }
    }
    this.notifyPauseChange();
  }

  private notifyPauseChange(): void {
    const anyPaused = this.isolates.some((iso) => iso.isPaused);
    this.onPauseChangeCallback?.(anyPaused);
  }

  async refreshVM(): Promise<void> {
    try {
      const result = await this.call("getVM");
      if (result?.isolates && Array.isArray(result.isolates)) {
        this.isolates = result.isolates.map((iso: any) => ({
          id: iso.id,
          name: iso.name || "isolate",
          isPaused: false,
        }));
      }
    } catch {
      // ignore
    }
  }

  async call(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws || !this.isConnected) {
      throw new Error("Dart VM Service is not connected.");
    }
    const id = ++this.reqId;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  async pause(isolateId?: string): Promise<void> {
    if (this.isolates.length === 0) {
      await this.refreshVM();
    }
    const targets = isolateId
      ? this.isolates.filter((iso) => iso.id === isolateId)
      : this.isolates;

    if (targets.length === 0) {
      // Fallback: pause whatever isolate is primary
      await this.call("pause", { isolateId: "isolates/main" });
      this.setIsolatePaused(undefined, true);
      return;
    }

    for (const target of targets) {
      await this.call("pause", { isolateId: target.id });
      target.isPaused = true;
    }
    this.notifyPauseChange();
  }

  async resume(isolateId?: string): Promise<void> {
    if (this.isolates.length === 0) {
      await this.refreshVM();
    }
    const targets = isolateId
      ? this.isolates.filter((iso) => iso.id === isolateId)
      : this.isolates;

    if (targets.length === 0) {
      await this.call("resume", { isolateId: "isolates/main" });
      this.setIsolatePaused(undefined, false);
      return;
    }

    for (const target of targets) {
      await this.call("resume", { isolateId: target.id });
      target.isPaused = false;
    }
    this.notifyPauseChange();
  }

  async getStack(isolateId?: string): Promise<any> {
    const targetId = isolateId || this.isolates[0]?.id || "isolates/main";
    return this.call("getStack", { isolateId: targetId });
  }

  async callExtension(method: string, params: Record<string, any> = {}): Promise<any> {
    const targetId = params.isolateId || this.isolates[0]?.id;
    return this.call(method, {
      ...params,
      ...(targetId ? { isolateId: targetId } : {}),
    });
  }

  getIsolates(): VmIsolate[] {
    return [...this.isolates];
  }

  getIsPaused(): boolean {
    return this.isolates.some((iso) => iso.isPaused);
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.isolates = [];
    for (const [, req] of this.pendingRequests) {
      req.reject(new Error("VM Service disconnected"));
    }
    this.pendingRequests.clear();
  }
}