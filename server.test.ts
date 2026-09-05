import { describe, expect, it } from "vitest";
import {
  findFlutterSubprojects,
  inferFlavorForTarget,
  inferTargetForFlavor,
  inspectProject,
  parseGradleFlavors,
  parseLaunchConfigs,
} from "./lib/flutter-cli";
import { FlutterSession } from "./lib/flutter-session";
import {
  deviceSchema,
  emulatorSchema,
  launchConfigSchema,
  projectSchema,
  sessionConfigSchema,
  sessionStateSchema,
} from "./server";

describe("Flutter plugin schemas", () => {
  it("validates FlutterDevice schema", () => {
    const validDevice = {
      id: "92A755BA-5492-4061-BE57-59B7F2FCBE9B",
      name: "iPhone 17e",
      targetPlatform: "ios",
      emulator: true,
      isSupported: true,
      sdk: "iOS 18.0",
    };
    const parsed = deviceSchema.parse(validDevice);
    expect(parsed.name).toBe("iPhone 17e");
    expect(parsed.emulator).toBe(true);
  });

  it("validates FlutterEmulator schema", () => {
    const validEmulator = {
      id: "apple_ios_simulator",
      name: "iOS Simulator",
      manufacturer: "Apple",
      platform: "ios",
    };
    const parsed = emulatorSchema.parse(validEmulator);
    expect(parsed.id).toBe("apple_ios_simulator");
  });

  it("validates LaunchConfig schema", () => {
    const validConfig = {
      name: "staging",
      target: "lib/main_staging.dart",
      flavor: "staging",
      mode: "debug" as const,
      args: ["--flavor", "staging"],
    };
    const parsed = launchConfigSchema.parse(validConfig);
    expect(parsed.name).toBe("staging");
    expect(parsed.flavor).toBe("staging");
  });

  it("validates SessionConfig schema", () => {
    const config = {
      projectPath: "/path/to/app",
      deviceId: "macos",
      target: "lib/main.dart",
      flavor: "dev",
      mode: "debug" as const,
    };
    const parsed = sessionConfigSchema.parse(config);
    expect(parsed.mode).toBe("debug");
  });

  it("validates SessionState schema", () => {
    const state = {
      status: "idle" as const,
      config: null,
      isPaused: false,
      progressMessage: null,
      appId: null,
      wsUri: null,
      devtoolsUrl: null,
      inspectorUrl: null,
      debuggerUrl: null,
      activeDevice: null,
      pid: null,
      startedAt: null,
      error: null,
    };
    const parsed = sessionStateSchema.parse(state);
    expect(parsed.status).toBe("idle");
    expect(parsed.isPaused).toBe(false);
  });
});

describe("Project inspector & flavor detection", () => {
  it("inspects parkane_app with all flavors and launch configurations", () => {
    const project = inspectProject("/Users/maximtkachenko/work/parknet/parkane_app");
    expect(project).not.toBeNull();
    if (project) {
      expect(project.name).toBe("parkane");
      expect(project.entrypoints).toContain("main.dart");
      expect(project.entrypoints).toContain("main_staging.dart");
      expect(project.entrypoints).toContain("main_production.dart");

      // Verify all 3 flavors are found (dev, staging, production)
      expect(project.flavors).toContain("dev");
      expect(project.flavors).toContain("staging");
      expect(project.flavors).toContain("production");

      // Verify launch configurations were parsed
      expect(project.launchConfigurations).toBeDefined();
      expect(project.launchConfigurations!.length).toBeGreaterThanOrEqual(3);

      const devCfg = project.launchConfigurations!.find((c) => c.name === "dev");
      expect(devCfg).toBeDefined();
      expect(devCfg?.flavor).toBe("dev");
      expect(devCfg?.target).toBe("lib/main.dart");

      const stagingCfg = project.launchConfigurations!.find((c) => c.name === "staging");
      expect(stagingCfg).toBeDefined();
      expect(stagingCfg?.flavor).toBe("staging");
      expect(stagingCfg?.target).toBe("lib/main_staging.dart");

      const prodCfg = project.launchConfigurations!.find((c) => c.name === "production");
      expect(prodCfg).toBeDefined();
      expect(prodCfg?.flavor).toBe("production");
      expect(prodCfg?.target).toBe("lib/main_production.dart");

      const parsed = projectSchema.parse(project);
      expect(parsed.name).toBe("parkane");
    }
  });

  it("finds flutter subprojects in monorepo root parknet", () => {
    const subprojects = findFlutterSubprojects("/Users/maximtkachenko/work/parknet");
    expect(subprojects.length).toBeGreaterThanOrEqual(1);
    const parkaneApp = subprojects.find((p) => p.name === "parkane");
    expect(parkaneApp).toBeDefined();
    expect(parkaneApp?.path).toBe("/Users/maximtkachenko/work/parknet/parkane_app");
  });

  it("infers flavors and targets correctly for parkane", () => {
    const project = inspectProject("/Users/maximtkachenko/work/parknet/parkane_app");
    expect(project).not.toBeNull();
    if (project) {
      // Target -> Flavor inference
      expect(inferFlavorForTarget("lib/main.dart", project)).toBe("dev");
      expect(inferFlavorForTarget("lib/main_staging.dart", project)).toBe("staging");
      expect(inferFlavorForTarget("lib/main_production.dart", project)).toBe("production");

      // Flavor -> Target inference
      expect(inferTargetForFlavor("staging", project)).toBe("lib/main_staging.dart");
      expect(inferTargetForFlavor("production", project)).toBe("lib/main_production.dart");
      expect(inferTargetForFlavor("dev", project)).toBe("lib/main.dart");
    }
  });

  it("parses launch.json with comments and trailing commas", () => {
    const jsonContent = `
      {
        // VS Code launch configurations
        "version": "0.2.0",
        "configurations": [
          {
            "name": "Staging App",
            "program": "lib/main_staging.dart",
            "request": "launch",
            "type": "dart",
            "args": ["--flavor=staging", "--verbose",],
          },
        ],
      }
    `;
    const { configs } = parseLaunchConfigs(jsonContent);
    expect(configs.length).toBe(1);
    expect(configs[0]?.name).toBe("Staging App");
    expect(configs[0]?.target).toBe("lib/main_staging.dart");
    expect(configs[0]?.flavor).toBe("staging");
  });

  it("parses gradle productFlavors with nested blocks", () => {
    const gradle = `
      productFlavors {
        dev {
          dimension "env"
          applicationId "com.example.dev"
        }
        staging {
          dimension "env"
          applicationId "com.example.staging"
        }
        production {
          dimension "env"
          applicationId "com.example"
        }
      }
    `;
    const flavors = parseGradleFlavors(gradle);
    expect(Array.from(flavors)).toEqual(["dev", "staging", "production"]);
  });

  it("returns null for non-flutter project", () => {
    const project = inspectProject("/tmp");
    expect(project).toBeNull();
  });
});

describe("FlutterSession lifecycle", () => {
  it("initializes with idle state", () => {
    const session = new FlutterSession();
    const state = session.getState();
    expect(state.status).toBe("idle");
    expect(state.isPaused).toBe(false);
    expect(state.appId).toBeNull();
    expect(state.pid).toBeNull();
  });

  it("buffers logs correctly", () => {
    const session = new FlutterSession();
    expect(session.getLogs().length).toBe(0);
    session.clearLogs();
    expect(session.getLogs().length).toBe(0);
  });
});
