---
name: flutter
description: Build, run, hot reload, hot restart, pause/resume, and debug Flutter applications with widget inspection on devices and emulators.
---

# Flutter Build & Debugging Plugin

This plugin enables building, running, hot reloading, debugging, and inspecting Flutter applications directly from BB.

## Capabilities

1. **Multi-Device & Emulator Support**:
   - Inspect connected physical iOS/Android devices, desktop (macOS), and web (Chrome).
   - Discover and launch iOS simulators or Android AVD emulators with one command or click.

2. **Full Lifecycle Controls**:
   - **Launch Build (`flutter run --machine`)**: Supports target entrypoints (e.g. `lib/main_staging.dart`), build flavors (`staging`, `dev`, `production`), and build modes (`debug`, `profile`, `release`).
   - **Hot Reload**: Sub-second stateful code reload (`app.restart` with `fullRestart: false`).
   - **Hot Restart**: Re-executes the main isolate, rebuilding widget state from scratch (`app.restart` with `fullRestart: true`).
   - **Pause & Resume**: Directly pauses and resumes isolate execution via the Dart VM Service.
   - **Stop**: Gracefully terminates the running app process.

3. **Integrated Widget Inspector & Debugger (Cursor/VS Code style)**:
   - Dedicated Nav Panel with embedded Dart DevTools Widget Inspector:
     - Expandable widget tree.
     - Visual Layout Explorer for flex rows, columns, and padding.
     - Tap-to-select widget on device mode (`ext.flutter.inspector.selectMode`).
     - Debug paint boundaries (`ext.flutter.debugPaint`).
     - Performance overlay and slow animation toggles.
   - Embedded Dart DevTools Debugger:
     - Source browser, breakpoints, call stacks, variable inspect, step into/over/out.
   - Real-time color-coded console logs with filtering and auto-scroll.

---

## Agent Tools

When working on Flutter code, prefer using the registered Flutter tools over spawning ad-hoc terminal processes:

| Tool Name | Parameters | Description |
|---|---|---|
| `flutter_list_devices` | `{}` | Returns all connected devices and launchable emulators. |
| `flutter_launch_emulator` | `{ emulatorId }` | Launches an iOS Simulator or Android emulator (e.g. `apple_ios_simulator`). |
| `flutter_run` | `{ projectPath, deviceId, target?, flavor?, mode? }` | Starts building and running the Flutter app. |
| `flutter_hot_reload` | `{}` | Triggers Hot Reload to sync source changes instantly. |
| `flutter_hot_restart` | `{}` | Triggers Hot Restart. |
| `flutter_pause` | `{}` | Pauses application execution in the Dart VM. |
| `flutter_resume` | `{}` | Resumes application execution in the Dart VM. |
| `flutter_stop` | `{}` | Stops the running Flutter process. |
| `flutter_get_status` | `{ includeRecentLogs? }` | Returns current state, VM URI, DevTools/Inspector/Debugger URLs, and logs. |
| `flutter_service_extension` | `{ extension, value? }` | Toggles `selectWidgetMode`, `debugPaint`, `performanceOverlay`, or `slowAnimations`. |

### Agent Workflow Example

1. **Find target device**:
   Call `flutter_list_devices` to pick a device or launch an emulator:
   ```json
   {}
   ```

2. **Launch the application**:
   ```json
   {
     "projectPath": "/Users/maximtkachenko/work/parknet/parkane_app",
     "deviceId": "92A755BA-5492-4061-BE57-59B7F2FCBE9B",
     "target": "lib/main_staging.dart",
     "flavor": "staging",
     "mode": "debug"
   }
   ```

3. **Make code edits, then Hot Reload**:
   After modifying Dart widgets or business logic, call `flutter_hot_reload`:
   ```json
   {}
   ```

4. **Verify status or inspect errors**:
   Call `flutter_get_status` with `includeRecentLogs: true` to confirm successful reload or read exceptions.

---

## CLI Commands

You or the user can also manage Flutter directly from the shell via `bb flutter`:

```bash
# List all devices and emulators
bb flutter devices

# Launch an emulator
bb flutter launch-emulator apple_ios_simulator

# Run a project
bb flutter run --project /path/to/project --device <deviceId> --flavor staging --target lib/main_staging.dart

# Hot reload active app
bb flutter reload

# Hot restart active app
bb flutter restart

# Pause execution
bb flutter pause

# Resume execution
bb flutter resume

# Stop app
bb flutter stop

# Inspect state and DevTools URLs
bb flutter status

# View recent console logs
bb flutter logs --limit 100

# Print Widget Inspector URL
bb flutter inspector

# Print Debugger URL
bb flutter debugger
```