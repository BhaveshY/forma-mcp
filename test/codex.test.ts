// Codex runner: real recorded JSONL replayed by a fake `codex`, plus panel wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { WebSocket } from "ws";
import { ExecRunner, mapEvent, resolveCodex, SIGN_IN_FIX, type AiEvent } from "../src/server/codex.js";
import { Hub } from "../src/server/link.js";
import { DIRECT, PanelController, type AiLike } from "../src/bridge/controller.js";
import { PRESETS, fillPreset } from "../src/bridge/presets.js";
import { log } from "../src/server/log.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("../src/server/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/log.js")>();
  return { ...actual, log: vi.fn(actual.log) };
});

const FIX = join(__dirname, "fixtures");
const fake = JSON.stringify([process.execPath, join(__dirname, "fake-codex.mjs")]);
let dir: string;
let logFile: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fmcp-codex-"));
  logFile = join(dir, "calls.jsonl");
  Object.assign(process.env, { FORMA_MCP_CODEX: fake, FAKE_CODEX_LOG: logFile, FAKE_CODEX_SCENARIO: "codex-success", FAKE_CODEX_LOGIN: "in" });
});
afterEach(() => { process.env = { ...saved }; });

const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const runner = () => new ExecRunner({ serverPath: "C:/forma-mcp/server.js", nodePath: "node", workDir: dir });
function collect(r: ExecRunner, opts: { prompt: string; threadId?: string; env?: Record<string, string> }) {
  const ev: AiEvent[] = [];
  const h = r.start({ ...opts, onEvent: (e) => ev.push(e) });
  return { ev, h, done: h.done.then(() => ev) };
}

it.each([["codex-auth-expired", 1], ["codex-success", 0]])("exits correctly after live-ai receives %s", (scenario, code) => {
  mkdirSync(join(dir, "src/server"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const file of ["src/server/log", "src/server/codex", "scripts/live-ai"]) {
    const source = readFileSync(join(__dirname, "..", file + ".ts"), "utf8");
    writeFileSync(join(dir, file + ".js"), transformSync(source, { loader: "ts" }).code);
  }
  const run = spawnSync(process.execPath, [join(dir, "scripts/live-ai.js")], { encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: dir, FORMA_MCP_SERVER_PATH: join(dir, "unused-server.js"), FAKE_CODEX_SCENARIO: scenario } });
  expect(run.stdout).toContain(code ? "error: Codex is signed out." : "done:");
  expect(run.status).toBe(code);
});

describe("event mapping (real recordings)", () => {
  const replay = (name: string) => {
    const st = {};
    return readFileSync(join(FIX, `${name}.jsonl`), "utf8").trim().split("\n").flatMap((l) => mapEvent(JSON.parse(l), st));
  };
  it("success: plain-language steps, the assistant's words, final summary + thread id", () => {
    const ev = replay("codex-success");
    expect(ev.filter((e) => e.kind === "step").map((e) => e.text)).toEqual(["Looking at the project…", "Calculating areas and FAR…"]);
    expect(ev.at(-1)).toMatchObject({ kind: "done", text: "The FAR is 0.4." });
    expect(ev.at(-1)!.kind === "done" && (ev.at(-1) as any).threadId).toBeTruthy();
  });
  it("expired login becomes a plain sign-in fix", () => {
    expect(replay("codex-auth-expired")).toEqual([expect.objectContaining({ kind: "error", text: "Codex is signed out.", fix: SIGN_IN_FIX })]);
  });
  it("tool failures are explained without jargon", () => {
    const ev = replay("codex-forma-disconnected");
    expect(ev.some((e) => e.text === "Forma was not connected for a moment.")).toBe(true);
    expect(ev.at(-1)!.kind).toBe("done");
  });
});

