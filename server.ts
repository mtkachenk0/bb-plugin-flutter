import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { DevToolsManager } from "./lib/devtools-manager";
import {
  detectProjects,
  ensureDeviceReady,
  findFlutterSubprojects,
  getBbProjects,
  inferFlavorForTarget,
  inferTargetForFlavor,
  inspectProject,
  launchEmulator,
  listDevices,
  listEmulators,
  pickDirectoryDialog,
  resolveUserPath,
} from "./lib/flutter-cli";
import { FlutterSession } from "./lib/flutter-session";
import type { FlutterDevice, FlutterProject, SessionConfig, SessionState } from "./lib/types";
import { z } from "zod";

// Schemas for RPC and validation
export const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetPlatform: z.string(),
  emulator: z.boolean(),
  isSupported: z.boolean(),
  sdk: z.string().optional(),
});

export const emulatorSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  platform: z.string(),
});

export const launchConfigSchema = z.object({
  name: z.string(),
  target: z.string().optional(),
  flavor: z.string().optional(),
  mode: z.enum(["debug", "profile", "release"]).optional(),
  args: z.array(z.string()).optional(),
});

export const projectSchema = z.object({
  name: z.string(),
  path: z.string(),
  entrypoints: z.array(z.string()),
  flavors: z.array(z.string()),
  launchConfigurations: z.array(launchConfigSchema).optional(),
});

export const bbProjectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  isFlutter: z.boolean(),
  flutterProject: projectSchema.nullable(),
  subprojects: z.array(projectSchema),
});

export const sessionConfigSchema = z.object({
  projectPath: z.string().min(1),
  deviceId: z.string().min(1),
  target: z.string().nullable().optional(),
  flavor: z.string().nullable().optional(),
  mode: z.enum(["debug", "profile", "release"]),
  additionalArgs: z.array(z.string()).nullable().optional(),
});

export const sessionStatusSchema = z.enum([
  "idle",
  "starting",
  "building",
  "running",
  "paused",
  "stopped",
  "error",
]);

export const sessionStateSchema = z.object({
  status: sessionStatusSchema,
  config: sessionConfigSchema.nullable(),
  isPaused: z.boolean(),
  progressMessage: z.string().nullable(),
  appId: z.string().nullable(),
  wsUri: z.string().nullable(),
  devtoolsUrl: z.string().nullable(),
  inspectorUrl: z.string().nullable(),
  debuggerUrl: z.string().nullable(),
  activeDevice: deviceSchema.nullable(),
  pid: z.number().nullable(),
  startedAt: z.number().nullable(),
  error: z.string().nullable(),
});

export const logEntrySchema = z.object({
  id: z.number(),
  timestamp: z.number(),
  type: z.enum(["stdout", "stderr", "system", "progress"]),
  message: z.string(),
});

