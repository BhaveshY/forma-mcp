// Production hardening: local-hub security, task resume after a panel reload, hung-run limit,
// update check, log file, diagnostics and saved reports.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Hub } from "../src/server/link.js";
import type { CodexRunner, RunOptions } from "../src/server/codex.js";
import { checkUpdate } from "../src/server/update.js";
import { log, tail, logFile } from "../src/server/log.js";
import { diagnostics } from "../src/server/diag.js";
import { saveReport, toCsv, toHtml } from "../src/server/report.js";

process.env.FORMA_MCP_HOME = mkdtempSync(join(tmpdir(), "fmcp-hard-"));
let port = 26000 + Math.floor(Math.random() * 2000);
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); port += 5; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake Codex: a run emits one step and then waits until cancelled (or `finish` is called). */
function fakeRunner() {
  const runs: { opts: RunOptions; finish: () => void; cancelled: boolean }[] = [];
  const r: CodexRunner = {
    check: async () => ({ installed: true, loggedIn: true, text: "ok" }),
    start(opts) {
      let end!: () => void;
      const done = new Promise<void>((res) => (end = res));
      const run = { opts, cancelled: false, finish: () => { opts.onEvent({ kind: "done", text: "Finished." }); end(); } };
      runs.push(run);
      setTimeout(() => opts.onEvent({ kind: "step", text: "Placing 1 building…" }), 5);
      return { done, cancel: () => { run.cancelled = true; opts.onEvent({ kind: "cancelled", text: "Stopped." }); end(); } };
    },
  };
  return { r, runs };
}

async function startHub(o: ConstructorParameters<typeof Hub>[1] = {}) {
  const h = new Hub(port, o);
  await h.listen();
  cleanup.push(() => h.close());
  return h;
}

function panel(p = port, tabId = "tabA") {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws/bridge`, { origin: `http://localhost:${p}`, headers: { host: `localhost:${p}` } });
  const msgs: any[] = [];
  ws.on("message", (m) => msgs.push(JSON.parse(String(m))));
  const ready = new Promise<void>((res) => ws.once("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 2, info: { projectId: "p", tabId } })); res(); }));
  cleanup.push(() => ws.terminate());
  return { ws, msgs, ready, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
async function until(fn: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !fn(); t += 20) await sleep(20);
  expect(fn()).toBe(true);
}

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, any> }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}`, ...headers } }, (x) => { x.resume(); res({ status: x.statusCode!, headers: x.headers }); });
    r.on("error", rej);
    r.end();
  });
}

describe("local hub security", () => {
  it("refuses requests addressed to another host name (DNS rebinding)", async () => {
    await startHub();
    expect((await get("/health")).status).toBe(200);
    expect((await get("/health", { host: `evil.example:${port}` })).status).toBe(403);
    expect((await get("/", { host: `evil.example:${port}` })).status).toBe(403);
  });

  it("only Forma may embed the panel page; no MIME sniffing", async () => {
    await startHub();
    const r = await get("/");
    expect(r.headers["content-security-policy"]).toMatch(/^frame-ancestors 'self' https:\/\/\*\.autodeskforma\.eu https:\/\/\*\.autodeskforma\.com/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses panel connections from other websites", async () => {
    await startHub();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge`, { origin: "https://evil.example", headers: { host: `localhost:${port}` } });
    const outcome = await new Promise((res) => { ws.once("open", () => res("open")); ws.once("error", () => res("refused")); });
    expect(outcome).toBe("refused");
  });

  it("refuses an empty or oversized request without starting Codex", async () => {
    const { r, runs } = fakeRunner();
    await startHub({ runner: r });
    const p = panel();
    await p.ready;
    p.send({ t: "ai.run", runId: "big", prompt: "x".repeat(20001) });
    p.send({ t: "ai.run", runId: "empty", prompt: "   " });
    await until(() => p.msgs.filter((m) => m.t === "ai.event" && m.ev.kind === "error").length === 2);
    expect(runs).toHaveLength(0);
  });
});