describe("ExecRunner with a fake codex executable", () => {
  it("runs one turn: lean isolated config, prompt on stdin, streams events", async () => {
    const { done } = collect(runner(), { prompt: "What is the FAR?", env: { FORMA_MCP_PORT: "8081", FORMA_MCP_APPROVAL: "panel" } });
    const ev = await done;
    expect(ev[0]).toEqual({ kind: "step", text: "Starting the assistant…" });
    expect(ev.at(-1)).toMatchObject({ kind: "done", text: "The FAR is 0.4." });
    const [c] = calls();
    expect(c.stdin).toBe("What is the FAR?");
    expect(c.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(c.argv).toContain("--ignore-user-config"); // only forma loads: fast + few tokens
    expect(c.argv).toContain('mcp_servers.forma.default_tools_approval_mode="approve"');
    expect(c.argv).toContain('mcp_servers.forma.disabled_tools=["forma_script"]');
    // panel runs: gpt-6.1-sol, medium reasoning, Fast (priority) tier
    expect(c.argv).toEqual(expect.arrayContaining(['model="gpt-6.1-sol"', 'model_reasoning_effort="medium"', 'service_tier="priority"']));
    expect(c.argv).toContain('mcp_servers.forma.env={FORMA_MCP_PORT="8081",FORMA_MCP_APPROVAL="panel"}');
    expect(c.argv).toContain('mcp_servers.forma.args=["C:/forma-mcp/server.js"]');
    expect(c.argv.slice(-3)).toEqual(["-s", "read-only", "-"]);
  });

  it("follow-up turns resume the same conversation", async () => {
    await collect(runner(), { prompt: "and now?", threadId: "01a1-thread" }).done;
    const [c] = calls();
    expect(c.argv.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(c.argv.slice(-2)).toEqual(["01a1-thread", "-"]);
    expect(c.stdin).toBe("and now?");
  });

  it("signed-out Codex: run ends with the sign-in fix", async () => {
    process.env.FAKE_CODEX_SCENARIO = "codex-auth-expired";
    const ev = await collect(runner(), { prompt: "x" }).done;
    expect(ev.at(-1)).toMatchObject({ kind: "error", fix: SIGN_IN_FIX });
  });

  it("Stop kills the Codex process and reports 'Stopped.'", async () => {
    process.env.FAKE_CODEX_SCENARIO = "slow";
    const { ev, h, done } = collect(runner(), { prompt: "x" });
    for (let i = 0; i < 100 && !ev.some((e) => e.text === "Placing 3 buildings…"); i++) await new Promise((r) => setTimeout(r, 30));
    expect(ev.map((e) => e.text)).toContain("Placing 3 buildings…");
    h.cancel();
    await done;
    expect(ev.at(-1)).toEqual({ kind: "cancelled", text: "Stopped." });
    const pid = calls()[0].pid;
    expect(() => process.kill(pid, 0)).toThrow(); // process is gone
  }, 15000);

  it.runIf(process.platform === "win32")("falls back to stopping Codex directly when taskkill fails", async () => {
    process.env.FAKE_CODEX_SCENARIO = "slow";
    const { h, done } = collect(runner(), { prompt: "x" });
    vi.mocked(spawnSync).mockReturnValueOnce({ pid: 0, output: [], stdout: "", stderr: "Access denied", status: 1, signal: null });
    h.cancel();
    expect((await done).at(-1)).toEqual({ kind: "cancelled", text: "Stopped." });
    expect(log).toHaveBeenCalledWith("warn", expect.stringMatching(/taskkill failed .*exit code 1/));
  }, 7000);

  it("finishes cancellation if the child never closes", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new ChildProcess(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      const kill = vi.spyOn(child, "kill").mockReturnValue(false);
      vi.mocked(spawn).mockReturnValueOnce(child);
      const { h, done } = collect(runner(), { prompt: "x" });
      h.cancel();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await done).at(-1)).toMatchObject({
        kind: "error", text: "Forma MCP could not confirm that Codex stopped.", fix: expect.stringContaining("Check your Forma project"),
      });
      expect(kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("check(): ready / signed out / not installed", async () => {
    expect(await runner().check()).toMatchObject({ installed: true, loggedIn: true, version: "codex-cli 0.167.1" });
    process.env.FAKE_CODEX_LOGIN = "out";
    expect(await runner().check()).toMatchObject({ installed: true, loggedIn: false, text: "Codex is signed out.", fix: SIGN_IN_FIX });
    process.env.FORMA_MCP_CODEX = join(dir, "missing-codex.exe");
    const r = new ExecRunner({ serverPath: "x" });
    const s = await r.check();
    expect(s.installed).toBe(false);
    expect(s.fix).toMatch(/INSTALL\.md/);
  });

  it.each(["Error finding codex home: profile missing", "Could not find home directory"])("check() explains the home-folder error %s", async (diagnostic) => {
    process.env.FAKE_CODEX_HOME_ERROR = diagnostic;
    expect(await runner().check()).toMatchObject({
      installed: true, loggedIn: false,
      text: `Codex can't find its home folder.\n${diagnostic}`,
      fix: expect.stringMatching(/USERPROFILE.*CODEX_HOME.*existing folder/),
    });
  });

  it("finds codex on PATH when no override is set", () => {
    delete process.env.FORMA_MCP_CODEX;
    const c = resolveCodex();
    if (c) expect(c.cmd).toMatch(/codex/i); // present on this machine; skipped elsewhere
  });
});

describe("hub ⇄ panel assistant messages", () => {
  it("ai.check and ai.run stream through the hub to the panel", async () => {
    const port = 26000 + Math.floor(Math.random() * 2000);
    process.env.FORMA_MCP_HOME = dir;
    const hub = new Hub(port, { runner: runner() });
    await hub.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge`, { origin: `http://localhost:${port}` });
    const got: any[] = [];
    await new Promise((r) => ws.on("open", r));
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    ws.send(JSON.stringify({ t: "hello", protocol: 2, info: { projectId: "p" } }));
    ws.send(JSON.stringify({ t: "ai.check", id: "c1" }));
    ws.send(JSON.stringify({ t: "ai.run", runId: "r1", prompt: "What is the FAR?" }));
    for (let i = 0; i < 200 && !got.some((m) => m.t === "ai.event" && m.ev.kind === "done"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(got.find((m) => m.t === "ai.status")?.status).toMatchObject({ loggedIn: true });
    const evs = got.filter((m) => m.t === "ai.event" && m.runId === "r1").map((m) => m.ev);
    expect(evs.at(-1)).toMatchObject({ kind: "done", text: "The FAR is 0.4." });
    const c = calls()[0];
    expect(c.stdin).toMatch(/Use ONLY the forma tools/); // wrapped prompt
    expect(c.stdin).toMatch(/inventory scope through to create.*default metrics inventory unless the user explicitly asks/);
    expect(c.stdin).toMatch(/buildings listed as not counted.*labelled sensitivity check/);
    expect(c.argv.join(" ")).toMatch(new RegExp(`FORMA_MCP_PORT="${port}",FORMA_MCP_APPROVAL="panel"`));
    ws.close();
    await hub.close();
  }, 15000);
});

describe("panel controller", () => {
  it("panel reads and undo never involve Codex", async () => {
    const used: string[] = [];
    const ops = { run: async (op: string, a: any = {}) => { used.push(`${op}:${a.steps ?? ""}`); return {}; } };
    let aiCalls = 0;
    const ai: AiLike = { check: async () => { aiCalls++; return { installed: true, loggedIn: true, text: "" }; }, run: () => { aiCalls++; return { cancel() {} }; } };
    const ctrl = new PanelController(ops, ai);
    for (const name of Object.keys(DIRECT) as (keyof typeof DIRECT)[]) await ctrl.direct(name, { steps: 2 });
    expect(aiCalls).toBe(0);
    expect(used).toEqual(["metrics:", "status:", "undo:2"]);
  });

  it("assistant: follow-ups reuse the thread; new conversation resets it", async () => {
    const seen: (string | undefined)[] = [];
    const ai: AiLike = { check: async () => ({ installed: true, loggedIn: true, text: "" }), run: (_p, tid, on) => { seen.push(tid); setTimeout(() => on({ kind: "done", text: "ok", threadId: "T1" })); return { cancel() {} }; } };
    const ctrl = new PanelController({ run: async () => ({}) }, ai);
    const ask = () => new Promise<void>((r) => ctrl.ask("hi", (e) => e.kind === "done" && r()));
    await ask(); await ask();
    ctrl.newConversation(); await ask();
    expect(seen).toEqual([undefined, "T1", undefined]);
  });

  it("presets fill every placeholder", () => {
    for (const p of PRESETS) {
      const text = fillPreset(p, {});
      expect(text, p.id).not.toMatch(/\{\w+\}/);
      for (const f of p.fields) expect(text, `${p.id}.${f.id}`).toContain(String(f.default));
    }
  });
});
