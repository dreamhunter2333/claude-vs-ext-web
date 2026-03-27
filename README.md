# claude-vs-ext-web — Web-Based Claude Code

[English](README.md) | [简体中文](README.zh-CN.md)

A standalone web interface for [Claude Code](https://claude.ai/code) that runs in any modern browser. claude-vs-ext-web reuses the official VSCode Claude Code extension's React chat UI through a custom shim layer, with a Node.js backend managing `claude.exe` processes via WebSocket.

## How It Works

```mermaid
graph TB
    subgraph Browser
        A[VSCode Extension Webview<br/>React, unmodified]
        B[shim.js<br/>replaces acquireVsCodeApi with WS]
        A --> B
    end

    subgraph "Node.js Server"
        C[Express + WebSocket Server]
        D[Routes API]
        E[Message Handler]
        F[Session Manager]
        G[claude.exe<br/>stream-json protocol]

        C --> D
        C --> E
        E --> F
        F -->|stdin/stdout| G
    end

    B -->|WebSocket /ws| C
```

**Key Insight**: Instead of rebuilding the chat UI from scratch, claude-vs-ext-web serves the extension's original webview files and injects a shim that replaces VSCode's `acquireVsCodeApi()` with a WebSocket bridge. The extension's React app works unmodified in the browser.

## Features

- **Full Claude Code Chat UI** — The same React-based interface from the VSCode extension
- **Project Discovery** — Auto-discovers projects from `~/.claude/projects/` session history
- **Session Resume** — Resume previous conversations from saved history
- **Permission Control** — Tool permission request/response flow with user approval
- **Model Selection** — Switch between Claude models (Sonnet, Opus, etc.)
- **Theme Switching** — GitHub Dark / GitHub Light themes, persisted in localStorage
- **Multi-Session** — Each project gets its own isolated `claude.exe` process
- **Auto-Reconnect** — WebSocket reconnects automatically on disconnect (2s delay)
- **Slash Commands** — Extension slash commands work via direct input

## Prerequisites

- **Node.js** 18+ or **Bun** 1.0+
- **VSCode Claude Code Extension** — Extracted into `vendor/claude-code/`
- **Platform Support**:
  - **Windows** — Uses `claude.exe`
  - **macOS** — Uses `claude` binary

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set up the vendor directory (see below)
# 3. Start the dev server
bun run dev

# 4. Open http://localhost:7860
```

## Vendor Setup

The `vendor/claude-code/` directory (git-ignored) must contain the extracted VSCode Claude Code extension.

### Windows

#### Option A: Copy from installed extension

```bash
# Find your extension path (example for v2.1.84):
# C:\Users\<user>\.vscode\extensions\anthropic.claude-code-2.1.84-win32-x64\

xcopy /E /I "%USERPROFILE%\.vscode\extensions\anthropic.claude-code-*" vendor\claude-code\
```

#### Option B: Extract from .vsix file

```bash
# Rename .vsix to .zip and extract
ren claude-code-*.vsix claude-code.zip
tar -xf claude-code.zip -C vendor/claude-code/
```

### macOS

#### Option A: Copy from installed extension

```bash
# Find your extension path (example for v2.1.84):
# ~/.vscode/extensions/anthropic.claude-code-2.1.84-darwin-arm64/

cp -r ~/.vscode/extensions/anthropic.claude-code-* vendor/claude-code/
```

#### Option B: Extract from .vsix file

```bash
# Rename .vsix to .zip and extract
mv claude-code-*.vsix claude-code.zip
unzip claude-code.zip -d vendor/claude-code/
```

### Required vendor files

```
vendor/claude-code/
├── webview/
│   ├── index.js          # React chat app (minified)
│   └── index.css         # Webview styles
├── resources/
│   ├── native-binary/
│   │   └── claude.exe    # Claude CLI binary
│   ├── clawd.svg         # Logo
│   └── ...               # Icons, images
└── package.json          # Extension manifest
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start with hot reload (`bun --watch`) |
| `bun run build` | Compile TypeScript to `dist/` |
| `bun run start` | Run compiled server |

## Configuration

`config.json` (auto-created if missing):

```json
{
  "port": 7860,
  "projects": {
    "roots": [],
    "manual": [],
    "scanDepth": 1
  },
  "defaults": {
    "permissionMode": "bypassPermissions",
    "model": "claude-opus-4-6[1m]"
  }
}
```

| Field | Description |
|-------|-------------|
| `port` | Server port (default: 7860) |
| `projects.roots` | Directories to scan for projects (not implemented yet) |
| `projects.manual` | Manually added project paths |
| `projects.scanDepth` | Recursion depth when scanning roots (not implemented yet) |
| `defaults.permissionMode` | `default` / `bypassPermissions` / `always-ask` |
| `defaults.model` | Default Claude model (e.g., `claude-opus-4-6[1m]`) |

<details>
<summary><b>Project Structure</b></summary>

```
src/
├── server/
│   ├── index.ts            # Express app, WebSocket, HTTP routes
│   ├── session-manager.ts  # Session lifecycle, claude.exe process management
│   ├── message-handler.ts  # WebSocket message routing & response building
│   ├── claude-process.ts   # Spawns claude.exe, parses stream-json stdout
│   ├── config.ts           # Config loading, vendor path resolution
│   └── routes.ts           # REST API (/api/projects, /api/config)
└── client/
    ├── shim.js             # WebSocket bridge replacing VSCode API
    ├── host.html           # Chat page template (server injects vars)
    ├── css-variables.css   # 239 --vscode-* CSS variables for theming
    └── project-list/       # Project selection page (vanilla JS)
```

</details>

<details>
<summary><b>Protocol Overview</b></summary>

### WebSocket Messages

**Browser → Server:**
```jsonc
{ "type": "launch_claude", "channelId": "uuid", "cwd": "/path", "model": "sonnet" }
{ "type": "io_message", "channelId": "uuid", "message": { "type": "user", ... } }
{ "type": "request", "channelId": "uuid", "requestId": "uuid", "request": { "type": "init" } }
```

**Server → Browser** (always wrapped):
```jsonc
{ "type": "from-extension", "message": { "type": "io_message", "channelId": "uuid", ... } }
```

### claude.exe Communication

The server communicates with `claude.exe` via stdin/stdout using newline-delimited JSON (`stream-json` format). Key flows:

1. **Initialize** — Server sends `control_request{subtype:"initialize"}`, receives config (models, commands, agents)
2. **Chat** — User messages forwarded as `io_message`, responses streamed back
3. **Permissions** — `tool_permission_request` from claude.exe → transformed → webview → user approves → `tool_permission_response` → back to claude.exe
4. **Interrupt** — `control_request{subtype:"interrupt"}` sent to stop generation

</details>

<details>
<summary><b>Known Limitations</b></summary>

- **No SSL/TLS** — HTTP/WS only, not suitable for remote deployment without a reverse proxy
- **No file operations** — File open/diff commands are stubbed
- **No terminal integration** — Terminal commands return null
- **No MCP servers** — MCP server list returns empty stubs
- **Slash command autocomplete** — Works with direct input only, not the `/` menu dropdown

</details>

<details>
<summary><b>Troubleshooting</b></summary>

### Port already in use
```bash
# Find and kill the process on port 7860 (Windows)
netstat -ano | grep ":7860 " | grep LISTENING
taskkill //PID <pid> //F
```

### Webview crashes on load
Ensure `claudeSettings.effective.permissions` is present in the init response. The webview uses `claudeSettings?.effective.permissions` (non-optional `.permissions`), so a missing `effective` field will crash it.

### `Uncaught (in promise)` errors in console
These are normal — they come from the extension webview's internal promise handling and don't affect functionality.

</details>

## License

MIT
