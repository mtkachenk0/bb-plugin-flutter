export interface FlutterDevice {
  id: string;
  name: string;
  targetPlatform: string;
  emulator: boolean;
  isSupported: boolean;
  sdk?: string;
}

export interface FlutterEmulator {
  id: string;
  name: string;
  manufacturer: string;
  platform: string;
}

export interface LaunchConfiguration {
  name: string;
  target?: string;
  flavor?: string;
  mode?: "debug" | "profile" | "release";
  args?: string[];
}

export interface FlutterProject {
  name: string;
  path: string;
  entrypoints: string[];
  flavors: string[];
  launchConfigurations?: LaunchConfiguration[];
}

export interface BbProjectInfo {
  id: string;
  name: string;
  path: string;
  isFlutter: boolean;
  flutterProject: FlutterProject | null;
  subprojects: FlutterProject[];
}

export interface SessionConfig {
  projectPath: string;
  deviceId: string;
  target?: string | null;
  flavor?: string | null;
  mode: "debug" | "profile" | "release";
  additionalArgs?: string[] | null;
}

export type SessionStatus =
  | "idle"
  | "starting"
  | "building"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export interface SessionState {
  status: SessionStatus;
  config: SessionConfig | null;
  isPaused: boolean;
  progressMessage: string | null;
  appId: string | null;
  wsUri: string | null;
  devtoolsUrl: string | null;
  inspectorUrl: string | null;
  debuggerUrl: string | null;
  activeDevice: FlutterDevice | null;
  pid: number | null;
  startedAt: number | null;
  error: string | null;
}

export interface LogEntry {
  id: number;
  timestamp: number;
  type: "stdout" | "stderr" | "system" | "progress";
  message: string;
}