describe("panel reload during a task", () => {
  it("a reloaded panel is told about the running task (with its steps) and can stop it", async () => {
    const { r, runs } = fakeRunner();
    await startHub({ runner: r });
    const a = panel(port, "tabA");
    await a.ready;
    a.send({ t: "ai.run", runId: "run1", prompt: "Add a block", title: "Add a block" });
    await until(() => a.msgs.some((m) => m.t === "ai.event" && m.ev.kind === "step"));
    a.ws.terminate(); // Forma reloads the panel (e.g. design option switch)
    const b = panel(port, "tabA");
    await b.ready;
    await until(() => b.msgs.some((m) => m.t === "ai.active"));
    const act = b.msgs.find((m) => m.t === "ai.active");
    expect(act).toMatchObject({ runId: "run1", prompt: "Add a block", tab: "tabA" });
    expect(act.steps).toContain("Placing 1 building…");
    b.send({ t: "ai.cancel", runId: "run1" });
    await until(() => b.msgs.some((m) => m.t === "ai.event" && m.ev.kind === "cancelled"));
    expect(runs[0].cancelled).toBe(true);
    // finished: a new panel is no longer told about it
    const c = panel(port, "tabA");
    await c.ready;
    await sleep(100);
    expect(c.msgs.some((m) => m.t === "ai.active")).toBe(false);
  });

  it("a hung Codex run is stopped after the time limit", async () => {
    const { r, runs } = fakeRunner();
    await startHub({ runner: r, runTimeoutMs: 150 });
    const p = panel();
    await p.ready;
    p.send({ t: "ai.run", runId: "hang", prompt: "x" });
    await until(() => p.msgs.some((m) => m.t === "ai.event" && m.ev.kind === "cancelled"));
    expect(runs[0].cancelled).toBe(true);
    expect(p.msgs.some((m) => m.t === "ai.event" && /too long/.test(m.ev.text))).toBe(true);
  });
});

describe("updates", () => {
  const setup = (srcBuild: string) => {
    const root = mkdtempSync(join(tmpdir(), "fmcp-upd-"));
    const inst = join(root, "installed"), src = join(root, "share");
    mkdirSync(inst); mkdirSync(src);
    writeFileSync(join(src, "version.json"), JSON.stringify({ version: "0.2.0", build: srcBuild }));
    writeFileSync(join(src, "install.ps1"), "");
    writeFileSync(join(inst, "source.json"), JSON.stringify({ dir: src }));
    return inst;
  };
  it("offers a newer build from the folder it was installed from, not an older or equal one", () => {
    const mine = (Date.now() - 1000).toString(36);
    expect(checkUpdate(mine, setup(Date.now().toString(36)))).toMatchObject({ version: "0.2.0" });
    expect(checkUpdate(mine, setup(mine))).toBeUndefined();
    expect(checkUpdate(mine, setup((Date.now() - 99999).toString(36)))).toBeUndefined();
    expect(checkUpdate(mine, mkdtempSync(join(tmpdir(), "fmcp-none-")))).toBeUndefined();
  });
  it("the hub tells connected panels, and development builds never update", async () => {
    const inst = setup(Date.now().toString(36));
    expect(checkUpdate("dev", inst)).toBeUndefined();
    await startHub({ updateDir: inst, build: (Date.now() - 5000).toString(36) });
    const p = panel();
    await p.ready;
    await until(() => p.msgs.some((m) => m.t === "update"));
    expect(p.msgs.find((m) => m.t === "update")).toMatchObject({ version: "0.2.0" });
  });
});

describe("log file and diagnostics", () => {
  it("writes events to a rotating log and includes them in diagnostics (no prompts)", async () => {
    process.env.FORMA_MCP_LOG_DIR = mkdtempSync(join(tmpdir(), "fmcp-log-"));
    log("info", "task t1 started (new, 42 chars, tab x)");
    expect(existsSync(logFile())).toBe(true);
    expect(tail()).toMatch(/INFO .*task t1 started/);
    const d = await diagnostics({ version: "0.1.0", build: "abc", port, codex: async () => ({ installed: true, loggedIn: true, text: "Codex is ready." }) });
    expect(d).toMatch(/version 0.1.0 build abc/);
    expect(d).toMatch(/task t1 started/);
    expect(d).toMatch(/"loggedIn":true/);
    delete process.env.FORMA_MCP_LOG_DIR;
  });
});

