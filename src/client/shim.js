// Shim layer: replaces VSCode's acquireVsCodeApi with WebSocket bridge
(function () {
  "use strict";

  // Polyfill crypto.randomUUID for non-HTTPS localhost
  if (!crypto.randomUUID) {
    crypto.randomUUID = function() {
      return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
    };
  }

  var config = window.WEB_CC_CONFIG || {};
  var wsUrl = config.wsUrl || "ws://" + location.host + "/ws";

  // Extract session parameter from URL for resume
  var urlParams = new URLSearchParams(window.location.search);
  var sessionId = urlParams.get('session');

  var ws = null;
  var wsReady = false;
  var pendingMessages = [];

  // channelId mapping: on reconnect the webview generates a new channelId,
  // but the server session still uses the original one. The server sends a
  // channel_remap message to tell us the mapping, and we translate both ways.
  var channelIdMap = {}; // webviewId -> serverId
  var reverseMap = {};   // serverId -> webviewId

  function toServerId(id) {
    return channelIdMap[id] || id;
  }

  function toWebviewId(id) {
    return reverseMap[id] || id;
  }

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      wsReady = true;
      console.log("[shim] WebSocket connected");
      while (pendingMessages.length > 0) {
        ws.send(pendingMessages.shift());
      }
    };

    ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);

        // Handle server's channelId remap instruction
        if (data.type === "channel_remap") {
          // Only one mapping is active at a time per page
          channelIdMap = {};
          reverseMap = {};
          channelIdMap[data.webviewChannelId] = data.serverChannelId;
          reverseMap[data.serverChannelId] = data.webviewChannelId;
          console.log("[shim] channel remap:", data.webviewChannelId, "->", data.serverChannelId);
          return;
        }

        // Remap server channelId back to webview's current channelId
        if (data.message && data.message.channelId) {
          data.message.channelId = toWebviewId(data.message.channelId);
        }

        window.dispatchEvent(new MessageEvent("message", { data: data }));
      } catch (err) {
        console.error("[shim] Failed to parse WS message:", err);
      }
    };

    ws.onclose = function () {
      wsReady = false;
      console.log("[shim] WebSocket disconnected, reconnecting in 2s...");
      setTimeout(connect, 2000);
    };

    ws.onerror = function (err) {
      console.error("[shim] WebSocket error:", err);
    };
  }

  function sendMessage(msg) {
    if (config.projectPath && !msg.cwd) {
      msg.cwd = config.projectPath;
    }

    // Add resume parameter for launch_claude if session exists in URL
    if (msg.type === 'launch_claude') {
      if (sessionId && !msg.resume) {
        msg.resume = sessionId;
      }
      // Override permissionMode from server config (default: bypassPermissions)
      msg.permissionMode = config.permissionMode || 'bypassPermissions';
    }

    // Remap outbound channelId to server-side value
    if (msg.channelId) {
      msg.channelId = toServerId(msg.channelId);
    }

    var data = JSON.stringify(msg);
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      pendingMessages.push(data);
    }
  }

  var VSCODE_STATE_KEY = "web-cc-vscode-state";

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        sendMessage(msg);
      },
      getState: function () {
        try {
          var raw = localStorage.getItem(VSCODE_STATE_KEY);
          return raw ? JSON.parse(raw) : undefined;
        } catch (e) {
          return undefined;
        }
      },
      setState: function (state) {
        try {
          localStorage.setItem(VSCODE_STATE_KEY, JSON.stringify(state));
        } catch (e) {}
        return state;
      },
    };
  };

  window.IS_SIDEBAR = false;
  window.IS_FULL_EDITOR = true;
  window.IS_SESSION_LIST_ONLY = false;

  connect();
})();
