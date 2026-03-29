import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");
const CONFIG_PATH = join(PROJECT_ROOT, "config.json");

// Vendor directory containing the copied Claude Code extension
const VENDOR_EXTENSION_PATH = join(PROJECT_ROOT, "vendor/claude-code");
const VENDOR_BINARY_NAME = process.platform === "win32" ? "claude.exe" : "claude";
const VENDOR_BINARY_PATH = join(VENDOR_EXTENSION_PATH, "resources/native-binary", VENDOR_BINARY_NAME);

// If vendor binary doesn't exist or isn't executable on this platform, fall back to system claude
function resolveClaudeBinaryPath(): string {
  try {
    if (existsSync(VENDOR_BINARY_PATH)) {
      // Check if it's actually runnable (e.g. not a macOS binary on Linux)
      execSync(`"${VENDOR_BINARY_PATH}" --version`, { timeout: 5000, stdio: "ignore" });
      return VENDOR_BINARY_PATH;
    }
  } catch {
    // vendor binary not usable
  }
  // Fall back to system PATH
  try {
    const systemPath = execSync("which claude", { timeout: 5000, encoding: "utf-8" }).trim();
    if (systemPath) return systemPath;
  } catch {}
  // Last resort: hope "claude" is on PATH at runtime
  return "claude";
}

export interface Config {
  port: number;
  projects: {
    roots: string[];
    manual: string[];
    scanDepth: number;
  };
  defaults: {
    permissionMode: string;
    model: string;
  };
  // Computed from vendor directory, not stored in config.json
  readonly extensionPath: string;
  readonly claudeBinaryPath: string;
}

interface StoredConfig {
  port: number;
  projects: {
    roots: string[];
    manual: string[];
    scanDepth: number;
  };
  defaults: {
    permissionMode: string;
    model: string;
  };
}

const DEFAULT_STORED_CONFIG: StoredConfig = {
  port: 7860,
  projects: { roots: [], manual: [], scanDepth: 1 },
  defaults: { permissionMode: "bypassPermissions", model: "claude-opus-4-6[1m]" },
};

let cachedConfig: Config | null = null;

const RESOLVED_BINARY_PATH = resolveClaudeBinaryPath();

function toConfig(stored: StoredConfig): Config {
  return {
    ...stored,
    extensionPath: VENDOR_EXTENSION_PATH,
    claudeBinaryPath: RESOLVED_BINARY_PATH,
  };
}

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_STORED_CONFIG, null, 2));
    cachedConfig = toConfig(DEFAULT_STORED_CONFIG);
    return cachedConfig;
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const stored: StoredConfig = { ...DEFAULT_STORED_CONFIG, ...JSON.parse(raw) };
  cachedConfig = toConfig(stored);
  return cachedConfig;
}

export function updateConfig(partial: Partial<StoredConfig>): Config {
  const current = getConfig();
  const updatedStored: StoredConfig = {
    port: partial.port ?? current.port,
    projects: partial.projects ?? current.projects,
    defaults: partial.defaults ?? current.defaults,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(updatedStored, null, 2));
  cachedConfig = toConfig(updatedStored);
  return cachedConfig;
}
