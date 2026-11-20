// Local log file for support: %LOCALAPPDATA%\forma-mcp\logs\forma-mcp.log (1 MB, one rotated copy).
// Never logs prompts, answers or design data — only events, timings and errors.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const logDir = () => process.env.FORMA_MCP_LOG_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".forma-mcp"), "forma-mcp", "logs");
export const logFile = () => join(logDir(), "forma-mcp.log");
const MAX = 1024 * 1024;
const enabled = () => !!process.env.FORMA_MCP_LOG_DIR || !process.env.VITEST;
let ready = false;

export function log(level: "info" | "warn" | "error", msg: string) {
  if (!enabled()) return;
  try {
    const f = logFile();
    if (!ready) { mkdirSync(logDir(), { recursive: true }); ready = true; }
    if (existsSync(f) && statSync(f).size > MAX) renameSync(f, `${f}.1`);
    appendFileSync(f, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${process.pid}] ${msg.replace(/\s+/g, " ").slice(0, 500)}\n`);
  } catch { /* logging must never break the server */ }
}

export function tail(lines = 60): string {
  try {
    const t = readFileSync(logFile(), "utf8").trimEnd().split("\n");
    return t.slice(-lines).join("\n");
  } catch { return "(no log yet)"; }
}
