import { ChildProcess, spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { getConfig } from "./config.js";

export interface ClaudeProcessOptions {
  cwd: string;
  model?: string;
  permissionMode?: string;
  resume?: string;
  thinkingLevel?: string;
}

export class ClaudeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _exited = false;

  get exited(): boolean {
    return this._exited;
  }

  spawn(options: ClaudeProcessOptions): void {
    const config = getConfig();
    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--allow-dangerously-skip-permissions",
      "--permission-prompt-tool", "stdio",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    }
    if (options.resume) {
      args.push("--resume", options.resume);
    }
    if (options.thinkingLevel) {
      args.push("--thinking", options.thinkingLevel);
    }

    this.process = spawn(config.claudeBinaryPath, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    // Parse stdout as newline-delimited JSON
    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        this.emit("message", msg);
      } catch {
        // Non-JSON output, emit as raw
        this.emit("stderr", line);
      }
    });

    // Capture stderr
    const stderrRl = createInterface({ input: this.process.stderr! });
    stderrRl.on("line", (line: string) => {
      this.emit("stderr", line);
    });

    this.process.on("exit", (code, signal) => {
      this._exited = true;
      this.emit("exit", code, signal);
    });

    this.process.on("error", (err) => {
      this._exited = true;
      this.emit("error", err);
    });
  }

  writeStdin(message: object): void {
    if (!this.process || this._exited) return;
    const line = JSON.stringify(message) + "\n";
    this.process.stdin!.write(line);
  }

  interrupt(): void {
    if (!this.process || this._exited) return;
    // Send a control_request with subtype "interrupt" via stdin (same as VSCode extension)
    this.writeStdin({
      type: "control_request",
      request_id: uuid(),
      request: { subtype: "interrupt" },
    });
  }

  kill(): void {
    if (!this.process || this._exited) return;
    this.process.kill();
    this._exited = true;
  }
}
