import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  BbProjectInfo,
  FlutterDevice,
  FlutterEmulator,
  FlutterProject,
  LaunchConfiguration,
} from "./types";

const execFileAsync = promisify(execFile);

export function resolveUserPath(p: string): string {
  if (!p) return "";
  const trimmed = p.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function findFlutterBin(configuredPath?: string): string {
  if (configuredPath && configuredPath !== "flutter") {
    const resolved = resolveUserPath(configuredPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  const candidates = [
    "/opt/flutter/bin/flutter",
    path.join(os.homedir(), "development/flutter/bin/flutter"),
    path.join(os.homedir(), "flutter/bin/flutter"),
    "/opt/homebrew/bin/flutter",
    "/usr/local/bin/flutter",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "flutter";
}

export function findDartBin(flutterBinPath: string): string {
  if (flutterBinPath && flutterBinPath !== "flutter") {
    const dir = path.dirname(flutterBinPath);
    const candidate = path.join(dir, "dart");
    if (fs.existsSync(candidate)) return candidate;
  }
  const candidates = [
    "/opt/flutter/bin/dart",
    path.join(os.homedir(), "development/flutter/bin/dart"),
    path.join(os.homedir(), "flutter/bin/dart"),
    "/opt/homebrew/bin/dart",
    "/usr/local/bin/dart",
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "dart";
}

export function getEnhancedEnv(flutterBinPath: string): NodeJS.ProcessEnv {
  const flutterDir = path.dirname(flutterBinPath);
  const currentPath = process.env.PATH || "";
  const extraPaths = [
    flutterDir,
    "/opt/flutter/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(os.homedir(), "Library/Android/sdk/platform-tools"),
    path.join(os.homedir(), "Library/Android/sdk/emulator"),
  ];
  const newPath = [...extraPaths, currentPath].filter(Boolean).join(":");
  return {
    ...process.env,
    PATH: newPath,
    CI: "true",
  };
}

export async function listDevices(flutterBin = "flutter"): Promise<FlutterDevice[]> {
  const resolvedBin = findFlutterBin(flutterBin);
  try {
    const { stdout } = await execFileAsync(resolvedBin, ["devices", "--machine"], {
      timeout: 15_000,
      env: getEnhancedEnv(resolvedBin),
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((d: any) => ({
      id: String(d.id || ""),
      name: String(d.name || d.id || "Unknown Device"),
      targetPlatform: String(d.targetPlatform || ""),
      emulator: Boolean(d.emulator),
      isSupported: Boolean(d.isSupported),
      sdk: d.sdk ? String(d.sdk) : undefined,
      capabilities: d.capabilities,
    }));
  } catch (cause) {
    throw new Error(`Failed to list Flutter devices: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function listEmulators(flutterBin = "flutter"): Promise<FlutterEmulator[]> {
  const resolvedBin = findFlutterBin(flutterBin);
  try {
    const { stdout } = await execFileAsync(resolvedBin, ["emulators"], {
      timeout: 15_000,
      env: getEnhancedEnv(resolvedBin),
    });
    const lines = stdout.split("\n");
    const emulators: FlutterEmulator[] = [];
    let parsing = false;
    for (const line of lines) {
      if (line.includes("•")) {
        const parts = line.split("•").map((p) => p.trim());
        if (parts[0] === "Id") {
          parsing = true;
          continue;
        }
        if (parsing && parts.length >= 4) {
          emulators.push({
            id: parts[0]!,
            name: parts[1]!,
            manufacturer: parts[2]!,
            platform: parts[3]!,
          });
        }
      }
    }
    return emulators;
  } catch (cause) {
    throw new Error(`Failed to list Flutter emulators: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function launchEmulator(
  emulatorId: string,
  flutterBin = "flutter",
): Promise<string> {
  const resolvedBin = findFlutterBin(flutterBin);

  // If on macOS and emulatorId looks like an iOS Simulator UDID, boot via simctl
  if (process.platform === "darwin" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(emulatorId)) {
    try {
      await execFileAsync("xcrun", ["simctl", "boot", emulatorId], { timeout: 15_000 });
      await execFileAsync("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", emulatorId], { timeout: 5000 });
      return `Booted iOS Simulator ${emulatorId}`;
    } catch {
      // Fall through to flutter emulators --launch
    }
  }

  try {
    const { stdout } = await execFileAsync(
      resolvedBin,
      ["emulators", "--launch", emulatorId],
      { timeout: 30_000, env: getEnhancedEnv(resolvedBin) },
    );
    return stdout.trim() || `Launched emulator ${emulatorId}`;
  } catch (cause) {
    throw new Error(`Failed to launch emulator "${emulatorId}": ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function ensureDeviceReady(deviceId: string, flutterBin = "flutter"): Promise<void> {
  if (!deviceId) return;
  if (process.platform === "darwin") {
    const isUdid = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(deviceId);
    if (isUdid) {
      try {
        const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], { timeout: 10_000 });
        const parsed = JSON.parse(stdout);
        for (const runtime of Object.values(parsed.devices || {})) {
          if (Array.isArray(runtime)) {
            for (const dev of runtime) {
              if (dev.udid === deviceId && dev.state !== "Booted") {
                await execFileAsync("xcrun", ["simctl", "boot", deviceId], { timeout: 15_000 });
                try {
                  await execFileAsync("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", deviceId], { timeout: 5000 });
                } catch {
                  // ignore open failure
                }
                await new Promise((r) => setTimeout(r, 2000));
                return;
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }
}

export function parseGradleFlavors(content: string): Set<string> {
  const flavors = new Set<string>();
  const pfIdx = content.indexOf("productFlavors");
  if (pfIdx === -1) return flavors;

  const braceStart = content.indexOf("{", pfIdx);
  if (braceStart === -1) return flavors;

  let depth = 1;
  let i = braceStart + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }
  const block = content.slice(braceStart + 1, i - 1);
  const matches = block.matchAll(/([a-zA-Z0-9_-]+)\s*\{/g);
  for (const m of matches) {
    const name = m[1];
    if (name && name !== "create" && name !== "getByName") flavors.add(name);
  }
  const ktsMatches = block.matchAll(/create\s*\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of ktsMatches) {
    if (m[1]) flavors.add(m[1]);
  }
  return flavors;
}

export function parseIosSchemes(projectPath: string): Set<string> {
  const flavors = new Set<string>();
  const schemesDir = path.join(projectPath, "ios", "Runner.xcodeproj", "xcshareddata", "xcschemes");
  if (fs.existsSync(schemesDir)) {
    try {
      const files = fs.readdirSync(schemesDir);
      for (const f of files) {
        if (f.endsWith(".xcscheme") && f !== "Runner.xcscheme") {
          flavors.add(f.replace(/\.xcscheme$/, ""));
        }
      }
    } catch {
      // ignore
    }
  }
  return flavors;
}

export function parsePubspecFlavors(content: string): Set<string> {
  const flavors = new Set<string>();
  try {
    const matches = content.matchAll(/flavors:\s*\[([^\]]+)\]/g);
    for (const m of matches) {
      if (m[1]) {
        m[1].split(",").forEach((f) => {
          const clean = f.trim();
          if (clean) flavors.add(clean);
        });
      }
    }
  } catch {
    // ignore
  }
  return flavors;
}

export function parseLaunchConfigs(projectPathOrJson: string): {
  configs: LaunchConfiguration[];
  flavors: Set<string>;
} {
  const configs: LaunchConfiguration[] = [];
  const flavors = new Set<string>();
  let raw: string | null = null;
  if (projectPathOrJson.trim().startsWith("{")) {
    raw = projectPathOrJson;
  } else {
    const launchPath = path.join(projectPathOrJson, ".vscode", "launch.json");
    if (fs.existsSync(launchPath)) {
      try {
        raw = fs.readFileSync(launchPath, "utf8");
      } catch {
        raw = null;
      }
    }
  }
  if (raw) {
    try {
      // Strip line comments, block comments, and trailing commas for robust JSON parsing
      const stripped = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,\s*([\]}])/g, "$1");
      const parsed = JSON.parse(stripped);
      if (Array.isArray(parsed?.configurations)) {
        for (const c of parsed.configurations) {
          if (c.type === "dart" || !c.type) {
            let flavor: string | undefined;
            const args: string[] = [...(c.toolArgs || []), ...(c.args || [])];
            for (let i = 0; i < args.length; i++) {
              if (args[i] === "--flavor" && args[i + 1]) {
                flavor = args[i + 1];
                break;
              }
              if (typeof args[i] === "string" && args[i]!.startsWith("--flavor=")) {
                flavor = args[i]!.slice("--flavor=".length);
                break;
              }
            }
            if (!flavor && c.name) {
              const lower = c.name.toLowerCase();
              if (["dev", "staging", "production", "development", "prod", "uat"].includes(lower)) {
                flavor = lower === "development" ? "dev" : lower === "prod" ? "production" : lower;
              }
            }
            if (flavor) {
              flavors.add(flavor);
            }
            configs.push({
              name: c.name,
              target: c.program,
              flavor,
              mode: c.flutterMode,
              args: args.length > 0 ? args : undefined,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return { configs, flavors };
}

export function inferFlavorForTarget(target: string, project: FlutterProject): string | undefined {
  if (!target) return undefined;
  const normalized = target.replace(/^[./]+/, "").replace(/^lib\//, "");

  if (project.launchConfigurations) {
    const cfg = project.launchConfigurations.find((c) => {
      if (!c.target) return false;
      const cNorm = c.target.replace(/^[./]+/, "").replace(/^lib\//, "");
      return cNorm === normalized;
    });
    if (cfg?.flavor) return cfg.flavor;
  }

  const match = normalized.match(/^main_([a-zA-Z0-9_-]+)\.dart$/);
  if (match && match[1]) return match[1];

  if (normalized === "main.dart") {
    if (project.flavors.includes("dev")) return "dev";
    if (project.flavors.includes("development")) return "development";
    return undefined;
  }

  return undefined;
}

export function inferTargetForFlavor(flavor: string, project: FlutterProject): string | undefined {
  if (project.launchConfigurations) {
    const cfg = project.launchConfigurations.find(
      (c) =>
        c.flavor?.toLowerCase() === flavor.toLowerCase() ||
        c.name.toLowerCase() === flavor.toLowerCase()
    );
    if (cfg?.target) {
      return cfg.target.startsWith("lib/") ? cfg.target : `lib/${cfg.target}`;
    }
  }

  if (!flavor) {
    if (project.entrypoints.includes("main.dart")) return "lib/main.dart";
    return project.entrypoints[0] ? `lib/${project.entrypoints[0]}` : "lib/main.dart";
  }

  const specific = `main_${flavor}.dart`;
  if (project.entrypoints.includes(specific)) {
    return `lib/${specific}`;
  }

  if ((flavor === "dev" || flavor === "development") && project.entrypoints.includes("main.dart")) {
    return "lib/main.dart";
  }

  return project.entrypoints[0] ? `lib/${project.entrypoints[0]}` : "lib/main.dart";
}

export async function pickDirectoryDialog(
  initialPath?: string,
): Promise<{ path: string | null; canceled: boolean }> {
  if (process.platform === "darwin") {
    try {
      const resolved = initialPath ? resolveUserPath(initialPath) : "";
      const defaultLoc =
        resolved && fs.existsSync(resolved)
          ? ` default location POSIX file "${resolved.replace(/"/g, '\\"')}"`
          : "";
      const script = `POSIX path of (choose folder with prompt "Select Flutter Project Directory:"${defaultLoc})`;
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        timeout: 120_000,
      });
      const picked = stdout.trim().replace(/\/$/, "");
      return { path: picked || null, canceled: false };
    } catch (err: any) {
      if (
        err?.message?.includes("User canceled") ||
        err?.stderr?.includes("User canceled") ||
        err?.code === 1
      ) {
        return { path: null, canceled: true };
      }
      return { path: null, canceled: false };
    }
  }
  return { path: null, canceled: false };
}

export function inspectProject(rawPath: string): FlutterProject | null {
  try {
    const projectPath = resolveUserPath(rawPath);
    if (!projectPath || !fs.existsSync(projectPath)) return null;

    const pubspecPath = path.join(projectPath, "pubspec.yaml");
    if (!fs.existsSync(pubspecPath)) return null;

    const content = fs.readFileSync(pubspecPath, "utf8");
    if (!content.includes("flutter:")) return null;

    const nameMatch = content.match(/^name:\s*([^\s#]+)/m);
    const name = nameMatch ? nameMatch[1]! : path.basename(projectPath);

    const libDir = path.join(projectPath, "lib");
    const entrypoints: string[] = [];
    const flavors = new Set<string>();

    // 1. Scan lib/*.dart entrypoints
    if (fs.existsSync(libDir)) {
      const files = fs.readdirSync(libDir);
      for (const file of files) {
        if (file.endsWith(".dart")) {
          try {
            const filePath = path.join(libDir, file);
            const fileContent = fs.readFileSync(filePath, "utf8");
            // Only Dart files that declare a main() entrypoint
            if (/\bmain\s*\(/.test(fileContent)) {
              entrypoints.push(file);
              const flavorMatch = file.match(/^main_([a-zA-Z0-9_-]+)\.dart$/);
              if (flavorMatch && flavorMatch[1]) {
                flavors.add(flavorMatch[1]);
              }
            }
          } catch {
            // ignore
          }
        }
      }
      entrypoints.sort((a, b) => {
        if (a === "main.dart") return -1;
        if (b === "main.dart") return 1;
        return a.localeCompare(b);
      });
    }

    // 2. Gradle flavors (Groovy & Kotlin)
    const gradlePaths = [
      path.join(projectPath, "android", "app", "build.gradle"),
      path.join(projectPath, "android", "app", "build.gradle.kts"),
    ];
    for (const gp of gradlePaths) {
      if (fs.existsSync(gp)) {
        try {
          const gFlavors = parseGradleFlavors(fs.readFileSync(gp, "utf8"));
          for (const f of gFlavors) flavors.add(f);
        } catch {
          // ignore
        }
      }
    }

    // 3. iOS Schemes
    const iosFlavors = parseIosSchemes(projectPath);
    for (const f of iosFlavors) flavors.add(f);

    // 4. pubspec.yaml assets flavors
    const pubspecFlavors = parsePubspecFlavors(content);
    for (const f of pubspecFlavors) flavors.add(f);

    // 5. .vscode/launch.json configurations
    const { configs: launchConfigurations, flavors: launchFlavors } = parseLaunchConfigs(projectPath);
    for (const f of launchFlavors) flavors.add(f);

    // Sort flavors logically: dev -> staging -> production
    const sortedFlavors = Array.from(flavors).sort((a, b) => {
      const order: Record<string, number> = { dev: 1, development: 1, staging: 2, uat: 3, prod: 4, production: 4 };
      const orderA = order[a.toLowerCase()] ?? 99;
      const orderB = order[b.toLowerCase()] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b);
    });

    return {
      name,
      path: projectPath,
      entrypoints: entrypoints.length > 0 ? entrypoints : ["main.dart"],
      flavors: sortedFlavors,
      launchConfigurations: launchConfigurations.length > 0 ? launchConfigurations : undefined,
    };
  } catch {
    return null;
  }
}

export function findFlutterSubprojects(rawParentDir: string): FlutterProject[] {
  const subprojects: FlutterProject[] = [];
  const parentDir = resolveUserPath(rawParentDir);
  if (!parentDir || !fs.existsSync(parentDir)) return subprojects;

  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        const subPath = path.join(parentDir, entry.name);
        const subProj = inspectProject(subPath);
        if (subProj) {
          subprojects.push(subProj);
        }
      }
    }
  } catch {
    // ignore filesystem read errors
  }
  return subprojects;
}

export function findBbBin(): string {
  const candidates = [
    process.env.BB_CLI,
    path.join(os.homedir(), ".local/bin/bb"),
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ];
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return "bb";
}

export async function getBbProjects(
  bbApi?: any,
): Promise<{ projects: BbProjectInfo[]; error: string | null }> {
  const result: BbProjectInfo[] = [];

  interface RawProject {
    id: string;
    name: string;
    path: string;
  }

  const rawProjects: RawProject[] = [];
  const failures: string[] = [];

  function collect(list: unknown): void {
    const items = Array.isArray(list)
      ? list
      : list && typeof list === "object" && "projects" in list && Array.isArray((list as any).projects)
      ? (list as any).projects
      : [];
    for (const p of items) {
      const srcPath = p?.sources?.find((s: any) => s.isDefault)?.path || p?.sources?.[0]?.path || p?.path;
      if (srcPath) {
        rawProjects.push({
          id: p.id,
          name: p.name || path.basename(srcPath),
          path: srcPath,
        });
      }
    }
  }

  // Try 1: the in-process SDK
  try {
    const list = bbApi?.sdk?.projects?.list;
    if (list) {
      collect(await list.call(bbApi.sdk.projects, { includePersonal: true }));
    } else {
      failures.push("sdk.projects.list: unavailable");
    }
  } catch (err) {
    failures.push(`sdk.projects.list: ${(err as Error).message}`);
  }

  // Try 2: `bb project list --json`
  if (rawProjects.length === 0) {
    try {
      const { stdout } = await execFileAsync(findBbBin(), ["project", "list", "--json"], {
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: [process.env.PATH, path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
            .filter(Boolean)
            .join(":"),
        },
      });
      collect(JSON.parse(stdout));
    } catch (err) {
      failures.push(`bb project list: ${(err as Error).message}`);
    }
  }

  for (const raw of rawProjects) {
    const resolvedPath = resolveUserPath(raw.path);
    const flutterProj = inspectProject(resolvedPath);
    const subprojects = findFlutterSubprojects(resolvedPath);

    result.push({
      id: raw.id,
      name: raw.name,
      path: resolvedPath,
      isFlutter: flutterProj !== null,
      flutterProject: flutterProj,
      subprojects,
    });
  }

  return {
    projects: result,
    error: result.length === 0 && failures.length > 0 ? failures.join("; ") : null,
  };
}

export async function detectProjects(searchDirs: string[]): Promise<FlutterProject[]> {
  const projects: FlutterProject[] = [];
  const visited = new Set<string>();

  for (const dir of searchDirs) {
    const resolvedDir = resolveUserPath(dir);
    if (!resolvedDir || visited.has(resolvedDir) || !fs.existsSync(resolvedDir)) continue;
    visited.add(resolvedDir);

    // Check if dir itself is a flutter project
    const selfProj = inspectProject(resolvedDir);
    if (selfProj) {
      projects.push(selfProj);
      continue;
    }

    // Search child directories (1 level down)
    const subs = findFlutterSubprojects(resolvedDir);
    for (const sub of subs) {
      if (!visited.has(sub.path)) {
        visited.add(sub.path);
        projects.push(sub);
      }
    }
  }

  return projects;
}
