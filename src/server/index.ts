import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SessionManager } from "./session-manager.js";
import { MessageHandler } from "./message-handler.js";
import { createRoutes } from "./routes.js";
import { getConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");

const config = getConfig();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sessionManager = new SessionManager();
const messageHandler = new MessageHandler(sessionManager);

app.use(express.json());

// REST API
app.use(createRoutes());

// Serve webview assets from the VSCode extension
app.use("/webview", express.static(join(config.extensionPath, "webview")));
app.use("/resources", express.static(join(config.extensionPath, "resources")));

// Serve client files
app.use("/static", express.static(join(PROJECT_ROOT, "src/client")));

// Service worker must be served from root scope
app.get("/sw.js", (_req, res) => {
  res.sendFile(join(PROJECT_ROOT, "src/client/sw.js"));
});

// iOS fetches apple-touch-icon from root path regardless of <link> tags
// It may request /apple-touch-icon.png, /apple-touch-icon-NxN.png, or -precomposed variants
app.get(/^\/apple-touch-icon.*\.png$/, (req, res) => {
  const file = req.path.slice(1); // strip leading /
  const filePath = join(PROJECT_ROOT, "src/client", file);
  res.sendFile(filePath, () => {
    // fallback to default icon if specific size not found
    res.sendFile(join(PROJECT_ROOT, "src/client/apple-touch-icon.png"));
  });
});
// Manifest also needs to be at a well-known path for some browsers
app.get("/manifest.json", (_req, res) => {
  res.sendFile(join(PROJECT_ROOT, "src/client/manifest.json"));
});

// Project list page
app.get("/", (_req, res) => {
  const htmlPath = join(PROJECT_ROOT, "src/client/project-list/index.html");
  res.sendFile(htmlPath);
});

// Chat page - serve host.html with project path injected
app.get("/chat", (req, res) => {
  const projectParam = req.query.project as string;
  if (!projectParam) {
    res.redirect("/");
    return;
  }
  // Decode base64-encoded project path
  let projectPath: string;
  try {
    projectPath = Buffer.from(projectParam, "base64").toString("utf-8");
  } catch {
    // Fallback: treat as plain text (for backward compatibility)
    projectPath = projectParam;
  }
  const theme = (req.query.theme as string) || "dark";
  const themeClass = theme === "light" ? "vscode-light" : "vscode-dark";
  // Extract project name from path
  const projectName = projectPath.replace(/\\/g, "/").split("/").pop() || projectPath;
  const htmlPath = join(PROJECT_ROOT, "src/client/host.html");
  let html = readFileSync(htmlPath, "utf-8");
  // For HTML contexts (title attr etc.), keep original path with HTML entity escaping
  html = html.replaceAll("{{PROJECT_PATH}}", projectPath.replace(/"/g, "&quot;"));
  // For JS string context, escape backslashes so they survive JS parsing
  html = html.replace("{{PROJECT_PATH_JS}}", projectPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  html = html.replace("{{PROJECT_NAME}}", projectName);
  const wsProto = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https" ? "wss" : "ws";
  const wsHost = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost:7860";
  html = html.replace("{{WS_URL}}", `${wsProto}://${wsHost}/ws`);
  html = html.replaceAll("{{THEME_CLASS}}", themeClass);
  // Inject session ID from query param into #root data attribute for resume
  const sessionParam = req.query.session as string;
  const rootDataAttrs = sessionParam ? `data-initial-session="${sessionParam.replace(/"/g, "&quot;")}"` : "";
  html = html.replace("{{ROOT_DATA_ATTRS}}", rootDataAttrs);
  res.send(html);
});

// WebSocket handling
wss.on("connection", (ws: WebSocket) => {
  // Track which channels this WS is associated with
  const channels = new Set<string>();

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // launch_claude may remap channelId (reconnect). handleInbound returns the
      // actual server channelId so we track the right one for cleanup on WS close.
      const resolvedChannelId = messageHandler.handleInbound(ws, msg);

      const trackId = resolvedChannelId || msg.channelId;
      if (trackId && !channels.has(trackId)) {
        channels.add(trackId);
        sessionManager.attachWs(trackId, ws);
      }
    } catch (err) {
      console.error("[ws] parse error:", err);
    }
  });

  ws.on("close", () => {
    for (const channelId of channels) {
      sessionManager.detachWs(channelId, ws);
    }
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`\n  claude-vs-ext-web server running at http://localhost:${config.port}\n`);
});
