import { v4 as uuid } from "uuid";
import { WebSocket } from "ws";
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "fs";
import { join, normalize } from "path";
import { homedir } from "os";
import { ClaudeProcess, ClaudeProcessOptions } from "./claude-process.js";
import { getConfig } from "./config.js";

export interface Session {
  channelId: string;
  projectPath: string;
  process: ClaudeProcess;
  wsConnections: Set<WebSocket>;
  permissionMode: string;
  model: string;
  state: "running" | "idle" | "closed";
  pendingControlRequests: Map<string, string>; // serverReqId -> claude request_id
  claudeConfig: any; // config from claude.exe initialize response (commands, models, etc.)
  _claudeConfigResolvers: Array<(config: any) => void>;
  /** Pending outbound control_request resolvers keyed by request_id */
  _pendingOutboundControl: Map<string, { resolve: (resp: any) => void; reject: (err: Error) => void }>;
  /** sessionId from claude.exe (used for reconnect matching) */
  resumeId?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(
    channelId: string,
    projectPath: string,
    options?: { model?: string; permissionMode?: string; resume?: string; thinkingLevel?: string }
  ): Session {
    // Defensive: destroy stale session with same channelId to prevent orphan processes
    const stale = this.sessions.get(channelId);
    if (stale) {
      console.log(`[session] destroying stale session channelId=${channelId} before creating new one`);
      stale.process.kill();
      stale.state = "closed";
      this.sessions.delete(channelId);
    }

    const config = getConfig();
    const proc = new ClaudeProcess();
    const session: Session = {
      channelId,
      projectPath,
      process: proc,
      wsConnections: new Set(),
      permissionMode: options?.permissionMode || config.defaults.permissionMode,
      model: options?.model || config.defaults.model,
      state: "running",
      pendingControlRequests: new Map(),
      claudeConfig: null,
      _claudeConfigResolvers: [],
      _pendingOutboundControl: new Map(),
      resumeId: options?.resume || undefined,
    };

    proc.spawn({
      cwd: projectPath,
      model: session.model,
      permissionMode: session.permissionMode,
      resume: options?.resume,
      thinkingLevel: options?.thinkingLevel,
    });

    // Send initialize request to claude.exe to get commands/models/agents
    proc.writeStdin({
      type: "control_request",
      request_id: uuid(),
      request: { subtype: "initialize" },
    });

    // Forward claude.exe stdout to all connected WebSocket clients
    // Also capture control_response for initialize
    proc.on("message", (msg: any) => {
      // Log all messages from claude.exe for debugging
      if (msg.type !== "assistant" && msg.type !== "system") {
        console.log(`[claude:${channelId.slice(0, 8)}] msg type=${msg.type}`, msg.type === "control_request" ? `subtype=${msg.request?.subtype}` : "");
      }
      if (msg.type === "control_response") {
        // Check if this is a response to one of our outbound control_requests
        const reqId = msg.response?.request_id;
        const pending = reqId ? session._pendingOutboundControl.get(reqId) : undefined;
        if (pending) {
          session._pendingOutboundControl.delete(reqId);
          if (msg.response?.subtype === "success") {
            pending.resolve(msg.response);
          } else {
            pending.reject(new Error(msg.response?.error || "control_request failed"));
          }
          return;
        }
        // Handle initialize response (has commands in response)
        if (msg.response?.subtype === "success" && msg.response?.response?.commands) {
          session.claudeConfig = msg.response.response;
          console.log(`[claude:${channelId.slice(0, 8)}] initialized with ${session.claudeConfig.commands?.length || 0} commands`);

          const keys = Object.keys(msg.response.response);
          console.log(`[claude:${channelId.slice(0, 8)}] initialize response has ${keys.length} keys`);
          for (const key of keys) {
            console.log(`[claude:${channelId.slice(0, 8)}]   - ${key}`);
          }

          // Extract permissionMode from claude.exe response if available
          if (msg.response.response.permission_mode) {
            session.permissionMode = msg.response.response.permission_mode;
            console.log(`[claude:${channelId.slice(0, 8)}] extracted permissionMode=${session.permissionMode}`);
          }

          if (session._claudeConfigResolvers) {
            for (const resolve of session._claudeConfigResolvers) {
              resolve(session.claudeConfig);
            }
            session._claudeConfigResolvers = [];
          }
          return;
        }
        // Other control_responses — don't forward to webview
        return;
      }
      if (msg.type === "control_request") {
        this.handleControlRequest(session, msg);
      } else {
        // Capture session_id from claude.exe for reconnect matching
        if (msg.session_id && !session.resumeId) {
          session.resumeId = msg.session_id;
          console.log(`[claude:${channelId.slice(0, 8)}] captured resumeId=${msg.session_id}`);
        }
        this.broadcast(session, {
          type: "from-extension",
          message: { type: "io_message", channelId, message: msg, done: false },
        });
      }
    });

    proc.on("exit", (code: number | null) => {
      session.state = "closed";
      this.broadcast(session, {
        type: "from-extension",
        message: {
          type: "io_message",
          channelId,
          message: { type: "result", subtype: code === 0 ? "success" : "error", is_error: code !== 0 },
          done: true,
        },
      });
    });

    proc.on("stderr", (line: string) => {
      console.error(`[claude:${channelId.slice(0, 8)}] ${line}`);
    });

    this.sessions.set(channelId, session);
    return session;
  }

