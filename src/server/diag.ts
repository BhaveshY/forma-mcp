// One plain-text diagnostics report for support ("Copy diagnostics" in the panel, `server.js --diagnose`).
// Contains versions, connection state and the event log — no prompts, answers or design data.
import { existsSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { logFile, tail } from "./log.js";
import { installDir, sourceDir } from "./update.js";
import type { CodexStatus } from "./codex.js";

export async function diagnostics(o: { version: string; build: string; port: number; hub?: unknown; codex?: () => Promise<CodexStatus> }): Promise<string> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const cfg = join(codexHome, "config.toml");
  const cfgText = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  const startup = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "forma-mcp-hub.vbs");
  let health: unknown = "not running";
  try {
    const r = await fetch(`http://127.0.0.1:${o.port}/health`, { signal: AbortSignal.timeout(1500) });
    health = await r.json();
  } catch { /* not running */ }
  const codex = o.codex ? await o.codex().catch((e) => ({ error: String(e) })) : undefined;
  const lines = [
    `Forma MCP diagnostics · ${new Date().toISOString()}`,
    `version ${o.version} build ${o.build} · node ${process.versions.node} · ${process.platform} ${release()}`,
    `install dir: ${installDir()} · update source: ${sourceDir() ?? "none recorded"}`,
    `port ${o.port} · hub health: ${JSON.stringify(health)}`,
    o.hub ? `hub status: ${JSON.stringify(o.hub)}` : "",
    codex ? `codex: ${JSON.stringify(codex)}` : "",
    `codex config: ${existsSync(cfg) ? cfg : "missing"} · forma entry: ${/\[mcp_servers\.forma\]/.test(cfgText) ? "yes" : "NO"}`,
    `login autostart: ${existsSync(startup) ? "yes" : "no"}`,
    `log file: ${logFile()}`,
    "--- recent log ---",
    tail(80),
  ];
  return lines.filter(Boolean).join("\n");
}
