import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LinkManager, VERSION, BUILD } from "./link.js";
import { registerTools } from "./tools.js";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log as flog, logFile } from "./log.js";
import { diagnostics } from "./diag.js";
import { ExecRunner } from "./codex.js";

const PORT = Number(process.env.FORMA_MCP_PORT ?? 8081);
const log = (...a: unknown[]) => console.error("[forma-mcp]", ...a); // stdout is the MCP channel

async function mcp() {
  const link = new LinkManager(PORT);
  const server = new McpServer(
    { name: "forma", version: VERSION },
    {
      instructions:
        "Autodesk Forma (site + building design). Start with forma_status. Units: metres, m², degrees; XY are local project coords. " +
        "forma_find returns a handle r#; pass from:'r#' (or 'last' / 'selection') instead of copying paths. " +
        "Batch: one forma_create / forma_edit call holds many items/ops and is one undo step (forma_edit {undo:1}). " +
        "Paths change after move/rename; use the returned paths or 'last'. Look with forma_view {action:'capture'}. " +
        "Every error ends with fix: do exactly that; never repeat a write whose state is unknown.",
    },
  );
  registerTools(server, link);
  // Answer MCP initialize immediately; the Forma link comes up in the background.
  await server.connect(new StdioServerTransport());
  link.ensure();
  const shutdown = async () => {
    await link.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
}

/** Login autostart entry: keeps a hub worker alive, restarting it if it ever crashes. */
async function supervise() {
  const starts: number[] = [];
  const once = () => {
    const child = spawn(process.execPath, [process.argv[1], "--hub-worker"], { stdio: "ignore", windowsHide: true, env: process.env });
    child.on("exit", (code) => {
      const now = Date.now();
      starts.push(now);
      while (starts.length && now - starts[0] > 60000) starts.shift();
      const wait = starts.length >= 5 ? 60000 : 1000;
      flog("warn", `hub worker exited (code ${code}); restarting in ${wait / 1000} s`);
      setTimeout(once, wait);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  once();
}

/** Persistent hub (login autostart): keeps the Forma panel loadable before Codex runs. */
async function hub() {
  const link = new LinkManager(PORT, { persistent: true });
  for (;;) {
    try {
      if ((await link.claim()) === "hub") {
        log(`hub ${VERSION} on http://localhost:${PORT}/`);
        flog("info", `hub ${VERSION} build ${BUILD} listening on port ${PORT}`);
        return; // the open server keeps the process alive
      }
      // A Codex session owns the port. If it runs older code (Codex was open during an update),
      // ask it to hand over so the panel gets the new version; otherwise claim it when it exits.
      if (await link.requestHandover()) {
        flog("info", "an older helper handed over the port");
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
    } catch (e) {
      log((e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function selftest() {
  const [maj] = process.versions.node.split(".").map(Number);
  const out: Record<string, unknown> = { ok: true, version: VERSION, node: process.versions.node, port: PORT };
  if (maj < 20) { out.ok = false; out.error = "Node.js 20 or newer is required"; }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    const h = (await r.json()) as { app?: string; version?: string; bridges?: number; agents?: number };
    if (h.app === "forma-mcp") Object.assign(out, { hub: "running", hubVersion: h.version, formaPanels: h.bridges, codexSessions: h.agents });
    else { out.ok = false; out.hub = "port used by another program"; }
  } catch {
    out.hub = "not running (starts with Codex, or at login if autostart is installed)";
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(out.ok ? 0 : 1);
}

/** Support report: prints it and saves a copy in the temp folder. */
async function diagnose() {
  const text = await diagnostics({ version: VERSION, build: BUILD, port: PORT, codex: () => new ExecRunner({ serverPath: process.argv[1] }).check() });
  const f = join(tmpdir(), `forma-mcp-diagnostics-${Date.now()}.txt`);
  writeFileSync(f, text, "utf8");
  process.stdout.write(`${text}\n\nsaved: ${f}\nlog: ${logFile()}\n`);
}

const argv = process.argv.slice(2);
const mode = argv.includes("--version") ? "version" : argv.includes("--selftest") ? "selftest" : argv.includes("--diagnose") ? "diagnose" : argv.includes("--hub-worker") ? "worker" : argv.includes("--hub") ? "supervisor" : "mcp";
process.on("uncaughtException", (e) => {
  flog("error", `${mode} crashed: ${(e as Error)?.stack ?? e}`);
  log("fatal:", (e as Error)?.stack ?? e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => flog("error", `${mode} unhandled rejection: ${(e as Error)?.stack ?? e}`));
const main = argv.includes("--version") ? async () => { process.stdout.write(`${VERSION}${argv.includes("--build") ? ` ${BUILD}` : ""}\n`); }
  : mode === "selftest" ? selftest
  : mode === "diagnose" ? diagnose
  : mode === "worker" ? hub
  : mode === "supervisor" ? supervise
  : mcp;

main().catch((e) => {
  log("fatal:", (e as Error)?.stack ?? e);
  process.exit(1);
});
