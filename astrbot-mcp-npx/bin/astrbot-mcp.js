#!/usr/bin/env node
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function looksLikeProjectRoot(dir) {
  try {
    return (
      fs.existsSync(resolve(dir, "pyproject.toml")) &&
      fs.existsSync(resolve(dir, "astrbot_mcp"))
    );
  } catch {
    return false;
  }
}

function findProjectRoot(startDir) {
  let current = resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (looksLikeProjectRoot(current)) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// When executed via `npx`, this script may run from a temp install directory.
// Prefer an explicit env var, otherwise infer from process.cwd().
const projectRoot =
  (process.env.ASTRBOT_MCP_PROJECT_ROOT &&
    resolve(process.env.ASTRBOT_MCP_PROJECT_ROOT)) ||
  findProjectRoot(process.cwd()) ||
  process.cwd();

const spawnOptions = {
  cwd: projectRoot,
  env: {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    FASTMCP_LOG_ENABLED: "false",
    FASTMCP_LOG_LEVEL: "ERROR",
    FASTMCP_SHOW_CLI_BANNER: "false"
  },
  stdio: "inherit",
  shell: process.platform === "win32"
};

function spawnPythonViaUv() {
  return spawn(
    "uv",
    [
      "run",
      "--project",
      projectRoot,
      "-q",
      "--no-progress",
      "--color",
      "never",
      "python",
      "-m",
      "astrbot_mcp.server"
    ],
    spawnOptions
  );
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.ASTRBOT_MCP_PYTHON) {
    candidates.push({ command: process.env.ASTRBOT_MCP_PYTHON, args: ["-m", "astrbot_mcp.server"] });
  }
  const venvPython = resolve(projectRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) {
    candidates.push({ command: venvPython, args: ["-m", "astrbot_mcp.server"] });
  }
  candidates.push({ command: "python", args: ["-m", "astrbot_mcp.server"] });
  candidates.push({ command: "py", args: ["-3", "-m", "astrbot_mcp.server"] });
  return candidates;
}

function spawnPythonDirectly() {
  const candidate = pythonCandidates()[0];
  return spawn(candidate.command, candidate.args, spawnOptions);
}

function spawnPythonDirectlyWithFallback(fromIndex = 0) {
  const candidates = pythonCandidates();
  const candidate = candidates[fromIndex];
  if (!candidate) return null;
  const proc = spawn(candidate.command, candidate.args, spawnOptions);
  proc.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      const next = spawnPythonDirectlyWithFallback(fromIndex + 1);
      if (next) {
        child = next;
        child.on("exit", (code) => process.exit(code ?? 1));
      } else {
        console.error("[npx-wrapper] Failed to find a usable Python interpreter.");
        process.exit(1);
      }
      return;
    }
    console.error(`[npx-wrapper] Failed to spawn python: ${err.message}`);
    process.exit(1);
  });
  return proc;
}

// Prefer uv (reproducible env), but fall back to plain python if uv isn't on PATH.
let child = spawnPythonViaUv();
child.on("error", (err) => {
  if (err && err.code === "ENOENT") {
    child = spawnPythonDirectlyWithFallback(0);
    if (!child) {
      console.error("[npx-wrapper] Failed to find a usable Python interpreter.");
      process.exit(1);
    }
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  console.error(`[npx-wrapper] Failed to spawn process: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
