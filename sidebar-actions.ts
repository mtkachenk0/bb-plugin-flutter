import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

interface FlutterStatus {
  status: "idle" | "building" | "starting" | "running" | "paused" | "stopping" | "error";
  isPaused: boolean;
  appId?: string | null;
  inspectMode?: boolean;
}

const STYLE_ID = "bb-flutter-sidebar-style";

const CSS_STYLES = `
.bb-flutter-sidebar-toolbar {
  position: absolute !important;
  right: 26px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  z-index: 15 !important;
  display: flex !important;
  align-items: center !important;
  gap: 2px !important;
  padding: 2px 3px !important;
  border-radius: 6px !important;
  background: color-mix(in oklab, var(--sidebar, #1e1e20) 90%, transparent) !important;
  border: 1px solid var(--sidebar-border, rgba(255, 255, 255, 0.12)) !important;
  backdrop-filter: blur(8px) !important;
  -webkit-backdrop-filter: blur(8px) !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2) !important;
  pointer-events: auto !important;
  user-select: none !important;
  box-sizing: border-box !important;
  height: 24px !important;
}

.bb-flutter-btn {
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 20px !important;
  height: 20px !important;
  min-width: 20px !important;
  min-height: 20px !important;
  max-width: 20px !important;
  max-height: 20px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 4px !important;
  background: transparent !important;
  cursor: pointer !important;
  pointer-events: auto !important;
  outline: none !important;
  box-sizing: border-box !important;
  transition: transform 0.12s ease, background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease !important;
  color: var(--sidebar-foreground, #a1a1aa) !important;
}

.bb-flutter-btn svg {
  width: 13px !important;
  height: 13px !important;
  min-width: 13px !important;
  min-height: 13px !important;
  display: block !important;
  pointer-events: none !important;
  flex-shrink: 0 !important;
}

.bb-flutter-btn:hover {
  transform: scale(1.18) !important;
  z-index: 2 !important;
}

.bb-flutter-btn:active {
  transform: scale(0.92) !important;
}

/* Play / Resume (Emerald) */
.bb-flutter-btn-resume {
  color: #10b981 !important;
}
.bb-flutter-btn-resume:hover {
  color: #34d399 !important;
  background: rgba(16, 185, 129, 0.22) !important;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4) !important;
}

/* Pause (Amber) */
.bb-flutter-btn-pause {
  color: #f59e0b !important;
}
.bb-flutter-btn-pause:hover {
  color: #fbbf24 !important;
  background: rgba(245, 158, 11, 0.22) !important;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.4) !important;
}

/* Paused state pulse on Play button */
.bb-flutter-paused-indicator {
  animation: bb-flutter-pulse 1.8s ease-in-out infinite !important;
  background: rgba(245, 158, 11, 0.18) !important;
  color: #fbbf24 !important;
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35) !important;
}

/* Hot Reload (Amber) */
.bb-flutter-btn-reload {
  color: #f59e0b !important;
}
.bb-flutter-btn-reload:hover {
  color: #fbbf24 !important;
  background: rgba(245, 158, 11, 0.22) !important;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.4) !important;
}

/* Hot Restart (Sky) */
.bb-flutter-btn-restart {
  color: #0ea5e9 !important;
}
.bb-flutter-btn-restart:hover {
  color: #38bdf8 !important;
  background: rgba(14, 165, 233, 0.22) !important;
  box-shadow: 0 0 6px rgba(14, 165, 233, 0.4) !important;
}

/* Stop (Rose) */
.bb-flutter-btn-stop {
  color: #f43f5e !important;
}
.bb-flutter-btn-stop:hover {
  color: #fb7185 !important;
  background: rgba(244, 63, 94, 0.22) !important;
  box-shadow: 0 0 6px rgba(244, 63, 94, 0.4) !important;
}

/* Inspect (Purple) */
.bb-flutter-btn-inspect {
  color: #a855f7 !important;
}
.bb-flutter-btn-inspect:hover {
  color: #c084fc !important;
  background: rgba(168, 85, 247, 0.22) !important;
  box-shadow: 0 0 6px rgba(168, 85, 247, 0.4) !important;
}
.bb-flutter-btn-inspect.active {
  background: rgba(168, 85, 247, 0.3) !important;
  color: #e9d5ff !important;
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.6) !important;
}

.bb-flutter-btn-disabled {
  opacity: 0.35 !important;
  pointer-events: none !important;
  cursor: not-allowed !important;
}

@keyframes bb-flutter-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes bb-flutter-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.bb-flutter-spin svg {
  animation: bb-flutter-spin 0.9s linear infinite !important;
}
`;

