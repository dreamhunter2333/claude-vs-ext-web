import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { SessionManager } from "./session-manager.js";
import { getConfig } from "./config.js";
import { exec } from "child_process";

export class MessageHandler {
  private pendingClaudeStateRequests: Array<{ ws: WebSocket; respond: (response: any) => void; cwd?: string }> = [];

  constructor(private sessionManager: SessionManager) {}

  handleInbound(ws: WebSocket, msg: any): string | undefined {
    console.log(`[ws] inbound: ${msg.type}`, msg.type === 'request' ? msg.request?.type : '', msg.type === 'io_message' ? JSON.stringify(msg.message).substring(0, 100) : '');
    switch (msg.type) {
      case "launch_claude":
        return this.handleLaunch(ws, msg);
      case "io_message":
        this.handleIoMessage(msg);
        break;
      case "interrupt_claude":
        this.handleInterrupt(msg);
        break;
      case "close_channel":
        this.handleClose(msg);
        break;
      case "request":
        this.handleRequest(ws, msg);
        break;
      case "response":
        this.handleResponse(msg);
        break;
      case "cancel_request":
        // For now, no-op
        break;
      default:
        console.log(`[ws] unknown message type: ${msg.type}`);
    }
  }

  /** Returns the actual server-side channelId (may differ from msg.channelId on reconnect) */
  handleLaunch(ws: WebSocket, msg: any): string {
    const { channelId, resume, cwd, model, permissionMode, thinkingLevel } = msg;
    console.log(`[launch] channelId=${channelId}, resume=${resume}, cwd=${cwd}`);

    // Try to reattach to an existing running session.
    // 1. Exact channelId match (normal case)
    // 2. resume (sessionId) matches a running session (reconnect after WS drop)
    let existing = this.sessionManager.getSession(channelId);
    if ((!existing || existing.state === "closed") && resume) {
      existing = this.sessionManager.findRunningSessionByResumeId(resume);
    }

    if (existing && existing.state !== "closed") {
      const serverChannelId = existing.channelId;
      console.log(`[launch] reattaching to existing session serverChannelId=${serverChannelId}`);
      this.sessionManager.attachWs(serverChannelId, ws);

      // Tell the shim to remap channelId if it changed after reconnect
      if (channelId !== serverChannelId) {
        ws.send(JSON.stringify({
          type: "channel_remap",
          webviewChannelId: channelId,
          serverChannelId,
        }));
      }

      // Push current config so webview initializes properly
      if (existing.claudeConfig) {
        const initState = this.buildInitResponse(serverChannelId, cwd);
        ws.send(JSON.stringify({
          type: "from-extension",
          message: {
            type: "request",
            channelId: serverChannelId,
            requestId: uuid(),
            request: {
              type: "update_state",
              state: initState.state,
              config: existing.claudeConfig,
            },
          },
        }));
      }
      return serverChannelId;
    }

    // No existing session to reattach -- create a new one
    const session = this.sessionManager.createSession(channelId, cwd, {
      model,
      permissionMode,
      resume,
      thinkingLevel,
    });
    this.sessionManager.attachWs(channelId, ws);

    // Once claude.exe config is available, push it to all connected clients via update_state.
    // Use broadcastToSession instead of the captured ws, because the original ws may have
    // closed and been replaced by a reconnect before the config resolves.
    this.sessionManager.waitForClaudeConfig(session).then((config) => {
      console.log(`[launch] waitForClaudeConfig resolved, config=${!!config}`);
      if (config) {
        const initState = this.buildInitResponse(channelId, cwd);
        this.sessionManager.broadcastToSession(channelId, {
          type: "from-extension",
          message: {
            type: "request",
            channelId,
            requestId: uuid(),
            request: {
              type: "update_state",
              state: initState.state,
              config,
            },
          },
        });
        console.log(`[launch] pushed update_state with config (${config.commands?.length || 0} commands) to webview`);
      }
    }).catch((err) => {
      console.error(`[launch] waitForClaudeConfig error:`, err);
    });
    return channelId;
  }

