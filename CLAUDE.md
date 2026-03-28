# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-vs-ext-web** is a web-based Claude Code interface. It bridges the VSCode Claude Code extension's React webview into a standalone browser-accessible application. The server spawns the `claude` binary (Windows: `claude.exe`, macOS/Linux: `claude`) and proxies communication between the browser and Claude via WebSocket.

## Commands

- **`bun run dev`** — Start dev server with hot reload (`bun --watch src/server/index.ts`)
- **`bun run build`** — TypeScript compile to `dist/`
- **`bun run start`** — Run server (`bun src/server/index.ts`)
- **Kill stale process (Windows):** `netstat -ano | grep ":7860 " | grep LISTENING` to find PID, then `taskkill //PID <pid> //F`
- **Kill stale process (macOS/Linux):** `lsof -ti:7860 | xargs kill -9`

No test or lint commands are configured.

## Architecture

### Three-Layer Design

1. **Express + WebSocket Server** (`src/server/`) — Serves pages, manages sessions, spawns `claude` binary, routes messages
2. **Shim Layer** (`src/client/shim.js`) — Replaces VSCode's `acquireVsCodeApi()` with a WebSocket bridge so the unmodified extension webview works in a browser
3. **VSCode Extension Webview** (`vendor/claude-code/webview/`) — The actual React chat UI, served as-is from the vendored extension

### Server Components

- **`index.ts`** — Express app + WebSocket server. Routes: `/` (project list), `/chat?project=<base64>` (chat page with template injection), `/static/*` (client files), `/webview/*` + `/resources/*` (extension assets), `/api/*` (REST). Injects `{{PROJECT_PATH}}`, `{{WS_URL}}`, `{{PERMISSION_MODE}}`, `{{THEME_CLASS}}` into host.html template
- **`session-manager.ts`** — Manages `Session` objects (channelId, projectPath, ClaudeProcess, WebSocket connections, state, claudeConfig). Handles process lifecycle, message broadcasting to clients. Injects synthetic `system/status` io_messages to propagate permissionMode to webview
- **`message-handler.ts`** — Routes WebSocket messages by type: `launch_claude`, `io_message`, `interrupt_claude`, `close_channel`, `request`, `response`. Handles session reattach on reconnect, sends `update_state` with fallback config when claude binary exits early
- **`claude-process.ts`** — Spawns `claude` binary with `--output-format stream-json --input-format stream-json --verbose --allow-dangerously-skip-permissions --permission-prompt-tool stdio`. Parses newline-delimited JSON from stdout
- **`routes.ts`** — REST API: project discovery from `~/.claude/projects/` + manual config
- **`config.ts`** — Reads `config.json` for port, project roots, defaults. Computes `extensionPath` and `claudeBinaryPath` from `vendor/claude-code/`

### Client Components

- **`host.html`** — Chat page template. Server injects `{{PROJECT_PATH}}`, `{{WS_URL}}`, `{{PERMISSION_MODE}}`, `{{THEME_CLASS}}` before serving. Loads shim.js, then the extension's webview JS
- **`shim.js`** — Core bridge. Replaces `acquireVsCodeApi()` (called once by webview). Queues messages before WS opens. Auto-reconnects on disconnect (2s delay). Overrides `permissionMode` in `launch_claude` from server config. Handles channelId remapping on reconnect
- **`css-variables.css`** — Defines all `--vscode-*` CSS variables for both `.vscode-dark` (GitHub Dark Default) and `.vscode-light` (GitHub Light Default) themes
- **`project-list/`** — Standalone project selection page (no framework)

### Vendor Directory

`vendor/claude-code/` contains the extracted VSCode Claude Code extension (git-ignored). Key paths within:
- `webview/index.js` + `index.css` — The React chat app
- `resources/native-binary/claude.exe` (Windows) or `claude` (macOS/Linux) — The Claude CLI binary
- `resources/` — SVGs, icons, welcome art

## Critical Protocol Details

### Message Format

- **Server → Browser**: Always wrapped as `{type: "from-extension", message: {...}}`
- **Browser → Server**: Messages include `channelId` and vary by `type` (`launch_claude`, `io_message`, `request`, `response`, etc.)

### init_response Structure

The `claudeSettings` in the init response **MUST** include an `effective` sub-object with `permissions`:
```javascript
claudeSettings: {
  effective: { permissions: { allow: [], deny: [], ask: [] } },
  permissions: { allow: [], deny: [], ask: [] },
}
```
Without `effective`, the webview crashes because it accesses `claudeSettings?.effective.permissions` (non-optional `.permissions`).

### Claude Binary Initialize Protocol

1. Server sends `{type: "control_request", request_id, request: {subtype: "initialize"}}` after spawn
2. Claude binary responds with `control_response` containing `{commands, agents, models, account, pid, ...}`
3. Config is captured in `session.claudeConfig` and pushed to webview via `update_state` request
4. **IMPORTANT**: `update_state` state field must contain full init state (not empty `{}`), otherwise the webview crashes
5. If claude binary exits before returning config (e.g. invalid resume session), a fallback empty config `{commands:[], models:[], agents:[]}` is sent to unblock the webview

### Permission Mode Propagation

**VENDOR DEPENDENCY**: The webview's `processMessage` only updates `permissionMode` from `{type: "system", subtype: "status"}` io_messages. The server injects synthetic messages at three points:
1. **session-manager.ts** — After every `system init` message from claude binary (new sessions)
2. **message-handler.ts reattach path** — When reconnecting to an existing session
3. **message-handler.ts resume path** — After `update_state` for resumed sessions

The shim.js also overrides `permissionMode` in every `launch_claude` message using the value from `WEB_CC_CONFIG.permissionMode` (injected by server from `config.json`).

### Webview Lifecycle

- `get_claude_state` is called BEFORE any session exists, so the initial response has null config
- Config is pushed later via `update_state` once claude binary finishes initializing
- Permission requests from claude binary are transformed into webview-compatible format and forwarded via WebSocket
- Session and WS are registered BEFORE spawning claude binary to prevent message loss on immediate exit

## Dev Notes

- The server runs on port 7860 by default (configurable in `config.json`)
- `Uncaught (in promise)` errors after sending messages are normal — they come from the webview's internal promise handling
- Slash commands from `claudeConfig.commands` work when typed directly but do NOT appear in the `/` command menu autocomplete
- Theme preference is persisted in `localStorage` under key `web-cc-theme`
- TypeScript: ESM modules (`"type": "module"`), target ES2022, strict mode, `NodeNext` module resolution
- Service Worker caches static assets; clear via DevTools or `navigator.serviceWorker.getRegistrations()` + `caches.delete()` when testing shim.js changes