export const rpcContract = defineRpcContract({
  getStatus: {
    input: z.null(),
    output: sessionStateSchema,
  },
  listDevices: {
    input: z.null(),
    output: z.object({ devices: z.array(deviceSchema) }),
  },
  listEmulators: {
    input: z.null(),
    output: z.object({ emulators: z.array(emulatorSchema) }),
  },
  launchEmulator: {
    input: z.object({ emulatorId: z.string().min(1) }),
    output: z.object({ message: z.string() }),
  },
  detectProjects: {
    input: z.object({ searchDirs: z.array(z.string()).optional() }).optional(),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  getBbProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(bbProjectInfoSchema),
      error: z.string().nullable(),
    }),
  },
  pickDirectory: {
    input: z.object({ initialPath: z.string().nullable().optional() }).optional().nullable(),
    output: z.object({
      path: z.string().nullable(),
      canceled: z.boolean(),
    }),
  },
  inspectPath: {
    input: z.object({ path: z.string() }),
    output: z.object({
      isFlutter: z.boolean(),
      project: projectSchema.nullable(),
      subprojects: z.array(projectSchema).optional(),
      error: z.string().nullable(),
    }),
  },
  startSession: {
    input: sessionConfigSchema,
    output: sessionStateSchema,
  },
  stopSession: {
    input: z.null(),
    output: sessionStateSchema,
  },
  hotReload: {
    input: z.null(),
    output: z.object({ success: z.boolean(), message: z.string() }),
  },
  hotRestart: {
    input: z.null(),
    output: z.object({ success: z.boolean(), message: z.string() }),
  },
  pause: {
    input: z.null(),
    output: sessionStateSchema,
  },
  resume: {
    input: z.null(),
    output: sessionStateSchema,
  },
  callServiceExtension: {
    input: z.object({
      name: z.enum([
        "selectWidgetMode",
        "debugPaint",
        "performanceOverlay",
        "slowAnimations",
      ]),
      value: z.boolean().optional(),
    }),
    output: z.object({ name: z.string(), value: z.boolean() }),
  },
  getLogs: {
    input: z
      .object({
        sinceId: z.number().optional(),
        limit: z.number().optional(),
      })
      .optional(),
    output: z.object({ logs: z.array(logEntrySchema) }),
  },
  clearLogs: {
    input: z.null(),
    output: z.object({ cleared: z.boolean() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("Flutter plugin loading");
  const settings = bb.settings.define({
    flutterBinaryPath: {
      type: "string",
      label: "Flutter binary path",
      description: "Path to flutter executable (default: flutter)",
      default: "flutter",
    },
    devtoolsPort: {
      type: "string",
      label: "DevTools port",
      description: "Preferred port for DevTools server (default: 9100, 0 for auto)",
      default: "9100",
    },
    defaultProjectPath: {
      type: "string",
      label: "Default Flutter project path",
      description: "Path to default Flutter project to inspect and run",
      default: "",
    },
  });
  const config = await settings.get();
  let flutterBin = config.flutterBinaryPath || "flutter";
  let devtoolsPort = parseInt(config.devtoolsPort, 10) || 9100;
  settings.onChange((next) => {
    flutterBin = next.flutterBinaryPath || "flutter";
    devtoolsPort = parseInt(next.devtoolsPort, 10) || 9100;
  });

  const devtoolsManager = new DevToolsManager();

  const session = new FlutterSession(
    (state) => {
      bb.realtime.publish("flutter:state", state);
    },
    (logs) => {
      bb.realtime.publish("flutter:log", logs);
    },
  );

  async function handleStartSession(sessionConfig: SessionConfig): Promise<SessionState> {
    if (sessionConfig.target === null) sessionConfig.target = undefined;
    if (sessionConfig.flavor === null) sessionConfig.flavor = undefined;
    if (sessionConfig.additionalArgs === null) sessionConfig.additionalArgs = undefined;
    await ensureDeviceReady(sessionConfig.deviceId, flutterBin);

    // If target directory is monorepo root, auto-select subproject
    let proj = inspectProject(sessionConfig.projectPath);
    if (!proj) {
      const subs = findFlutterSubprojects(sessionConfig.projectPath);
      if (subs.length > 0) {
        sessionConfig.projectPath = subs[0]!.path;
        proj = subs[0]!;
        bb.log.info(
          `Resolved monorepo root to Flutter subproject "${proj.name}" at "${proj.path}"`
        );
      }
    }

    try {
      if (proj) {
        // Respect launch.json configurations if available
        if (proj.launchConfigurations && proj.launchConfigurations.length > 0) {
          if (sessionConfig.flavor) {
            const match = proj.launchConfigurations.find(
              (c) =>
                c.flavor?.toLowerCase() === sessionConfig.flavor?.toLowerCase() ||
                c.name.toLowerCase() === sessionConfig.flavor?.toLowerCase()
            );
            if (match) {
              if (!sessionConfig.target || sessionConfig.target === "lib/main.dart") {
                if (match.target) {
                  sessionConfig.target = match.target.startsWith("lib/")
                    ? match.target
                    : `lib/${match.target}`;
                }
              }
              if (match.mode && (!sessionConfig.mode || sessionConfig.mode === "debug")) {
                sessionConfig.mode = match.mode;
              }
              if (match.args) {
                const extra = match.args.filter((a, i, arr) => {
                  if (a === "--flavor" || arr[i - 1] === "--flavor" || a.startsWith("--flavor=")) return false;
                  return true;
                });
                if (extra.length > 0) {
                  sessionConfig.additionalArgs = [...(sessionConfig.additionalArgs || []), ...extra];
                }
              }
            }
          } else if (sessionConfig.target) {
            const normTarget = sessionConfig.target.replace(/^[./]+/, "").replace(/^lib\//, "");
            const match = proj.launchConfigurations.find((c) => {
              if (!c.target) return false;
              const normC = c.target.replace(/^[./]+/, "").replace(/^lib\//, "");
              return normC === normTarget;
            });
            if (match?.flavor) {
              sessionConfig.flavor = match.flavor;
            }
          }
        }

        // Fallback inferences
        if (!sessionConfig.flavor && sessionConfig.target) {
          const inferred = inferFlavorForTarget(sessionConfig.target, proj);
          if (inferred) {
            sessionConfig.flavor = inferred;
            bb.log.info(`Auto-inferred flavor "${inferred}" for target "${sessionConfig.target}"`);
          }
        } else if (!sessionConfig.target && sessionConfig.flavor) {
          const inferred = inferTargetForFlavor(sessionConfig.flavor, proj);
          if (inferred) {
            sessionConfig.target = inferred;
            bb.log.info(`Auto-inferred target "${inferred}" for flavor "${sessionConfig.flavor}"`);
          }
        } else if (
          sessionConfig.target === "lib/main.dart" &&
          sessionConfig.flavor &&
          sessionConfig.flavor !== "dev" &&
          sessionConfig.flavor !== "development"
        ) {
          const specificEp = `lib/main_${sessionConfig.flavor}.dart`;
          const baseEp = `main_${sessionConfig.flavor}.dart`;
          if (proj.entrypoints.includes(baseEp)) {
            bb.log.warn(
              `Target "${sessionConfig.target}" was paired with flavor "${sessionConfig.flavor}". Using "${specificEp}" instead to avoid FileNotFoundError.`
            );
            sessionConfig.target = specificEp;
          }
        }
      }
    } catch {
      // ignore inference error
    }

    let devtoolsUrl = "";
    try {
      devtoolsUrl = await devtoolsManager.ensureDevTools("dart", devtoolsPort);
    } catch (cause) {
      bb.log.warn(`DevTools start warning: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    let targetDevice: FlutterDevice | undefined;
    try {
      const devices = await listDevices(flutterBin);
      targetDevice = devices.find((d) => d.id === sessionConfig.deviceId || d.name === sessionConfig.deviceId);
    } catch {
      // ignore
    }

    return session.start(sessionConfig, {
      flutterBin,
      devtoolsUrl,
      device: targetDevice,
    });
  }

  // Register RPC Handlers
  bb.rpc.register(rpcContract, {
    getStatus: () => session.getState(),
    listDevices: async () => ({ devices: await listDevices(flutterBin) }),
    listEmulators: async () => ({ emulators: await listEmulators(flutterBin) }),
    launchEmulator: async ({ emulatorId }) => ({
      message: await launchEmulator(emulatorId, flutterBin),
    }),
    detectProjects: async (input) => {
      const userDirs = input?.searchDirs || [];
      const searchPaths = [
        ...userDirs,
        process.cwd(),
        "/Users/maximtkachenko/work/parknet/parkane_app",
      ];
      return { projects: await detectProjects(searchPaths) };
    },
    getBbProjects: async () => await getBbProjects(bb),
    pickDirectory: async (input) => {
      return await pickDirectoryDialog(input?.initialPath);
    },
    inspectPath: async ({ path: rawPath }) => {
      const resolved = resolveUserPath(rawPath);
      let project = inspectProject(resolved);
      let subprojects: FlutterProject[] = [];

      if (!project) {
        subprojects = findFlutterSubprojects(resolved);
        if (subprojects.length > 0) {
          project = subprojects[0]!;
        }
      } else {
        subprojects = findFlutterSubprojects(resolved);
      }

      return {
        isFlutter: !!project,
        project: project || null,
        subprojects,
        error: project ? null : "Not a valid Flutter project directory (no pubspec.yaml found)",
      };
    },
    startSession: async (cfg) => handleStartSession(cfg),
    stopSession: async () => {
      await session.stop();
      return session.getState();
    },
    hotReload: async () => {
      const res = await session.hotReload();
      return { success: true, message: res.message };
    },
    hotRestart: async () => {
      const res = await session.hotRestart();
      return { success: true, message: res.message };
    },
    pause: async () => {
      await session.pause();
      return session.getState();
    },
    resume: async () => {
      await session.resume();
      return session.getState();
    },
    callServiceExtension: async ({ name, value }) => {
      const nextVal = await session.toggleExtension(name, value);
      return { name, value: nextVal };
    },
    getLogs: (input) => ({
      logs: session.getLogs(input?.sinceId, input?.limit),
    }),
    clearLogs: () => {
      session.clearLogs();
      return { cleared: true };
    },
  });

  // Agent Tools
  bb.agents.registerTool({
    name: "flutter_list_devices",
    description: "List attached Flutter devices and available emulators/simulators.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Listing Flutter devices",
        completed: "Listed Flutter devices",
      },
    },
    async execute() {
      const [devices, emulators] = await Promise.all([
listDevices(flutterBin).catch(() => []),
listEmulators(flutterBin).catch(() => []),
]);
      return JSON.stringify({ devices, emulators }, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "flutter_launch_emulator",
    description: "Launch a simulator or emulator by ID.",
    parameters: z.object({
      emulatorId: z.string().describe("ID of emulator from flutter_list_devices, e.g. apple_ios_simulator"),
    }),
    presentation: {
      label: {
        pending: "Launching emulator",
        completed: "Launched emulator",
      },
    },
    async execute({ emulatorId }) {
      const res = await launchEmulator(emulatorId, flutterBin);
      return res;
    },
  });

  bb.agents.registerTool({
    name: "flutter_run",
    description: "Launch flutter build and run for a specified device from a specified Flutter project with hot reload/restart and debugger support.",
    parameters: z.object({
      projectPath: z.string().describe("Absolute path to Flutter project (directory with pubspec.yaml)"),
      deviceId: z.string().describe("Target device ID or name (from flutter_list_devices)"),
      target: z.string().optional().describe("Entrypoint file relative to project root (e.g. lib/main.dart or lib/main_staging.dart)"),
      flavor: z.string().optional().describe("Build flavor (e.g. staging, dev, production)"),
      mode: z.enum(["debug", "profile", "release"]).default("debug").describe("Build mode"),
    }),
    presentation: {
      label: {
        pending: "Starting Flutter run",
        completed: "Started Flutter run",
      },
    },
    async execute({ projectPath, deviceId, target, flavor, mode }) {
      const state = await handleStartSession({
        projectPath,
        deviceId,
        target,
        flavor,
        mode,
      });
      return JSON.stringify(state, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "flutter_hot_reload",
    description: "Trigger a Hot Reload on the currently running Flutter application.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Hot reloading Flutter app",
        completed: "Hot reloaded Flutter app",
      },
    },
    async execute() {
      const res = await session.hotReload();
      return JSON.stringify(res);
    },
  });

  bb.agents.registerTool({
    name: "flutter_hot_restart",
    description: "Trigger a Hot Restart on the currently running Flutter application.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Hot restarting Flutter app",
        completed: "Hot restarted Flutter app",
      },
    },
    async execute() {
      const res = await session.hotRestart();
      return JSON.stringify(res);
    },
  });

  bb.agents.registerTool({
    name: "flutter_pause",
    description: "Pause the running Flutter application.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Pausing Flutter app",
        completed: "Paused Flutter app",
      },
    },
    async execute() {
      await session.pause();
      return JSON.stringify(session.getState());
    },
  });

  bb.agents.registerTool({
    name: "flutter_resume",
    description: "Resume the paused Flutter application.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Resuming Flutter app",
        completed: "Resumed Flutter app",
      },
    },
    async execute() {
      await session.resume();
      return JSON.stringify(session.getState());
    },
  });

  bb.agents.registerTool({
    name: "flutter_stop",
    description: "Stop the currently running Flutter session.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Stopping Flutter app",
        completed: "Stopped Flutter app",
      },
    },
    async execute() {
      await session.stop();
      return JSON.stringify(session.getState());
    },
  });

  bb.agents.registerTool({
    name: "flutter_get_status",
    description: "Get the current Flutter session status, DevTools URLs, and attached device.",
    parameters: z.object({}),
    presentation: {
      label: {
        pending: "Fetching Flutter session status",
        completed: "Fetched Flutter session status",
      },
    },
    async execute() {
      return JSON.stringify(session.getState(), null, 2);
    },
  });

  bb.agents.registerTool({
    name: "flutter_service_extension",
    description: "Toggle or set a Flutter DevTools/VM service extension (e.g. selectWidgetMode, debugPaint, performanceOverlay, slowAnimations).",
    parameters: z.object({
      name: z.enum(["selectWidgetMode", "debugPaint", "performanceOverlay", "slowAnimations"]),
      value: z.boolean().optional().describe("Value to set (if omitted, toggles current value)"),
    }),
    presentation: {
      label: {
        pending: "Setting Flutter service extension",
        completed: "Set Flutter service extension",
      },
    },
    async execute({ name, value }) {
      const nextVal = await session.toggleExtension(name, value);
      return JSON.stringify({ name, value: nextVal });
    },
  });

  // CLI Subcommands
  const runCli = async (args: string[]) => {
      const sub = args[0] || "status";
      if (sub === "devices") {
        const [devices, emus] = await Promise.all([
listDevices(flutterBin).catch(() => []),
listEmulators(flutterBin).catch(() => []),
]);
        let out = "Connected Devices:\n";
        for (const d of devices) {
          out += `  • ${d.name} (${d.id}) [${d.targetPlatform}] ${d.emulator ? "(emulator)" : ""}\n`;
        }
        if (emus.length > 0) {
          out += "\nAvailable Emulators:\n";
          for (const e of emus) {
            out += `  • ${e.name} (${e.id}) [${e.platform}]\n`;
          }
        }
        return out;
      }
      if (sub === "run") {
        const devIdx = args.indexOf("--device");
        const projIdx = args.indexOf("--project");
        const targetIdx = args.indexOf("--target");
        const flavorIdx = args.indexOf("--flavor");
        const modeIdx = args.indexOf("--mode");
        const deviceId = devIdx !== -1 ? args[devIdx + 1] : "";
        const projectPath = projIdx !== -1 ? args[projIdx + 1] : process.cwd();
        const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined;
        const flavor = flavorIdx !== -1 ? args[flavorIdx + 1] : undefined;
        const modeRaw = modeIdx !== -1 ? args[modeIdx + 1] : "debug";
        const mode = (modeRaw === "profile" || modeRaw === "release") ? modeRaw : "debug";

        if (!deviceId) {
          return "Error: --device <id> is required for bb flutter run. Run 'bb flutter devices' to see available devices.";
        }

        const state = await handleStartSession({
          projectPath,
          deviceId,
          target,
          flavor,
          mode,
        });
        return `Started Flutter session (PID: ${state.pid}, status: ${state.status})`;
      }
      if (sub === "reload") {
        const res = await session.hotReload();
        return res.message;
      }
      if (sub === "restart") {
        const res = await session.hotRestart();
        return res.message;
      }
      if (sub === "pause") {
        await session.pause();
        return "Flutter app paused";
      }
      if (sub === "resume") {
        await session.resume();
        return "Flutter app resumed";
      }
      if (sub === "stop") {
        await session.stop();
        return "Flutter session stopped";
      }
      if (sub === "status") {
        const state = session.getState();
        let out = `Status: ${state.status}\n`;
        if (state.activeDevice) out += `Device: ${state.activeDevice.name} (${state.activeDevice.id})\n`;
        if (state.config) {
          out += `Project: ${state.config.projectPath}\n`;
          if (state.config.target) out += `Target: ${state.config.target}\n`;
          if (state.config.flavor) out += `Flavor: ${state.config.flavor}\n`;
          out += `Mode: ${state.config.mode}\n`;
        }
        if (state.devtoolsUrl) out += `DevTools: ${state.devtoolsUrl}\n`;
        if (state.inspectorUrl) out += `Widget Inspector: ${state.inspectorUrl}\n`;
        if (state.debuggerUrl) out += `Debugger: ${state.debuggerUrl}\n`;
        if (state.error) out += `Error: ${state.error}\n`;
        return out;
      }
      if (sub === "logs") {
        const limIdx = args.indexOf("--limit");
        const limit = limIdx !== -1 ? parseInt(args[limIdx + 1] || "50", 10) : 50;
        const entries = session.getLogs(undefined, limit);
        return entries.map((e) => `[${new Date(e.timestamp).toISOString()}] [${e.type}] ${e.message}`).join("\n");
      }
      if (sub === "inspector") {
        const state = session.getState();
        if (!state.inspectorUrl) return "Widget Inspector is not available yet. Start a session first.";
        return `Widget Inspector URL: ${state.inspectorUrl}`;
      }
      if (sub === "debugger") {
        const state = session.getState();
        if (!state.debuggerUrl) return "Debugger is not available yet. Start a session first.";
        return `Debugger URL: ${state.debuggerUrl}`;
      }
      return `Usage:
  bb flutter devices                     List connected devices and emulators
  bb flutter run [options]               Launch Flutter run
    --device <id>                        Device ID or name
    --project <path>                     Path to Flutter project
    --target <file>                      Entrypoint (lib/main.dart)
    --flavor <flavor>                    App flavor
    --mode <debug|profile|release>       Build mode (default: debug)
  bb flutter reload                      Trigger Hot Reload
  bb flutter restart                     Trigger Hot Restart
  bb flutter pause                       Pause execution
  bb flutter resume                      Resume execution
  bb flutter stop                        Stop running session
  bb flutter status                      Print session status and DevTools URLs
  bb flutter logs [--limit <n>]          Print session logs
  bb flutter inspector                   Print or open DevTools Widget Inspector
  bb flutter debugger                    Print or open DevTools Debugger
`;
  };

  bb.cli.register({
    name: "flutter",
    summary: "Manage Flutter builds, devices, hot reload, restart, pause, debugger, and widget inspector",
    description: "Manage Flutter builds, devices, hot reload, restart, pause, debugger, and widget inspector",
    run: async (argv: string[]) => {
      try {
        const text = await runCli(argv);
        return { exitCode: 0, stdout: text };
      } catch (err: any) {
        return { exitCode: 1, stderr: err?.message || String(err) };
      }
    },
    execute: (argv: string[]) => runCli(argv),
  } as any);

  return {
    async dispose() {
      bb.log.info("Flutter plugin disposing");
      await session.stop().catch(() => {});
      devtoolsManager.dispose();
    },
  };
}