  private handleControlRequest(session: Session, msg: any): void {
    // Map claude's request_id to a server-generated requestId for the webview
    const serverReqId = uuid();
    session.pendingControlRequests.set(serverReqId, msg.request_id);

    // Transform claude.exe's control_request fields to webview's expected format
    // claude.exe sends: { subtype, tool_name, input, ... }
    // webview expects: { type: "tool_permission_request", toolName, inputs, suggestions, ... }
    const req = msg.request || {};
    this.broadcast(session, {
      type: "from-extension",
      message: {
        type: "request",
        channelId: session.channelId,
        requestId: serverReqId,
        request: {
          type: "tool_permission_request",
          toolName: req.tool_name || req.toolName || "",
          inputs: req.input || req.inputs || {},
          suggestions: req.suggestions || [],
        },
      },
    });
  }

  /**
   * Find session by a pending control request ID (serverReqId).
   */
  findSessionByControlRequestId(serverReqId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.pendingControlRequests.has(serverReqId)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Wait for claudeConfig to be available (up to timeout ms).
   * Returns immediately if already available.
   */
  async waitForClaudeConfig(session: Session, timeout = 30000): Promise<any> {
    if (session.claudeConfig) {
      return session.claudeConfig;
    }
    return new Promise((resolve) => {
      const wrapper = (config: any) => {
        clearTimeout(timer);
        resolve(config);
      };
      const timer = setTimeout(() => {
        // Remove this resolver and return null on timeout
        const idx = session._claudeConfigResolvers.indexOf(wrapper);
        if (idx >= 0) session._claudeConfigResolvers.splice(idx, 1);
        console.log(`[waitForClaudeConfig] TIMEOUT after ${timeout}ms`);
        resolve(null);
      }, timeout);
      session._claudeConfigResolvers.push(wrapper);
    });
  }

  respondToControlRequest(session: Session, serverReqId: string, response: any): void {
    const claudeReqId = session.pendingControlRequests.get(serverReqId);
    if (!claudeReqId) return;
    session.pendingControlRequests.delete(serverReqId);

    session.process.writeStdin({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: claudeReqId,
        response,
      },
    });
  }

  /**
   * Send a control_request to claude.exe and wait for its response.
   */
  sendControlRequest(session: Session, request: any, timeout = 10000): Promise<any> {
    const requestId = uuid();
    session.process.writeStdin({
      type: "control_request",
      request_id: requestId,
      request,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session._pendingOutboundControl.delete(requestId);
        reject(new Error(`control_request timed out after ${timeout}ms`));
      }, timeout);
      session._pendingOutboundControl.set(requestId, {
        resolve: (resp: any) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  getSession(channelId: string): Session | undefined {
    return this.sessions.get(channelId);
  }

  findRunningSessionByResumeId(resumeId: string): Session | undefined {
    console.log(`[findRunningSessionByResumeId] looking for resumeId=${resumeId}`);
    for (const session of this.sessions.values()) {
      console.log(`[findRunningSessionByResumeId] checking session channelId=${session.channelId}, resumeId=${session.resumeId}, state=${session.state}`);
      if (session.state !== "closed" && session.resumeId === resumeId) return session;
    }
    console.log(`[findRunningSessionByResumeId] no match found`);
    return undefined;
  }

  destroySession(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.process.kill();
    session.state = "closed";
    this.sessions.delete(channelId);
  }

  listSessions(): Array<{ channelId: string; projectPath: string; state: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      channelId: s.channelId,
      projectPath: s.projectPath,
      state: s.state,
    }));
  }