  private handleIoMessage(msg: any): void {
    const session = this.sessionManager.getSession(msg.channelId);
    if (!session) return;
    // Forward user message to claude.exe stdin
    session.process.writeStdin(msg.message);
  }

  private handleInterrupt(msg: any): void {
    const session = this.sessionManager.getSession(msg.channelId);
    if (!session) return;
    session.process.interrupt();
  }

  private handleClose(msg: any): void {
    this.sessionManager.destroySession(msg.channelId);
  }

  private handleRequest(ws: WebSocket, msg: any): void {
    const { requestId, channelId, request, cwd } = msg;
    const respond = (response: any) => {
      console.log(`[ws] respond: ${response.type}`, requestId);
      ws.send(
        JSON.stringify({
          type: "from-extension",
          message: { type: "response", requestId, response },
        })
      );
    };

    switch (request.type) {
      case "init":
        respond(this.buildInitResponse(channelId, cwd));
        break;
      case "list_sessions_request": {
        const session = channelId ? this.sessionManager.getSession(channelId) : undefined;
        const projectPath = session?.projectPath || request?.cwd || cwd || "";
        const sessions = projectPath ? this.sessionManager.listDiskSessions(projectPath) : [];

        respond({
          type: "list_sessions_response",
          sessions,
        });
        break;
      }
      case "get_asset_uris":
        respond({ type: "get_asset_uris_response", uris: this.getAssetUris() });
        break;
      case "get_claude_state": {
        const stateSession = channelId ? this.sessionManager.getSession(channelId) : undefined;
        respond({
          type: "get_claude_state_response",
          config: stateSession?.claudeConfig || null,
          state: {},
        });
        break;
      }
      case "set_permission_mode": {
        const session = this.sessionManager.getSession(channelId);
        if (session) {
          session.permissionMode = request.mode;
          // Forward permission mode change to claude.exe
          this.sessionManager.sendControlRequest(session, {
            subtype: "set_permission_mode",
            mode: request.mode,
          }).then(() => {
            console.log(`[set_permission_mode] successfully set mode to ${request.mode}`);
          }).catch((err: any) => {
            console.error(`[set_permission_mode] failed to set mode on claude.exe:`, err);
          });
        }
        respond({ type: "set_permission_mode_response", success: true });
        break;
      }
      case "set_model": {
        const session = this.sessionManager.getSession(channelId);
        if (session) {
          session.model = request.model;
          // Forward model change to claude.exe
          this.sessionManager.sendControlRequest(session, {
            subtype: "set_model",
            model: request.model,
          }).then(() => {
            console.log(`[set_model] successfully set model to ${request.model}`);
          }).catch((err: any) => {
            console.error(`[set_model] failed to set model on claude.exe:`, err);
          });
        }
        respond({ type: "set_model_response", success: true });
        break;
      }
      case "open_url":
        if (request.url && /^https?:\/\//i.test(request.url)) {
          const safeUrl = request.url.replace(/[&|;`$"'\\(){}]/g, "");
          const cmd = process.platform === "win32" ? "start" : "open";
          exec(`${cmd} "${safeUrl}"`);
        }
        respond({ type: "open_url_response", success: true });
        break;
      case "log_event":
        // No-op, optionally log
        respond({ type: "log_event_response" });
        break;
      case "get_current_selection":
        respond({ type: "get_current_selection_response", selection: null });
        break;
      case "get_terminal_contents":
        respond({ type: "get_terminal_contents_response", contents: null });
        break;
      case "get_mcp_servers":
        respond({ type: "get_mcp_servers_response", servers: [] });
        break;
      case "dismiss_onboarding":
      case "dismiss_terminal_banner":
      case "dismiss_review_upsell_banner":
      case "show_notification":
      case "set_thinking_level":
      case "open_file":
      case "open_diff":
      case "open_terminal":
      case "open_output_panel":
      case "open_in_editor":
      case "open_config":
      case "open_config_file":
      case "open_folder":
      case "open_content":
      case "check_git_status":
      case "fork_conversation":
      case "list_files_request":
        respond({ type: `${request.type}_response`, success: true });
        break;
      case "list_remote_sessions":
        respond({ type: "list_remote_sessions_response", sessions: [], });
        break;
      case "get_session_request": {
        // Load session messages from disk for resume
        const sess = channelId ? this.sessionManager.getSession(channelId) : undefined;
        const projPath = sess?.projectPath || cwd || "";
        const sessionMessages = projPath && request.sessionId
          ? this.sessionManager.loadSessionMessages(projPath, request.sessionId)
          : [];
        respond({
          type: "get_session_response",
          messages: sessionMessages,
          sessionDiffs: [],
        });
        break;
      }
      case "generate_session_title":
        respond({ type: "generate_session_title_response", title: null });
        break;
      case "update_session_state":
      case "set_mcp_server_enabled":
      case "reconnect_mcp_server":
        respond({ type: `${request.type}_response`, success: true });
        break;
      default:
        respond({ type: "error", error: `Unknown request type: ${request.type}` });
    }
  }

  private handleResponse(msg: any): void {
    const { requestId, channelId, response } = msg;

    // This is the webview responding to a control_request (permission prompt)
    if (response?.type === "tool_permission_response") {
      // webview may not include channelId, so find session by requestId
      let session = channelId ? this.sessionManager.getSession(channelId) : undefined;
      if (!session) {
        session = this.sessionManager.findSessionByControlRequestId(requestId);
      }
      if (!session) {
        console.log(`[response] no session found for tool_permission_response, requestId=${requestId}`);
        return;
      }
      this.sessionManager.respondToControlRequest(session, requestId, response.result || response);
    }
  }

  private buildInitResponse(channelId?: string, cwd?: string): any {
    const config = getConfig();
    const session = channelId ? this.sessionManager.getSession(channelId) : undefined;
    return {
      type: "init_response",
      state: {
        defaultCwd: session?.projectPath || cwd || "",
        openNewInTab: false,
        showTerminalBanner: false,
        showReviewUpsellBanner: false,
        isOnboardingEnabled: false,
        isOnboardingDismissed: true,
        authStatus: { isLoggedIn: true },
        modelSetting: session?.model || config.defaults.model,
        thinkingLevel: "adaptive",
        initialPermissionMode: session?.permissionMode || config.defaults.permissionMode,
        allowDangerouslySkipPermissions: true,
        platform: process.platform,
        speechToTextEnabled: false,
        marketplaceType: "none",
        useCtrlEnterToSend: false,
        chromeMcpState: { status: "disconnected" },
        browserIntegrationSupported: false,
        debuggerMcpState: { status: "disconnected" },
        jupyterMcpState: { status: "disconnected" },
        remoteControlState: { enabled: false },
        spinnerVerbsConfig: null,
        settings: {
          permissions: {
            allow: [],
            deny: [],
            ask: [],
          },
        },
        claudeSettings: {
          effective: {
            permissions: {
              allow: [],
              deny: [],
              ask: [],
            },
          },
          permissions: {
            allow: [],
            deny: [],
            ask: [],
          },
        },
        currentRepo: null,
        experimentGates: {},
      },
    };
  }

  private getAssetUris(): Record<string, { light: string; dark: string }> {
    return {
      clawd: { light: "/resources/clawd.svg", dark: "/resources/clawd.svg" },
      "welcome-art": {
        light: "/resources/welcome-art-light.svg",
        dark: "/resources/welcome-art-dark.svg",
      },
      "clawd-with-grad-cap": {
        light: "/resources/ClawdWithGradCap.png",
        dark: "/resources/ClawdWithGradCap.png",
      },
      "onboarding-highlight-text": {
        light: "/resources/HighlightText.jpg",
        dark: "/resources/HighlightText.jpg",
      },
      "onboarding-accept-mode": {
        light: "/resources/AcceptMode.jpg",
        dark: "/resources/AcceptMode.jpg",
      },
      "onboarding-plan-mode": {
        light: "/resources/PlanMode.jpg",
        dark: "/resources/PlanMode.jpg",
      },
    };
  }
}