describe("design report", () => {
  const r = {
    project: "Demo <Site>", design_option: "Option 1",
    totals: { gfa_m2: 13331, site_area_m2: 4343, far: 3.07, coverage: "47%", gfa_by_function: { Residential: 10000, Office: 3331 } },
    buildings: [{ name: "=HYPERLINK(\"x\")", use: "Residential", floors: 11, height_m: 33, footprint_m2: 420.5, gfa_m2: 4625.5 }, { name: "Block; B", use: "Office", floors: 4, height_m: 14, footprint_m2: 300, gfa_m2: 1200 }],
    rules: { maxHeight: 30 },
    check: { ok: false, checked: ["maxHeight"], skipped: [], violations: [{ text: "Tower is 33 m tall (limit 30 m)" }] },
  };
  it("CSV opens in Excel safely: BOM, ; separator, formulas neutralised, quoting", () => {
    const csv = toCsv(r);
    expect(csv.startsWith("﻿Building;Use;Uses;Floors")).toBe(true);
    expect(csv).toContain(`'=HYPERLINK(""x"")`);
    expect(csv).toContain(`"Block; B"`);
  });
  it("HTML escapes names and shows the rule problems", () => {
    const html = toHtml(r, new Date("2026-11-15T10:00:00Z"));
    expect(html).toContain("Demo &lt;Site&gt;");
    expect(html).not.toContain("<Site>");
    expect(html).toContain("Tower is 33 m tall (limit 30 m)");
    expect(html).toContain("13,331 m²");
  });
  it("saves both files with a readable name", () => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-rep-"));
    const f = saveReport(r, dir, new Date("2026-11-15T10:00:00Z"));
    expect(f.html).toMatch(/Demo-Site-Option-1-2026-11-15-10-00-00\.html$/);
    expect(readFileSync(f.csv, "utf8")).toContain("Block; B");
  });
});

describe("update while Codex is open", () => {
  it("a newer background helper takes the port from an older Codex-owned one; old sessions keep working", async () => {
    const { LinkManager, isNewerBuild } = await import("../src/server/link.js");
    const oldB = (Date.now() - 60000).toString(36), newB = Date.now().toString(36);
    expect(isNewerBuild(newB, oldB)).toBe(true);
    expect(isNewerBuild(oldB, newB)).toBe(false);
    expect(isNewerBuild("dev", oldB)).toBe(false);

    const codexA = new LinkManager(port, { build: oldB });
    const codexB = new LinkManager(port, { build: oldB });
    cleanup.push(() => codexA.close(), () => codexB.close());
    expect(await codexA.claim().catch(() => "x")).toBe("hub"); // claim() keeps a hub
    expect((await codexB.status()).role).toBe("relay");

    const bg = new LinkManager(port, { persistent: true, build: newB });
    cleanup.push(() => bg.close());
    expect(await bg.claim()).toBe("relay"); // port taken by the older Codex-owned hub
    expect(await bg.requestHandover()).toBe(true);
    let role = "relay";
    for (let i = 0; i < 40 && role !== "hub"; i++) { await sleep(100); role = await bg.claim().catch(() => "relay"); }
    expect(role).toBe("hub");
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(h).toMatchObject({ build: newB, persistent: true });

    // both old sessions reconnect as relays to the new helper instead of grabbing the port back
    for (const m of [codexA, codexB]) {
      let st: any;
      for (let i = 0; i < 60 && st?.role !== "relay"; i++) { await sleep(100); st = await m.status().catch(() => undefined); }
      expect(st?.role).toBe("relay");
    }
    // a newer hub never hands over to an older one
    const older = new LinkManager(port, { build: oldB });
    cleanup.push(() => older.close());
    expect(await older.requestHandover()).toBe(false);
  }, 20000);
});