  /**
   * List historical sessions from disk for a given project path.
   * Reads ~/.claude/projects/<encoded-path>/*.jsonl files.
   */
  listDiskSessions(projectPath: string): Array<{
    id: string;
    lastModified: number;
    fileSize: number;
    summary: string | null;
    gitBranch: string | null;
    isCurrentWorkspace: boolean;
  }> {
    try {
      const encoded = this.encodeProjectPath(projectPath);
      const projectDir = this.findProjectDir(encoded);
      if (!projectDir) return [];

      const files = readdirSync(projectDir);
      const sessions: Array<{
        id: string;
        lastModified: number;
        fileSize: number;
        summary: string | null;
        gitBranch: string | null;
        isCurrentWorkspace: boolean;
      }> = [];

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -6);
        // Validate UUID format
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) continue;

        const filePath = join(projectDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.size === 0) continue;

          const summary = this.extractSessionSummary(filePath, stat.size);

          sessions.push({
            id: sessionId,
            lastModified: stat.mtime.getTime(),
            fileSize: stat.size,
            summary,
            gitBranch: null,
            isCurrentWorkspace: true,
          });
        } catch {
          // Skip files we can't read
        }
      }

      // Sort by lastModified descending
      sessions.sort((a, b) => b.lastModified - a.lastModified);
      return sessions;
    } catch {
      return [];
    }
  }

  private encodeProjectPath(projectPath: string): string {
    // Same encoding as claude.exe: replace non-alphanumeric chars with "-"
    return normalize(projectPath).replace(/[^a-zA-Z0-9]/g, "-");
  }

  private findProjectDir(encoded: string): string | null {
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      // Try exact match first
      const exactPath = join(projectsDir, encoded);
      try {
        readdirSync(exactPath);
        return exactPath;
      } catch {
        // Not found, try prefix match (for long paths that get hashed)
        const limit = 200;
        if (encoded.length <= limit) return null;
        const prefix = encoded.slice(0, limit);
        const dirs = readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory() && d.name.startsWith(prefix + "-")) {
            return join(projectsDir, d.name);
          }
        }
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Extract a summary from a session JSONL file by reading head of file.
   * Looks for the first user message text content.
   */
  private extractSessionSummary(filePath: string, fileSize: number): string | null {
    try {
      const READ_SIZE = 8192;
      const buf = Buffer.alloc(Math.min(READ_SIZE, fileSize));
      const fd = openSync(filePath, "r");
      try {
        const bytesRead = readSync(fd, buf, 0, buf.length, 0);
        if (bytesRead === 0) return null;
        const head = buf.toString("utf-8", 0, bytesRead);
        const lines = head.split("\n").filter((l) => l.trim());

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" && obj.message) {
              const content = obj.message.content;
              if (typeof content === "string") {
                return content.length > 200 ? content.slice(0, 200) + "…" : content;
              }
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === "text" && typeof part.text === "string") {
                    const text = part.text.replace(/\n/g, " ").trim();
                    if (text) return text.length > 200 ? text.slice(0, 200) + "…" : text;
                  }
                }
              }
            }
            // Also check queue-operation for content
            if (obj.type === "queue-operation" && obj.content) {
              const text = String(obj.content).replace(/\n/g, " ").trim();
              if (text) return text.length > 200 ? text.slice(0, 200) + "…" : text;
            }
          } catch {
            // Skip unparseable lines
          }
        }
        return null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Load session messages from a JSONL file for resume.
   * Returns messages in the format the webview expects.
   */
  loadSessionMessages(projectPath: string, sessionId: string): Array<any> {
    try {
      const encoded = this.encodeProjectPath(projectPath);
      const projectDir = this.findProjectDir(encoded);
      if (!projectDir) return [];

      const filePath = join(projectDir, `${sessionId}.jsonl`);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const messages: Array<any> = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // Only include user and assistant messages, matching webview expectations
          if (obj.type !== "user" && obj.type !== "assistant") continue;
          if (obj.isMeta || obj.isSidechain || obj.teamName) continue;

          messages.push({
            type: obj.type,
            uuid: obj.uuid,
            session_id: obj.sessionId,
            message: obj.message,
            parent_tool_use_id: null,
            timestamp: obj.timestamp,
          });
        } catch {
          // Skip unparseable lines
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  attachWs(channelId: string, ws: WebSocket): void {
    const session = this.sessions.get(channelId);
    if (session) {
      session.wsConnections.add(ws);
    }
  }

  detachWs(channelId: string, ws: WebSocket): void {
    const session = this.sessions.get(channelId);
    if (session) {
      session.wsConnections.delete(ws);
    }
  }

  broadcastToSession(channelId: string, data: any): void {
    const session = this.sessions.get(channelId);
    if (session) this.broadcast(session, data);
  }

  private broadcast(session: Session, data: any): void {
    const msg = JSON.stringify(data);
    for (const ws of session.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
