# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-vs-ext-web** is a web-based Claude Code interface. It bridges the VSCode Claude Code extension's React webview into a standalone browser-accessible application. The server spawns `claude` binary (Windows: `claude.exe`, macOS: `claude`) and proxies communication between the browser and Claude via WebSocket.

## Commands

- **`bun run dev`** — Start dev server with hot reload (`bun --watch src/server/index.ts`)
- **`bun run build`** — TypeScript compile to `dist/`
- **`bun run start`** — Run server (`bun src/server/index.ts`)
- **Kill stale process (Windows):** `netstat -ano | grep ":7860 " | grep LISTENING` to find PID, then `taskkill //PID <pid> //F`
- **Kill stale process (macOS):** `lsof -ti:7860 | xargs kill -9`

No test or lint commands are configured.

## Architecture

### Three-Layer Design

1. **Express + WebSocket Server** (`src/server/`) — Serves pages, manages sessions, spawns `claude` binary, routes messages
2. **Shim Layer** (`src/client/shim.js`) — Replaces VSCode's `acquireVsCodeApi()` with a WebSocket bridge so the unmodified extension webview works in a browser
3. **VSCode Extension Webview** (`vendor/claude-code/webview/`) — The actual React chat UI, served as-is from the vendored extension

### Server Components

- **`index.ts`** — Express app + WebSocket server. Routes: `/` (project list), `/chat?project=<base64>` (chat page with template injection), `/static/*` (client files), `/webview/*` + `/resources/*` (extension assets), `/api/*` (REST)
- **`session-manager.ts`** — Manages `Session` objects (channelId, projectPath, ClaudeProcess, WebSocket connections, state, claudeConfig). Handles process lifecycle, message broadcasting to clients
- **`message-handler.ts`** — Routes WebSocket messages by type: `launch_claude`, `io_message`, `interrupt_claude`, `close_channel`, `request`, `response`
- **`claude-process.ts`** — Spawns `claude` binary with `--output-format stream-json --input-format stream-json --verbose --allow-dangerously-skip-permissions --permission-prompt-tool stdio`. Parses newline-delimited JSON from stdout
- **`routes.ts`** — REST API: project discovery from `~/.claude/projects/` + manual config
- **`config.ts`** — Reads `config.json` for port, project roots, defaults. Computes `extensionPath` and `claudeBinaryPath` from `vendor/claude-code/`

### Client Components

- **`host.html`** — Chat page template. Server injects `{{PROJECT_PATH}}`, `{{WS_URL}}`, `{{THEME_CLASS}}` before serving. Loads shim.js, then the extension's webview JS
- **`shim.js`** — Core bridge. Replaces `acquireVsCodeApi()` (called once by webview). Queues messages before WS opens. Auto-reconnects on disconnect (2s delay)
- **`css-variables.css`** — Defines all `--vscode-*` CSS variables for both `.vscode-dark` (GitHub Dark Default) and `.vscode-light` (GitHub Light Default) themes
- **`project-list/`** — Standalone project selection page (no framework)

### Vendor Directory

`vendor/claude-code/` contains the extracted VSCode Claude Code extension (git-ignored). Key paths within:
- `webview/index.js` + `index.css` — The React chat app
- `resources/native-binary/claude.exe` (Windows) or `claude` (macOS) — The Claude CLI binary
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

### claude.exe Initialize Protocol

1. Server sends `{type: "control_request", request_id, request: {subtype: "initialize"}}` after spawn
2. claude.exe responds with `control_response` containing `{commands, agents, models, account, pid, ...}`
3. Config is captured in `session.claudeConfig` and pushed to webview via `update_state` request
4. **IMPORTANT**: `update_state` state field must contain full init state (not empty `{}`), otherwise the webview crashes

### Webview Lifecycle

- `get_claude_state` is called BEFORE any session exists, so the initial response has null config
- Config is pushed later via `update_state` once claude.exe finishes initializing
- Permission requests from claude.exe are transformed into webview-compatible format and forwarded via WebSocket

## Dev Notes

- The server runs on port 7860 by default (configurable in `config.json`)
- `Uncaught (in promise)` errors after sending messages are normal — they come from the webview's internal promise handling
- Slash commands from `claudeConfig.commands` work when typed directly but do NOT appear in the `/` command menu autocomplete
- Theme preference is persisted in `localStorage` under key `web-cc-theme`
- TypeScript: ESM modules (`"type": "module"`), target ES2022, strict mode, `NodeNext` module resolution
