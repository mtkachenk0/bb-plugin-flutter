import { mountFlutterSidebarActions } from "./sidebar-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  BbProjectInfo,
  FlutterDevice,
  FlutterEmulator,
  FlutterProject,
  LaunchConfiguration,
  LogEntry,
} from "./lib/types";

type SessionState = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
> extends infer T
  ? T extends { status: any }
    ? T
    : any
  : any;

type ActiveTab = "inspector" | "debugger" | "logs" | "config";

function cleanRpcPayload<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive";
  size?: "default" | "sm" | "icon";
}

function Button({ variant = "default", size = "default", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-2.5 text-xs",
        size === "icon" && "h-8 w-8",
        size === "default" && "h-9 px-4 py-2 text-sm",
        variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "outline" && "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        variant === "ghost" && "hover:bg-accent hover:text-accent-foreground",
        variant === "secondary" && "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        variant === "destructive" && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        className,
      )}
    />
  );
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

function Input({ className, ...props }: InputProps) {
  return (
    <input
      {...props}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}

export function FlutterPanel() {
  const rpc = useRpc<typeof rpcContract>();

  // State
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [devices, setDevices] = useState<FlutterDevice[]>([]);
  const [emulators, setEmulators] = useState<FlutterEmulator[]>([]);
  const [bbProjects, setBbProjects] = useState<BbProjectInfo[]>([]);
  const [bbProjectsError, setBbProjectsError] = useState<string | null>(null);

  const [selectedBbProjectId, setSelectedBbProjectId] = useState<string>("");
  const [selectedSubprojectPath, setSelectedSubprojectPath] = useState<string>("");
  const [customPathInput, setCustomPathInput] = useState<string>("");

  // Inspect state for currently resolved project
  const [activeFlutterProject, setActiveFlutterProject] = useState<FlutterProject | null>(null);
  const [pathInspectError, setPathInspectError] = useState<string | null>(null);
  const [inspectingPath, setInspectingPath] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("config");

  // Form selection
  const [effectiveProjectPath, setEffectiveProjectPath] = useState<string>("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [selectedTarget, setSelectedTarget] = useState<string>("lib/main.dart");
  const [selectedFlavor, setSelectedFlavor] = useState<string>("");
  const [selectedMode, setSelectedMode] = useState<"debug" | "profile" | "release">("debug");
  const [selectedLaunchConfig, setSelectedLaunchConfig] = useState<string>("");
  const [selectedAdditionalArgs, setSelectedAdditionalArgs] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const inferFlavorForProject = (entrypoint: string, project: FlutterProject): string => {
    if (project.launchConfigurations) {
      const matched = project.launchConfigurations.find(
        (c) => c.target === entrypoint || c.target === `lib/${entrypoint}` || `lib/${c.target}` === entrypoint
      );
      if (matched && matched.flavor !== undefined) return matched.flavor;
    }
    const epBase = entrypoint.replace(/^[./]+/, "").replace(/^lib\//, "");
    const m = epBase.match(/^main_([a-zA-Z0-9_-]+)\.dart$/);
    if (m && m[1]) return m[1];
    if (epBase === "main.dart") {
      if (project.flavors.includes("dev")) return "dev";
      if (project.flavors.includes("development")) return "development";
      return "";
    }
    return "";
  };

  const inferTargetForProject = (flavor: string, project: FlutterProject): string => {
    if (project.launchConfigurations) {
      const matched = project.launchConfigurations.find(
        (c) =>
          c.flavor?.toLowerCase() === flavor.toLowerCase() ||
          c.name.toLowerCase() === flavor.toLowerCase()
      );
      if (matched && matched.target) {
        return matched.target.startsWith("lib/") ? matched.target : `lib/${matched.target}`;
      }
    }
    if (!flavor) {
      if (project.entrypoints.includes("main.dart")) return "lib/main.dart";
      return project.entrypoints[0] ? `lib/${project.entrypoints[0]}` : "lib/main.dart";
    }
    const specific = `main_${flavor}.dart`;
    if (project.entrypoints.includes(specific)) return `lib/${specific}`;
    if ((flavor === "dev" || flavor === "development") && project.entrypoints.includes("main.dart")) {
      return "lib/main.dart";
    }
    return project.entrypoints[0] ? `lib/${project.entrypoints[0]}` : "lib/main.dart";
  };

  const applyProjectDefaults = useCallback((project: FlutterProject) => {
    setActiveFlutterProject(project);
    if (project.launchConfigurations && project.launchConfigurations.length > 0) {
      const pref =
        project.launchConfigurations.find((c) => c.name.toLowerCase() === "dev") ||
        project.launchConfigurations.find((c) => c.name.toLowerCase() === "staging") ||
        project.launchConfigurations.find((c) => (c.mode || "debug") === "debug") ||
        project.launchConfigurations[0]!;
      setSelectedLaunchConfig(pref.name);
      if (pref.target) {
        setSelectedTarget(pref.target.startsWith("lib/") ? pref.target : `lib/${pref.target}`);
      } else if (project.entrypoints[0]) {
        setSelectedTarget(`lib/${project.entrypoints[0]}`);
      }
      setSelectedFlavor(pref.flavor ?? "");
      if (pref.mode) setSelectedMode(pref.mode);
      if (pref.args) {
        const extra = pref.args.filter(
          (a, i, arr) => a !== "--flavor" && arr[i - 1] !== "--flavor" && !a.startsWith("--flavor=")
        );
        setSelectedAdditionalArgs(extra);
      } else {
        setSelectedAdditionalArgs([]);
      }
    } else {
      setSelectedLaunchConfig("custom");
      const ep = project.entrypoints[0] || "main.dart";
      setSelectedTarget(`lib/${ep}`);
      const inferred = inferFlavorForProject(ep, project);
      setSelectedFlavor(inferred);
      setSelectedAdditionalArgs([]);
    }
  }, []);

  // Extension toggles
  const [debugPaint, setDebugPaint] = useState(false);
  const [selectWidgetMode, setSelectWidgetMode] = useState(false);
  const [performanceOverlay, setPerformanceOverlay] = useState(false);
  const [slowAnimations, setSlowAnimations] = useState(false);

  // Status & loading
  const [actionPending, setActionPending] = useState(false);
  const [notification, setNotification] = useState<{ text: string; isError?: boolean } | null>(null);
  const [logFilter, setLogFilter] = useState<string>("");
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);

  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  const notify = useCallback((text: string, isError = false) => {
    setNotification({ text, isError });
    setTimeout(() => {
      setNotification((curr) => (curr?.text === text ? null : curr));
    }, 4000);
  }, []);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const state = await rpc.call("getStatus", null);
      setSessionState(state);
      if (state.status === "running" || state.status === "building" || state.status === "paused") {
        setActiveTab((prev) => (prev === "config" ? "inspector" : prev));
      }
    } catch {
      // ignore
    }
  }, [rpc]);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await rpc.call("listDevices", null);
      setDevices(res.devices);
      if (res.devices.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(res.devices[0]!.id);
      }
    } catch (cause) {
      notify(`Failed to fetch devices: ${String(cause)}`, true);
    }
  }, [rpc, selectedDeviceId, notify]);

  const fetchEmulators = useCallback(async () => {
    try {
      const res = await rpc.call("listEmulators", null);
      setEmulators(res.emulators);
    } catch {
      // ignore
    }
  }, [rpc]);

  // Fetch BB projects
  const fetchBbProjects = useCallback(async () => {
    try {
      const res = await rpc.call("getBbProjects", null);
      setBbProjects(res.projects);
      setBbProjectsError(res.error);

      if (res.projects.length > 0 && !effectiveProjectPath) {
        // Find first project that is a Flutter project or has Flutter subprojects
        const flutterProject =
          res.projects.find((p) => p.isFlutter && p.flutterProject) ||
          res.projects.find((p) => p.subprojects.length > 0) ||
          res.projects[0]!;
        setSelectedBbProjectId(flutterProject.id);

        if (flutterProject.isFlutter && flutterProject.flutterProject) {
          setEffectiveProjectPath(flutterProject.path);
          setCustomPathInput(flutterProject.path);
          applyProjectDefaults(flutterProject.flutterProject);
        } else if (flutterProject.subprojects.length > 0) {
          const sub = flutterProject.subprojects[0]!;
          setSelectedSubprojectPath(sub.path);
          setEffectiveProjectPath(sub.path);
          setCustomPathInput(sub.path);
          applyProjectDefaults(sub);
        } else {
          setEffectiveProjectPath(flutterProject.path);
          setCustomPathInput(flutterProject.path);
          setActiveFlutterProject(null);
        }
      }
    } catch (err) {
      setBbProjects([]);
      setBbProjectsError((err as Error).message || "Failed to load BB projects");
    }
  }, [rpc, effectiveProjectPath, applyProjectDefaults]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await rpc.call("getLogs", { limit: 300 });
      setLogs(res.logs);
    } catch {
      // ignore
    }
  }, [rpc]);

  useEffect(() => {
    fetchStatus();
    fetchDevices();
    fetchEmulators();
    fetchBbProjects();
    fetchLogs();
  }, [fetchStatus, fetchDevices, fetchEmulators, fetchBbProjects, fetchLogs]);

  // List of all detected Flutter projects for easy switching
  const flutterAppsList = useMemo(() => {
    const list: { name: string; path: string; project: FlutterProject }[] = [];
    const seen = new Set<string>();
    for (const p of bbProjects) {
      if (p.isFlutter && p.flutterProject && !seen.has(p.path)) {
        seen.add(p.path);
        list.push({ name: p.name, path: p.path, project: p.flutterProject });
      }
      for (const sub of p.subprojects) {
        if (!seen.has(sub.path)) {
          seen.add(sub.path);
          list.push({ name: sub.name, path: sub.path, project: sub });
        }
      }
    }
    return list;
  }, [bbProjects]);

  const currentBbProject = useMemo(
    () => bbProjects.find((p) => p.id === selectedBbProjectId || p.path === effectiveProjectPath),
    [bbProjects, selectedBbProjectId, effectiveProjectPath],
  );

  const handleSubprojectChange = (subPath: string) => {
    setSelectedSubprojectPath(subPath);
    const p = currentBbProject;
    const sub = p?.subprojects.find((s) => s.path === subPath);
    if (sub) {
      setEffectiveProjectPath(sub.path);
      setCustomPathInput(sub.path);
      setPathInspectError(null);
      applyProjectDefaults(sub);
    }
  };

  const inspectCustomPath = useCallback(
    async (pathStr: string) => {
      const trimmed = pathStr.trim();
      if (!trimmed) {
        setActiveFlutterProject(null);
        setPathInspectError(null);
        return;
      }
      setInspectingPath(true);
      try {
        const res = await rpc.call("inspectPath", { path: trimmed });
        if (res.isFlutter && res.project) {
          setActiveFlutterProject(res.project);
          setPathInspectError(null);
          applyProjectDefaults(res.project);
        } else if (res.subprojects && res.subprojects.length > 0) {
          const sub = res.subprojects[0]!;
          setActiveFlutterProject(sub);
          setPathInspectError(null);
          applyProjectDefaults(sub);
        } else {
          setActiveFlutterProject(null);
          setPathInspectError(res.error || "Not a valid Flutter project");
        }
      } catch (cause) {
        setActiveFlutterProject(null);
        setPathInspectError(String(cause));
      } finally {
        setInspectingPath(false);
      }
    },
    [rpc, applyProjectDefaults],
  );

  const handleCustomPathChange = (val: string) => {
    setCustomPathInput(val);
    setEffectiveProjectPath(val);
    inspectCustomPath(val);
  };

  const handlePathSelected = async (dirPath: string) => {
    const trimmed = dirPath.trim();
    if (!trimmed) return;
    setCustomPathInput(trimmed);
    setEffectiveProjectPath(trimmed);
    setInspectingPath(true);
    try {
      const res = await rpc.call("inspectPath", { path: trimmed });
      if (res.isFlutter && res.project) {
        setEffectiveProjectPath(res.project.path);
        setCustomPathInput(res.project.path);
        applyProjectDefaults(res.project);
        setPathInspectError(null);
        notify(`Selected Flutter project: ${res.project.name}`);
      } else if (res.subprojects && res.subprojects.length > 0) {
        const sub = res.subprojects[0]!;
        setEffectiveProjectPath(sub.path);
        setCustomPathInput(sub.path);
        applyProjectDefaults(sub);
        setPathInspectError(null);
        notify(`Detected Flutter app in monorepo: ${sub.name}`);
      } else {
        setActiveFlutterProject(null);
        setPathInspectError(res.error || "No pubspec.yaml found in directory");
      }
    } catch (err) {
      setActiveFlutterProject(null);
      setPathInspectError((err as Error).message || "Inspection failed");
    } finally {
      setInspectingPath(false);
    }
  };

  const handlePickDirectory = async () => {
    try {
      const initialPath = effectiveProjectPath ? effectiveProjectPath.trim() : null;
      const res = await rpc.call(
        "pickDirectory",
        initialPath ? { initialPath } : null
      );
      if (res?.path) {
        await handlePathSelected(res.path);
        return;
      }
      if (res?.canceled) {
        return;
      }
    } catch {
      // ignore rpc failure and fallback to browser/electron file picker
    }
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0] as any;
    if (file.path) {
      const relPath = file.webkitRelativePath || "";
      let dir = file.path;
      if (relPath && dir.endsWith(relPath)) {
        const topFolder = relPath.split("/")[0] || "";
        const base = dir.slice(0, dir.length - relPath.length);
        dir = topFolder ? `${base}${topFolder}` : base;
      } else {
        dir = dir.substring(0, dir.lastIndexOf("/"));
      }
      handlePathSelected(dir);
    }
    e.target.value = "";
  };

  // Synchronized controls for Launch Config, Flavor, Target, and Mode
  const handleLaunchConfigChange = (cfgName: string) => {
    setSelectedLaunchConfig(cfgName);
    if (!activeFlutterProject?.launchConfigurations || cfgName === "custom") return;

    const cfg = activeFlutterProject.launchConfigurations.find((c) => c.name === cfgName);
    if (cfg) {
      if (cfg.target) {
        setSelectedTarget(cfg.target.startsWith("lib/") ? cfg.target : `lib/${cfg.target}`);
      }
      if (cfg.flavor !== undefined) {
        setSelectedFlavor(cfg.flavor);
      }
      if (cfg.mode) {
        setSelectedMode(cfg.mode);
      }
      if (cfg.args) {
        const extra = cfg.args.filter(
          (a, i, arr) => a !== "--flavor" && arr[i - 1] !== "--flavor" && !a.startsWith("--flavor=")
        );
        setSelectedAdditionalArgs(extra);
      } else {
        setSelectedAdditionalArgs([]);
      }
    }
  };

  const handleFlavorChange = (newFlavor: string) => {
    setSelectedFlavor(newFlavor);
    if (!activeFlutterProject) return;

    if (activeFlutterProject.launchConfigurations && activeFlutterProject.launchConfigurations.length > 0) {
      const match =
        activeFlutterProject.launchConfigurations.find(
          (c) =>
            (c.flavor?.toLowerCase() === newFlavor.toLowerCase() ||
              c.name.toLowerCase() === newFlavor.toLowerCase()) &&
            (c.mode === selectedMode || (!c.mode && selectedMode === "debug"))
        ) ||
        activeFlutterProject.launchConfigurations.find(
          (c) =>
            c.flavor?.toLowerCase() === newFlavor.toLowerCase() ||
            c.name.toLowerCase() === newFlavor.toLowerCase()
        );

      if (match) {
        setSelectedLaunchConfig(match.name);
        if (match.target) {
          setSelectedTarget(match.target.startsWith("lib/") ? match.target : `lib/${match.target}`);
        }
        if (match.mode) {
          setSelectedMode(match.mode);
        }
        if (match.args) {
          const extra = match.args.filter(
            (a, i, arr) => a !== "--flavor" && arr[i - 1] !== "--flavor" && !a.startsWith("--flavor=")
          );
          setSelectedAdditionalArgs(extra);
        }
        return;
      }
    }

    const inferred = inferTargetForProject(newFlavor, activeFlutterProject);
    if (inferred) {
      setSelectedTarget(inferred);
    }
    setSelectedLaunchConfig("custom");
  };

  const handleTargetChange = (newTarget: string) => {
    setSelectedTarget(newTarget);
    if (!activeFlutterProject) return;

    const norm = newTarget.replace(/^[./]+/, "").replace(/^lib\//, "");
    if (activeFlutterProject.launchConfigurations && activeFlutterProject.launchConfigurations.length > 0) {
      const match =
        activeFlutterProject.launchConfigurations.find((c) => {
          if (!c.target) return false;
          const cNorm = c.target.replace(/^[./]+/, "").replace(/^lib\//, "");
          return cNorm === norm && (c.mode === selectedMode || (!c.mode && selectedMode === "debug"));
        }) ||
        activeFlutterProject.launchConfigurations.find((c) => {
          if (!c.target) return false;
          const cNorm = c.target.replace(/^[./]+/, "").replace(/^lib\//, "");
          return cNorm === norm;
        });

      if (match) {
        setSelectedLaunchConfig(match.name);
        if (match.flavor !== undefined) {
          setSelectedFlavor(match.flavor);
        }
        if (match.mode) {
          setSelectedMode(match.mode);
        }
        if (match.args) {
          const extra = match.args.filter(
            (a, i, arr) => a !== "--flavor" && arr[i - 1] !== "--flavor" && !a.startsWith("--flavor=")
          );
          setSelectedAdditionalArgs(extra);
        }
        return;
      }
    }

    const inferred = inferFlavorForProject(newTarget, activeFlutterProject);
    if (inferred) {
      setSelectedFlavor(inferred);
    }
    setSelectedLaunchConfig("custom");
  };

  const handleModeChange = (newMode: "debug" | "profile" | "release") => {
    setSelectedMode(newMode);
    if (activeFlutterProject?.launchConfigurations) {
      const match = activeFlutterProject.launchConfigurations.find(
        (c) =>
          (c.mode || "debug") === newMode &&
          (c.flavor?.toLowerCase() === selectedFlavor.toLowerCase() ||
            (!selectedFlavor && !c.flavor))
      );
      if (match) {
        setSelectedLaunchConfig(match.name);
        if (match.target) {
          setSelectedTarget(match.target.startsWith("lib/") ? match.target : `lib/${match.target}`);
        }
      }
    }
  };

  // Realtime handlers
  useRealtime("flutter:state", (state: any) => {
    setSessionState(state);
    if (state.status === "running" || state.status === "building") {
      setActiveTab((prev) => (prev === "config" ? "inspector" : prev));
    }
  });

  useRealtime("flutter:log", (batch: any) => {
    const entries: LogEntry[] = Array.isArray(batch) ? batch : [batch];
    if (entries.length === 0) return;
    setLogs((prev) => [...prev, ...entries].slice(-500));
  });

  // Auto-scroll logs
  useEffect(() => {
    if (!autoScrollLogs || activeTab !== "logs") return;
    const el = logsContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScrollLogs, activeTab]);

  // Actions
  const handleStart = async () => {
    const projectPathToUse = effectiveProjectPath || customPathInput;
    if (!projectPathToUse || !selectedDeviceId) {
      notify("Please select a project path and target device.", true);
      return;
    }
    setActionPending(true);
    try {
      const payload = cleanRpcPayload({
        projectPath: projectPathToUse,
        deviceId: selectedDeviceId,
        mode: selectedMode,
        target: selectedTarget ? selectedTarget.trim() : undefined,
        flavor: selectedFlavor ? selectedFlavor.trim() : undefined,
        additionalArgs: selectedAdditionalArgs.length > 0 ? selectedAdditionalArgs : undefined,
      });
      const res = await rpc.call("startSession", payload);
      setSessionState(res);
      setActiveTab("logs");
      notify("Flutter build initiated.");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    try {
      const res = await rpc.call("stopSession", null);
      setSessionState(res);
      notify("Flutter session stopped.");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleHotReload = async () => {
    setActionPending(true);
    try {
      const res = await rpc.call("hotReload", null);
      notify(`⚡ ${res.message}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleHotRestart = async () => {
    setActionPending(true);
    try {
      const res = await rpc.call("hotRestart", null);
      notify(`🔄 ${res.message}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleTogglePause = async () => {
    setActionPending(true);
    try {
      if (sessionState?.isPaused) {
        const res = await rpc.call("resume", null);
        setSessionState(res);
        notify("▶️ Resumed execution.");
      } else {
        const res = await rpc.call("pause", null);
        setSessionState(res);
        notify("⏸ Paused execution.");
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleLaunchEmulator = async (emulatorId: string) => {
    setActionPending(true);
    try {
      notify(`Launching emulator ${emulatorId}...`);
      const res = await rpc.call("launchEmulator", { emulatorId });
      notify(res.message);
      setTimeout(() => fetchDevices(), 3000);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setActionPending(false);
    }
  };

  const handleToggleExtension = async (
    name: "selectWidgetMode" | "debugPaint" | "performanceOverlay" | "slowAnimations",
  ) => {
    try {
      const res = await rpc.call("callServiceExtension", { name });
      if (name === "selectWidgetMode") setSelectWidgetMode(res.value);
      if (name === "debugPaint") setDebugPaint(res.value);
      if (name === "performanceOverlay") setPerformanceOverlay(res.value);
      if (name === "slowAnimations") setSlowAnimations(res.value);
      notify(`${name}: ${res.value ? "ON" : "OFF"}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }
      if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleHotReload();
      } else if (e.key === "R" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleHotRestart();
      } else if (e.key === "p" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleTogglePause();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const isRunning = sessionState?.status === "running" || sessionState?.status === "paused";
  const isBuilding = sessionState?.status === "building" || sessionState?.status === "starting";

  const filteredLogs = useMemo(() => {
    if (!logFilter.trim()) return logs;
    const lower = logFilter.toLowerCase();
    return logs.filter(
      (l) => l.message.toLowerCase().includes(lower) || l.type.toLowerCase().includes(lower),
    );
  }, [logs, logFilter]);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground select-none">
      {/* Top Banner / Notification */}
      {notification && (
        <div
          className={cn(
            "fixed top-3 right-3 z-50 rounded-md px-3 py-2 text-xs font-medium shadow-md transition-all",
            notification.isError
              ? "bg-destructive text-destructive-foreground"
              : "bg-primary text-primary-foreground",
          )}
        >
          {notification.text}
        </div>
      )}

      {/* Header Toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-semibold tracking-tight text-foreground">
            <span className="text-lg">⚡</span>
            <span>Flutter Studio</span>
          </div>

          {/* Status Indicator */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                isRunning && !sessionState?.isPaused && "bg-emerald-500 animate-pulse",
                sessionState?.isPaused && "bg-amber-400",
                isBuilding && "bg-sky-400 animate-spin",
                sessionState?.status === "error" && "bg-destructive",
                (!isRunning && !isBuilding && sessionState?.status !== "error") && "bg-muted-foreground/40",
              )}
            />
            <span className="text-xs font-medium capitalize text-muted-foreground">
              {sessionState?.status || "Idle"}
              {sessionState?.isPaused && " (Paused)"}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {/* Hot Reload */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleHotReload}
            disabled={!isRunning || actionPending}
            title="Hot Reload (r)"
            className="gap-1.5 text-xs text-amber-500 hover:text-amber-400 hover:bg-amber-500/10 border-amber-500/30"
          >
            <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span className="hidden sm:inline">Hot Reload</span>
          </Button>

          {/* Hot Restart */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleHotRestart}
            disabled={!isRunning || actionPending}
            title="Hot Restart (Shift+R)"
            className="gap-1.5 text-xs text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 border-sky-500/30"
          >
            <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            <span className="hidden sm:inline">Restart</span>
          </Button>

          {/* Play/Pause */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTogglePause}
            disabled={!isRunning || actionPending}
            title={sessionState?.isPaused ? "Resume (p)" : "Pause (p)"}
            className="h-8 w-8 p-0"
          >
            {sessionState?.isPaused ? (
              <svg className="size-3.5 text-emerald-500" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            ) : (
              <svg className="size-3.5 text-foreground" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            )}
          </Button>

          {/* Stop */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStop}
            disabled={!isRunning || actionPending}
            title="Stop Application"
            className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10"
          >
            <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </Button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex h-10 shrink-0 border-b border-border bg-muted/20 px-4">
        <button
          type="button"
          onClick={() => setActiveTab("config")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 text-xs font-medium transition-colors",
            activeTab === "config"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          🚀 Run Configuration
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("inspector")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 text-xs font-medium transition-colors",
            activeTab === "inspector"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          🔍 Widget Inspector
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("debugger")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 text-xs font-medium transition-colors",
            activeTab === "debugger"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          🐛 Debugger
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("logs")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 text-xs font-medium transition-colors",
            activeTab === "logs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          📄 Console Logs
          {logs.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">
              {logs.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab Content Areas */}
      <div className="relative flex-1 overflow-hidden">
        {/* Tab 1: Run Config & Device Management */}
        {activeTab === "config" && (
          <div className="h-full overflow-y-auto p-4 md:p-6">
            <div className="mx-auto max-w-4xl space-y-6">
              {/* Flutter Project Card */}
              <div className="rounded-xl border border-border bg-card p-4 md:p-5 shadow-sm space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                      <span>📁 Flutter Project</span>
                    </h2>
                    {activeFlutterProject && (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
                        {activeFlutterProject.name}
                      </span>
                    )}
                  </div>

                  {/* Hidden file picker input for directory selection fallback */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    // @ts-ignore
                    webkitdirectory=""
                    // @ts-ignore
                    directory=""
                    style={{ display: "none" }}
                    onChange={handleFileInputChange}
                  />

                  {/* Open / Browse Folder Button */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePickDirectory}
                    className="gap-1.5 text-xs font-medium border-primary/40 text-primary hover:bg-primary/10 shadow-sm"
                  >
                    <span>📂</span>
                    <span>Choose Folder...</span>
                  </Button>
                </div>

                {/* Project Path Input with Browse Button */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground block">
                    Directory Path
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        className="h-9 text-xs font-mono pr-8"
                        value={customPathInput || effectiveProjectPath}
                        onChange={(e) => handleCustomPathChange(e.target.value)}
                        placeholder="e.g. /Users/maximtkachenko/work/parknet/parkane_app"
                      />
                      {inspectingPath && (
                        <span className="absolute right-2.5 top-2.5 size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handlePickDirectory}
                      className="h-9 px-3 gap-1.5 text-xs shrink-0"
                    >
                      <span>📁</span>
                      <span>Browse...</span>
                    </Button>
                  </div>
                </div>

                {/* Quick Select Project Dropdown */}
                {flutterAppsList.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground block">
                      Quick Switch (Detected Flutter Apps)
                    </label>
                    <select
                      value={effectiveProjectPath}
                      onChange={(e) => {
                        if (e.target.value) {
                          handlePathSelected(e.target.value);
                        }
                      }}
                      className="w-full rounded border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select a detected Flutter project...</option>
                      {flutterAppsList.map((app) => (
                        <option key={app.path} value={app.path}>
                          ⭐ {app.name} — {app.path}
                        </option>
                      ))}
                      {bbProjects
                        .filter((p) => !flutterAppsList.some((a) => a.path === p.path))
                        .map((p) => (
                          <option key={p.path} value={p.path}>
                            📁 {p.name} — {p.path}
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                {/* Subprojects dropdown if parent directory/monorepo has multiple Flutter apps */}
                {currentBbProject && currentBbProject.subprojects.length > 1 && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground block">
                      Flutter Subprojects in Monorepo
                    </label>
                    <select
                      value={selectedSubprojectPath}
                      onChange={(e) => handleSubprojectChange(e.target.value)}
                      className="w-full rounded border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {currentBbProject.subprojects.map((sub) => (
                        <option key={sub.path} value={sub.path}>
                          {sub.name} ({sub.path})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Project Status Banner */}
                <div className="rounded-lg bg-muted/50 p-2.5 text-xs">
                  {activeFlutterProject ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-emerald-500">
                        <span className="font-medium flex items-center gap-1.5">
                          <span>✓</span> Flutter Project: {activeFlutterProject.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {activeFlutterProject.launchConfigurations?.length || 0} launch configs • {activeFlutterProject.flavors.length} flavors
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground truncate">
                        {activeFlutterProject.path}
                      </div>
                    </div>
                  ) : pathInspectError ? (
                    <div className="text-rose-400 font-medium">
                      ⚠️ {pathInspectError}
                    </div>
                  ) : (
                    <div className="text-muted-foreground text-[11px]">
                      Choose a Flutter project folder using &quot;Choose Folder...&quot; or select from detected projects above.
                    </div>
                  )}
                </div>

                {/* Build Options: Launch Configuration, Target, Flavor, Mode */}
                <div className="border-t border-border pt-4 space-y-4">
                  {/* Launch Configuration from launch.json */}
                  {activeFlutterProject?.launchConfigurations && activeFlutterProject.launchConfigurations.length > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs font-semibold text-primary flex items-center gap-1.5">
                          <span>⚙️</span> Launch Configuration (.vscode/launch.json)
                        </label>
                        <span className="text-[10px] text-muted-foreground">
                          Synchronizes target, flavor & mode
                        </span>
                      </div>
                      <select
                        value={selectedLaunchConfig}
                        onChange={(e) => handleLaunchConfigChange(e.target.value)}
                        className="w-full rounded border border-primary/30 bg-background px-3 py-1.5 text-xs text-foreground font-medium focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="custom">Custom / Manual</option>
                        {activeFlutterProject.launchConfigurations.map((cfg) => {
                          const details = [
                            cfg.target || "main.dart",
                            cfg.flavor ? `flavor: ${cfg.flavor}` : null,
                            cfg.mode || "debug",
                          ]
                            .filter(Boolean)
                            .join(" • ");
                          return (
                            <option key={cfg.name} value={cfg.name}>
                              {cfg.name} ({details})
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Build Flavor
                      </label>
                      {activeFlutterProject && activeFlutterProject.flavors.length > 0 ? (
                        <select
                          value={selectedFlavor}
                          onChange={(e) => handleFlavorChange(e.target.value)}
                          className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value="">(None)</option>
                          {activeFlutterProject.flavors.map((fl) => (
                            <option key={fl} value={fl}>
                              {fl}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          className="h-8 text-xs"
                          value={selectedFlavor}
                          onChange={(e) => handleFlavorChange(e.target.value)}
                          placeholder="staging, dev, production"
                        />
                      )}
                    </div>

                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Target Entrypoint
                      </label>
                      {activeFlutterProject && activeFlutterProject.entrypoints.length > 0 ? (
                        <select
                          value={selectedTarget}
                          onChange={(e) => handleTargetChange(e.target.value)}
                          className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          {activeFlutterProject.entrypoints.map((ep) => (
                            <option key={ep} value={`lib/${ep}`}>
                              lib/{ep}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          className="h-8 text-xs font-mono"
                          value={selectedTarget}
                          onChange={(e) => handleTargetChange(e.target.value)}
                          placeholder="lib/main.dart"
                        />
                      )}
                    </div>

                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Build Mode
                      </label>
                      <div className="flex gap-1.5">
                        {(["debug", "profile", "release"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => handleModeChange(m)}
                            className={cn(
                              "flex-1 rounded border py-1.5 text-xs font-medium capitalize transition-colors",
                              selectedMode === m
                                ? "border-primary bg-primary/10 text-primary font-semibold"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Target Devices Selection */}
              <div className="rounded-xl border border-border bg-card p-4 md:p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                    <span>📱 Target Device</span>
                    <span className="rounded-full bg-muted px-2 py-0.2 text-xs text-muted-foreground">
                      {devices.length} available
                    </span>
                  </h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      fetchDevices();
                      fetchEmulators();
                    }}
                  >
                    ↺ Refresh Devices
                  </Button>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {devices.map((device) => {
                    const isSelected = selectedDeviceId === device.id;
                    return (
                      <div
                        key={device.id}
                        onClick={() => setSelectedDeviceId(device.id)}
                        className={cn(
                          "cursor-pointer rounded-lg border p-3 transition-all flex items-center justify-between",
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-border hover:border-border/80 hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-lg">
                            {device.targetPlatform.includes("ios")
                              ? "🍎"
                              : device.targetPlatform.includes("android")
                              ? "🤖"
                              : device.targetPlatform.includes("web")
                              ? "🌐"
                              : "💻"}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-foreground">
                              {device.name}
                            </div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {device.sdk || device.targetPlatform}
                              {device.emulator ? " • Simulator/Emulator" : " • Physical Device"}
                            </div>
                          </div>
                        </div>
                        {isSelected && (
                          <span className="size-2 rounded-full bg-primary shrink-0 ml-2" />
                        )}
                      </div>
                    );
                  })}
                </div>

                {devices.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                    No devices connected. Start an emulator below or connect a physical device.
                  </div>
                )}

                {/* Available Emulators to Launch */}
                {emulators.length > 0 && (
                  <div className="mt-5 border-t border-border pt-4">
                    <h3 className="text-xs font-semibold text-muted-foreground mb-2">
                      Available Emulators to Launch
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {emulators.map((emu) => (
                        <Button
                          key={emu.id}
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 text-xs"
                          onClick={() => handleLaunchEmulator(emu.id)}
                          disabled={actionPending}
                        >
                          <span>{emu.platform === "ios" ? "🍎" : "🤖"}</span>
                          <span>Launch {emu.name}</span>
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Bottom Launch Button */}
              <div className="flex justify-end gap-3 pt-2">
                {isRunning ? (
                  <Button
                    variant="destructive"
                    size="default"
                    className="gap-2"
                    onClick={handleStop}
                    disabled={actionPending}
                  >
                    Stop Application
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="default"
                    className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6"
                    onClick={handleStart}
                    disabled={actionPending || !effectiveProjectPath || !selectedDeviceId}
                  >
                    <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Launch Flutter App
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Widget Inspector (Embedded DevTools) */}
        {activeTab === "inspector" && (
          <div className="flex h-full w-full flex-col">
            {/* Inspector Helper Bar */}
            <div className="flex items-center justify-between border-b border-border bg-card px-4 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="font-medium text-foreground">Widget Inspector</span>
                <span className="hidden sm:inline">
                  Interactive widget tree & layout explorer from Dart DevTools
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={selectWidgetMode ? "secondary" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => handleToggleExtension("selectWidgetMode")}
                  disabled={!isRunning}
                >
                  {selectWidgetMode ? "✓ Selecting on Device" : "Select Widget on Device"}
                </Button>
                <Button
                  variant={debugPaint ? "secondary" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => handleToggleExtension("debugPaint")}
                  disabled={!isRunning}
                >
                  {debugPaint ? "✓ Debug Paint ON" : "Debug Paint"}
                </Button>
              </div>
            </div>

            {/* DevTools Frame or Empty State */}
            {sessionState?.inspectorUrl ? (
              <iframe
                src={sessionState.inspectorUrl}
                title="Flutter Widget Inspector"
                className="h-full w-full border-0 bg-background"
                allow="clipboard-read; clipboard-write"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                <div className="size-12 rounded-full bg-sky-500/10 text-sky-500 flex items-center justify-center text-xl mb-3">
                  🔍
                </div>
                <h3 className="text-sm font-semibold text-foreground">
                  Widget Inspector Not Connected
                </h3>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  Launch a Flutter build in Debug mode to inspect the widget tree, layout constraints, and properties live as you edit.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 text-xs"
                  onClick={() => setActiveTab("config")}
                >
                  Go to Run Config
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Debugger (Embedded DevTools) */}
        {activeTab === "debugger" && (
          <div className="flex h-full w-full flex-col">
            {/* Debugger Helper Bar */}
            <div className="flex items-center justify-between border-b border-border bg-card px-4 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="font-medium text-foreground">Flutter Debugger</span>
                {sessionState?.isPaused && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-semibold text-amber-400">
                    ⏸ Execution Paused at Breakpoint
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={handleTogglePause}
                  disabled={!isRunning}
                >
                  {sessionState?.isPaused ? "▶️ Resume" : "⏸ Pause"}
                </Button>
              </div>
            </div>

            {/* Debugger Frame or Empty State */}
            {sessionState?.debuggerUrl ? (
              <iframe
                src={sessionState.debuggerUrl}
                title="Flutter Debugger"
                className="h-full w-full border-0 bg-background"
                allow="clipboard-read; clipboard-write"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                <div className="size-12 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center text-xl mb-3">
                  🐛
                </div>
                <h3 className="text-sm font-semibold text-foreground">
                  Debugger Not Connected
                </h3>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  Launch a Flutter application to step through code, inspect call stacks, inspect variables, and toggle breakpoints.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 text-xs"
                  onClick={() => setActiveTab("config")}
                >
                  Go to Run Config
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Tab 4: Console Logs */}
        {activeTab === "logs" && (
          <div className="flex h-full w-full flex-col bg-slate-950 font-mono text-slate-200">
            {/* Log controls */}
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-3 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Filter logs..."
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                  className="h-6 w-44 rounded bg-slate-950 px-2 text-xs text-slate-200 border border-slate-800 focus:outline-none focus:border-slate-600"
                />
                <span className="text-[10px] text-slate-400">
                  {filteredLogs.length} lines
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutoScrollLogs(!autoScrollLogs)}
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border",
                    autoScrollLogs
                      ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                      : "border-slate-800 text-slate-400",
                  )}
                >
                  Auto-scroll {autoScrollLogs ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    rpc.call("clearLogs", null);
                    setLogs([]);
                  }}
                  className="text-[10px] text-slate-400 hover:text-slate-200"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Scrollable logs */}
            <div ref={logsContainerRef} className="flex-1 overflow-y-auto p-3 text-xs leading-relaxed">
              {filteredLogs.length === 0 ? (
                <div className="text-slate-500 italic">No logs recorded yet.</div>
              ) : (
                filteredLogs.map((entry) => (
                  <div
                    key={entry.id}
                    className={cn(
                      "py-0.5 whitespace-pre-wrap break-all",
                      entry.type === "stderr" && "text-rose-400",
                      entry.type === "system" && "text-sky-300 font-semibold",
                      entry.type === "progress" && "text-amber-300 italic",
                      entry.type === "stdout" && "text-slate-200",
                    )}
                  >
                    <span className="text-slate-600 mr-2 select-none text-[10px]">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    {entry.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FlutterSidebarAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const [sessionState, setSessionState] = useState<SessionState | null>(null);

  useEffect(() => {
    rpc.call("getStatus", null).then((state) => {
      setSessionState(state);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("bb-flutter:state", { detail: state }));
      }
    }).catch(() => {});
  }, [rpc]);

  useRealtime("flutter:state", (state: any) => {
    setSessionState(state);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bb-flutter:state", { detail: state }));
    }
  });

  if (!sessionState) return null;

  // When running or paused, persistent control icons are rendered in the sidebar row.
  // We suppress the accessory badge here so they do not collide.
  if (sessionState.status === "running" || sessionState.status === "paused") {
    return null;
  }

  if (sessionState.status === "building" || sessionState.status === "starting") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-sky-400" title="Building Flutter app">
        <span className="size-2 animate-spin rounded-full border border-sky-400 border-t-transparent" />
      </span>
    );
  }

  return null;
}

export function FlutterSidebarActions() {
  const rpc = useRpc<typeof rpcContract>();
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [pending, setPending] = useState(false);
  const [inspectMode, setInspectMode] = useState(false);

  useEffect(() => {
    rpc.call("getStatus", null).then(setSessionState).catch(() => {});
  }, [rpc]);

  useRealtime("flutter:state", (state: any) => {
    setSessionState(state);
  });

  const isRunning = sessionState?.status === "running" || sessionState?.status === "paused";
  const isPaused = sessionState?.isPaused || sessionState?.status === "paused";

  const handlePlayPause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending || !isRunning) return;
    setPending(true);
    try {
      if (isPaused) {
        const res = await rpc.call("resume", null);
        setSessionState(res);
      } else {
        const res = await rpc.call("pause", null);
        setSessionState(res);
      }
    } catch (err) {
      console.error("Flutter play/pause error:", err);
    } finally {
      setPending(false);
    }
  };

  const handleHotReload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending || !isRunning) return;
    setPending(true);
    try {
      await rpc.call("hotReload", null);
    } catch (err) {
      console.error("Flutter hot reload error:", err);
    } finally {
      setPending(false);
    }
  };

  const handleHotRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending || !isRunning) return;
    setPending(true);
    try {
      await rpc.call("hotRestart", null);
    } catch (err) {
      console.error("Flutter hot restart error:", err);
    } finally {
      setPending(false);
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending || !isRunning) return;
    setPending(true);
    try {
      const res = await rpc.call("stopSession", null);
      setSessionState(res);
    } catch (err) {
      console.error("Flutter stop error:", err);
    } finally {
      setPending(false);
    }
  };

  const handleInspect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending || !isRunning) return;
    setPending(true);
    try {
      const next = !inspectMode;
      await rpc.call("callServiceExtension", {
        name: "selectWidgetMode",
        value: next,
      });
      setInspectMode(next);
    } catch (err) {
      console.error("Flutter inspect error:", err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="flex items-center gap-0.5 bg-sidebar/95 pl-1 pr-0.5 rounded-l backdrop-blur-sm"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {/* 1. Play / Pause */}
      <button
        type="button"
        onClick={handlePlayPause}
        disabled={!isRunning || pending}
        title={isPaused ? "Resume execution (p)" : "Pause execution (p)"}
        className={cn(
          "size-5 flex items-center justify-center rounded transition-colors",
          isRunning
            ? isPaused
              ? "text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400"
              : "text-foreground hover:bg-muted hover:text-foreground"
            : "text-muted-foreground/30 pointer-events-none"
        )}
      >
        {isPaused ? (
          <svg className="size-3" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        ) : (
          <svg className="size-3" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        )}
      </button>

      {/* 2. Hot Reload */}
      <button
        type="button"
        onClick={handleHotReload}
        disabled={!isRunning || pending}
        title="Hot Reload (r)"
        className={cn(
          "size-5 flex items-center justify-center rounded transition-colors",
          isRunning
            ? "text-amber-500 hover:bg-amber-500/10 hover:text-amber-400"
            : "text-muted-foreground/30 pointer-events-none"
        )}
      >
        <svg className="size-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </button>

      {/* 3. Hot Restart */}
      <button
        type="button"
        onClick={handleHotRestart}
        disabled={!isRunning || pending}
        title="Hot Restart (Shift+R)"
        className={cn(
          "size-5 flex items-center justify-center rounded transition-colors",
          isRunning
            ? "text-sky-500 hover:bg-sky-500/10 hover:text-sky-400"
            : "text-muted-foreground/30 pointer-events-none"
        )}
      >
        <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>

      {/* 4. Stop */}
      <button
        type="button"
        onClick={handleStop}
        disabled={!isRunning || pending}
        title="Stop Application"
        className={cn(
          "size-5 flex items-center justify-center rounded transition-colors",
          isRunning
            ? "text-rose-500 hover:bg-rose-500/10 hover:text-rose-400"
            : "text-muted-foreground/30 pointer-events-none"
        )}
      >
        <svg className="size-3" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>

      {/* 5. Inspect */}
      <button
        type="button"
        onClick={handleInspect}
        disabled={!isRunning || pending}
        title="Inspect Widget Tree (Select Mode)"
        className={cn(
          "size-5 flex items-center justify-center rounded transition-colors",
          isRunning
            ? inspectMode
              ? "bg-sky-500/20 text-sky-400"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
            : "text-muted-foreground/30 pointer-events-none"
        )}
      >
        <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-actions",
    mount: mountFlutterSidebarActions,
  });

  app.slots.navPanel({
    id: "flutter",
    title: "Flutter",
    icon: "Zap",
    path: "flutter",
    component: FlutterPanel,
    experimental_sidebarAccessory: FlutterSidebarAccessory,
  });
});