function ensureInjectedStyles() {
  if (typeof document === "undefined") return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  }
}

export function mountFlutterSidebarActions(context: PluginContentScriptContext) {
  const { signal } = context;
  let currentStatus: FlutterStatus = { status: "idle", isPaused: false };
  let inspectMode = false;
  let pendingAction: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let mountTimer: ReturnType<typeof setTimeout> | null = null;
  let mountedContainer: HTMLElement | null = null;
  let mountedRow: HTMLElement | null = null;
  let rowButton: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let observedTarget: Node | null = null;
  let playPauseIcon: string | null = null;

  // Every DOM write below happens inside the subtree the observer watches, so an
  // unguarded write re-enters the callback forever and wedges the main thread.
  function mutate(fn: () => void): void {
    observer?.disconnect();
    try {
      fn();
    } finally {
      attachObserver();
    }
  }

  ensureInjectedStyles();

  async function callRpc(method: string, params: unknown = null) {
    try {
      const res = await fetch(`/api/v1/plugins/flutter/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.result;
    } catch {
      return null;
    }
  }

  async function refreshStatus() {
    if (signal.aborted) return;
    const res = await callRpc("getStatus");
    if (res && typeof res === "object") {
      currentStatus = res as FlutterStatus;
      if (typeof (res as any).inspectMode === "boolean") {
        inspectMode = (res as any).inspectMode;
      }
      updateButtons();
    }
  }

  function schedulePoll(delayMs: number) {
    if (signal.aborted) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (signal.aborted) return;
      await refreshStatus();
      mount();
      schedulePoll(30_000);
    }, delayMs);
  }

  // Realtime event listener from app.tsx
  const onRealtimeState = (e: Event) => {
    const custom = e as CustomEvent<FlutterStatus>;
    if (custom.detail) {
      currentStatus = custom.detail;
      if (typeof custom.detail.inspectMode === "boolean") {
        inspectMode = custom.detail.inspectMode;
      }
      updateButtons();
    }
  };
  window.addEventListener("bb-flutter:state", onRealtimeState);

  function findFlutterRow(): HTMLElement | null {
    const sidebar = document.querySelector('[data-testid="plugin-nav-sidebar-items"]');
    const root = sidebar || document;
    const buttons = root.querySelectorAll("button");

    for (const btn of buttons) {
      if (btn.getAttribute("aria-label")?.includes("options")) continue;
      // Look for the specific text span
      const text = btn.textContent?.trim() || "";
      if (text === "Flutter" || text.startsWith("Flutter")) {
        const row =
          btn.closest<HTMLElement>(".bb-sidebar-hover-actions-row") ||
          (btn.closest("li") as HTMLElement | null) ||
          (btn.parentElement as HTMLElement | null);
        if (row) {
          rowButton = btn;
          return row;
        }
      }
    }
    return null;
  }

  function createButton(
    title: string,
    svgHtml: string,
    baseClass: string,
    onClick: (e: MouseEvent) => Promise<void> | void,
  ) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.className = `bb-flutter-btn ${baseClass}`;
    btn.innerHTML = svgHtml;

    // Apply inline style fallbacks
    btn.style.width = "20px";
    btn.style.height = "20px";
    btn.style.minWidth = "20px";
    btn.style.minHeight = "20px";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.padding = "0";
    btn.style.margin = "0";
    btn.style.border = "none";
    btn.style.background = "transparent";
    btn.style.cursor = "pointer";

    // Guard all pointer/mouse events to prevent row selection or split navigation
    const stop = (e: Event) => {
      e.stopPropagation();
    };
    btn.addEventListener("pointerdown", stop);
    btn.addEventListener("mousedown", stop);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("mouseup", stop);
    btn.addEventListener("dblclick", stop);

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await onClick(e);
    });

    return btn;
  }

  // Icons
  const playIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  const hotReloadIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
  const hotRestartIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
  const stopIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
  const inspectIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;

  let playPauseBtn: HTMLButtonElement;
  let reloadBtn: HTMLButtonElement;
  let restartBtn: HTMLButtonElement;
  let stopBtn: HTMLButtonElement;
  let inspectBtn: HTMLButtonElement;

  function updateButtons() {
    mutate(applyButtonState);
  }

  function applyButtonState() {
    if (!mountedContainer) return;
    const isRunning = currentStatus.status === "running" || currentStatus.status === "paused";
    const isPaused = currentStatus.isPaused || currentStatus.status === "paused";

    if (isRunning) {
      mountedContainer.style.display = "flex";
      mountedContainer.style.opacity = "1";
      mountedContainer.style.pointerEvents = "auto";
      if (rowButton) {
        rowButton.style.paddingRight = "138px";
      }
    } else {
      mountedContainer.style.display = "none";
      if (rowButton) {
        rowButton.style.paddingRight = "";
      }
      return;
    }

    // 1. Play / Pause
    const wantIcon = isPaused ? playIcon : pauseIcon;
    if (playPauseIcon !== wantIcon) {
      playPauseBtn.innerHTML = wantIcon;
      playPauseIcon = wantIcon;
    }
    if (isPaused) {
      playPauseBtn.title = "Resume execution (p)";
      playPauseBtn.setAttribute("aria-label", "Resume execution");
      playPauseBtn.className = "bb-flutter-btn bb-flutter-btn-resume bb-flutter-paused-indicator";
    } else {
      playPauseBtn.title = "Pause execution (p)";
      playPauseBtn.setAttribute("aria-label", "Pause execution");
      playPauseBtn.className = "bb-flutter-btn bb-flutter-btn-pause";
    }

    // 2. Reload
    reloadBtn.title = "Hot Reload (r)";
    reloadBtn.setAttribute("aria-label", "Hot Reload");
    if (pendingAction === "reload") {
      reloadBtn.className = "bb-flutter-btn bb-flutter-btn-reload bb-flutter-spin";
    } else {
      reloadBtn.className = "bb-flutter-btn bb-flutter-btn-reload";
    }

    // 3. Restart
    restartBtn.title = "Hot Restart (Shift+R)";
    restartBtn.setAttribute("aria-label", "Hot Restart");
    if (pendingAction === "restart") {
      restartBtn.className = "bb-flutter-btn bb-flutter-btn-restart bb-flutter-spin";
    } else {
      restartBtn.className = "bb-flutter-btn bb-flutter-btn-restart";
    }

    // 4. Stop
    stopBtn.title = "Stop Flutter Session";
    stopBtn.setAttribute("aria-label", "Stop Flutter Session");
    if (pendingAction === "stop") {
      stopBtn.className = "bb-flutter-btn bb-flutter-btn-stop bb-flutter-btn-disabled";
    } else {
      stopBtn.className = "bb-flutter-btn bb-flutter-btn-stop";
    }

    // 5. Inspect
    inspectBtn.title = inspectMode
      ? "Widget Inspector Active (Click to toggle)"
      : "Inspect Widget Tree (Select Mode)";
    inspectBtn.setAttribute("aria-label", "Inspect Widget Tree");
    if (inspectMode) {
      inspectBtn.className = "bb-flutter-btn bb-flutter-btn-inspect active";
    } else {
      inspectBtn.className = "bb-flutter-btn bb-flutter-btn-inspect";
    }
  }

  function mount() {
    // Fast path: avoid the full querySelectorAll("button") scan on every mutation.
    if (
      mountedContainer?.isConnected &&
      mountedRow?.isConnected &&
      mountedRow.contains(mountedContainer)
    ) {
      updateButtons();
      return;
    }

    mutate(() => mountUnguarded());
  }

  function mountUnguarded() {
    ensureInjectedStyles();

    const row = findFlutterRow();
    if (!row) return;

    if (mountedContainer && mountedContainer.isConnected && row.contains(mountedContainer)) {
      applyButtonState();
      return;
    }

    if (mountedContainer && mountedContainer.parentNode) {
      mountedContainer.parentNode.removeChild(mountedContainer);
      mountedContainer = null;
    }

    mountedRow = row;

    const container = document.createElement("div");
    container.setAttribute("data-flutter-sidebar-actions", "true");
    container.className = "bb-flutter-sidebar-toolbar";

    // Set full inline styles to ensure exact layout independent of host CSS
    container.style.position = "absolute";
    container.style.right = "26px";
    container.style.top = "50%";
    container.style.transform = "translateY(-50%)";
    container.style.zIndex = "15";
    container.style.display = "none";
    container.style.alignItems = "center";
    container.style.gap = "2px";
    container.style.padding = "2px 3px";
    container.style.borderRadius = "6px";
    container.style.height = "24px";
    container.style.boxSizing = "border-box";
    container.style.pointerEvents = "auto";
    container.style.userSelect = "none";

    const stopPropagation = (e: Event) => e.stopPropagation();
    container.addEventListener("pointerdown", stopPropagation);
    container.addEventListener("mousedown", stopPropagation);
    container.addEventListener("click", stopPropagation);

    playPauseBtn = createButton("Pause / Resume", pauseIcon, "bb-flutter-btn-pause", async () => {
      if (pendingAction) return;
      pendingAction = "playPause";
      updateButtons();
      try {
        const isPaused = currentStatus.isPaused || currentStatus.status === "paused";
        const next = await callRpc(isPaused ? "resume" : "pause");
        if (next && typeof next === "object") {
          currentStatus = next as FlutterStatus;
        }
      } finally {
        pendingAction = null;
        updateButtons();
        await refreshStatus();
      }
    });

    reloadBtn = createButton("Hot Reload (r)", hotReloadIcon, "bb-flutter-btn-reload", async () => {
      if (pendingAction) return;
      pendingAction = "reload";
      updateButtons();
      try {
        await callRpc("hotReload");
      } finally {
        pendingAction = null;
        updateButtons();
        await refreshStatus();
      }
    });

    restartBtn = createButton("Hot Restart (Shift+R)", hotRestartIcon, "bb-flutter-btn-restart", async () => {
      if (pendingAction) return;
      pendingAction = "restart";
      updateButtons();
      try {
        await callRpc("hotRestart");
      } finally {
        pendingAction = null;
        updateButtons();
        await refreshStatus();
      }
    });

    stopBtn = createButton("Stop Application", stopIcon, "bb-flutter-btn-stop", async () => {
      if (pendingAction) return;
      pendingAction = "stop";
      updateButtons();
      try {
        const next = await callRpc("stopSession");
        if (next && typeof next === "object") {
          currentStatus = next as FlutterStatus;
        }
      } finally {
        pendingAction = null;
        updateButtons();
        await refreshStatus();
      }
    });

    inspectBtn = createButton("Inspect Widget Tree", inspectIcon, "bb-flutter-btn-inspect", async () => {
      if (pendingAction) return;
      pendingAction = "inspect";
      updateButtons();
      try {
        const nextMode = !inspectMode;
        await callRpc("callServiceExtension", { name: "selectWidgetMode", value: nextMode });
        inspectMode = nextMode;
      } finally {
        pendingAction = null;
        updateButtons();
        await refreshStatus();
      }
    });

    container.appendChild(playPauseBtn);
    container.appendChild(reloadBtn);
    container.appendChild(restartBtn);
    container.appendChild(stopBtn);
    container.appendChild(inspectBtn);

    // Insert before the options button or append to row
    const hoverActions = row.querySelector(".bb-sidebar-hover-actions");
    if (hoverActions) {
      row.insertBefore(container, hoverActions);
    } else {
      row.appendChild(container);
    }

    mountedContainer = container;
    playPauseIcon = pauseIcon;
    applyButtonState();
  }

  function scheduleMount() {
    if (signal.aborted || mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mount();
    }, 100);
  }

  function attachObserver() {
    if (signal.aborted) return;
    // Scope to the sidebar when it exists so unrelated app re-renders don't wake us.
    const target = document.querySelector('[data-testid="plugin-nav-sidebar-items"]') || document.body;
    if (observer && observedTarget === target) {
      observer.observe(target, { childList: true, subtree: true });
      return;
    }
    observer?.disconnect();
    observer = new MutationObserver(scheduleMount);
    observedTarget = target;
    observer.observe(target, { childList: true, subtree: true });
  }

  attachObserver();
  mount();
  refreshStatus();
  schedulePoll(30_000);

  // Teardown
  signal.addEventListener("abort", () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (mountTimer) clearTimeout(mountTimer);
    observer?.disconnect();
    observer = null;
    window.removeEventListener("bb-flutter:state", onRealtimeState);
    if (rowButton) {
      rowButton.style.paddingRight = "";
      rowButton = null;
    }
    if (mountedContainer && mountedContainer.parentNode) {
      mountedContainer.parentNode.removeChild(mountedContainer);
      mountedContainer = null;
    }
    const injectedStyle = document.getElementById(STYLE_ID);
    if (injectedStyle && injectedStyle.parentNode) {
      injectedStyle.parentNode.removeChild(injectedStyle);
    }
  });
}
