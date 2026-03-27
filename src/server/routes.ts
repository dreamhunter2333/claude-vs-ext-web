import { Router, Request, Response } from "express";
import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from "fs";
import { join, basename, normalize } from "path";
import { homedir } from "os";
import { getConfig, updateConfig } from "./config.js";

export function createRoutes(): Router {
  const router = Router();

  router.get("/api/projects", (_req: Request, res: Response) => {
    const config = getConfig();
    const projects = discoverProjects(config);
    res.json(projects);
  });

  router.post("/api/projects", (req: Request, res: Response) => {
    const { path } = req.body;
    if (!path || !existsSync(path)) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    const config = getConfig();
    if (!config.projects.manual.includes(path)) {
      config.projects.manual.push(path);
      updateConfig({ projects: config.projects });
    }
    res.json({ success: true });
  });

  router.get("/api/config", (_req: Request, res: Response) => {
    res.json(getConfig());
  });

  router.put("/api/config", (req: Request, res: Response) => {
    const updated = updateConfig(req.body);
    res.json(updated);
  });

  return router;
}

interface ProjectInfo {
  name: string;
  path: string;
  hasGit: boolean;
  hasClaude: boolean;
  sessionCount: number;
  lastModified: number;
}

function discoverProjects(config: { projects: { manual: string[]; roots: string[]; scanDepth: number } }): ProjectInfo[] {
  const seen = new Set<string>();
  const projects: ProjectInfo[] = [];

  // 1. Scan from claude session history (~/.claude/projects/)
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (existsSync(claudeProjectsDir)) {
    try {
      const dirs = readdirSync(claudeProjectsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dirPath = join(claudeProjectsDir, d.name);
        const { cwd, sessionCount, lastModified } = extractProjectInfo(dirPath);
        if (cwd && !seen.has(cwd)) {
          seen.add(cwd);
          projects.push({
            name: basename(cwd),
            path: cwd,
            hasGit: existsSync(join(cwd, ".git")),
            hasClaude: existsSync(join(cwd, "CLAUDE.md")) || existsSync(join(cwd, ".claude")),
            sessionCount,
            lastModified,
          });
        }
      }
    } catch {
      // Skip if inaccessible
    }
  }

  // 2. Add manual projects from config
  for (const p of config.projects.manual) {
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      projects.push({
        name: basename(p),
        path: p,
        hasGit: existsSync(join(p, ".git")),
        hasClaude: existsSync(join(p, "CLAUDE.md")) || existsSync(join(p, ".claude")),
        sessionCount: 0,
        lastModified: 0,
      });
    }
  }

  // Sort by lastModified descending (most recent first), then by name
  return projects.sort((a, b) => {
    if (b.lastModified !== a.lastModified) return b.lastModified - a.lastModified;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Extract project path (cwd) and session count from a claude project directory.
 * Reads the first JSONL file to find the cwd field.
 */
function extractProjectInfo(projectDir: string): { cwd: string | null; sessionCount: number; lastModified: number } {
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return { cwd: null, sessionCount: 0, lastModified: 0 };

    let cwd: string | null = null;
    let lastModified = 0;

    for (const file of files) {
      const filePath = join(projectDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtime.getTime() > lastModified) {
          lastModified = stat.mtime.getTime();
        }
        // Extract cwd from first file if not yet found
        if (!cwd) {
          cwd = extractCwdFromJsonl(filePath, stat.size);
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { cwd: cwd ? normalize(cwd) : null, sessionCount: files.length, lastModified };
  } catch {
    return { cwd: null, sessionCount: 0, lastModified: 0 };
  }
}

/**
 * Read the head of a JSONL file to extract the cwd field.
 */
function extractCwdFromJsonl(filePath: string, fileSize: number): string | null {
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
          if (obj.cwd) return obj.cwd;
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
