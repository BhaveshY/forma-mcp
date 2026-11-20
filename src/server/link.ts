// Connection layer.
//
// Exactly one process owns 127.0.0.1:PORT: the hub. It serves the bridge page and holds
// the WebSocket(s) to Forma. Every other forma-mcp process (one per Codex session)
// attaches to the hub as a relay. If the hub exits, relays race to take over; the
// bridge reconnects to whoever wins. Request ids are created where a call originates
// and stay stable across resends, so the bridge can deduplicate writes.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ExecRunner, wrapPrompt, type CodexRunner, type RunHandle } from "./codex.js";
import { log } from "./log.js";
import { diagnostics } from "./diag.js";
import { checkUpdate, runUpdate, type UpdateInfo } from "./update.js";
import { APP, PROTOCOL, FormaError, NOT_CONNECTED_FIX, backoffDelay, type BridgeInfo, type Msg, type Req, type Res } from "../shared/protocol.js";

declare const __BRIDGE_ASSETS__: Record<string, { type: string; body: string }> | undefined;
declare const __VERSION__: string | undefined;
export const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
declare const __BUILD__: string | undefined;
export const BUILD = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";
const outdated = (b: { info: { build?: string } }) => BUILD !== "dev" && b.info.build !== BUILD;

export type Timing = { heartbeatMs: number; deadMs: number; bridgeWaitMs: number; coldBridgeWaitMs: number; pinnedWaitMs?: number };
const envNum = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
export const defaultTiming = (): Timing => ({
  heartbeatMs: envNum("FORMA_MCP_HEARTBEAT_MS", 5000),
  deadMs: envNum("FORMA_MCP_DEAD_MS", 20000),
  bridgeWaitMs: envNum("FORMA_MCP_BRIDGE_WAIT_MS", 6000), // after a recent drop / takeover
  pinnedWaitMs: envNum("FORMA_MCP_PINNED_WAIT_MS", 30000), // a task's own window (panel reloads on design-option switch)
  coldBridgeWaitMs: envNum("FORMA_MCP_COLD_WAIT_MS", 2000), // Forma not seen for a while
});

export type LinkStatus = {
  role: "hub" | "relay";
  version: string;
  port: number;
  url: string;
  agents: number;
  bridges: { id: string; project: string; proposal?: string; canEdit?: boolean; active: boolean; since: string; tab?: string; outdated?: boolean }[];
};

export type CallOpts = { timeoutMs?: number; write?: boolean };

/** Transport to the hub vanished; the caller may resend the same request id. */
export class LinkLost extends Error {}

const stateDir = () => process.env.FORMA_MCP_HOME ?? join(homedir(), ".forma-mcp");

function token(create: boolean): string {
  const f = join(stateDir(), "token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  if (!create) return "";
  mkdirSync(stateDir(), { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function assets(): Record<string, { type: string; body: string }> {
  if (typeof __BRIDGE_ASSETS__ !== "undefined") return __BRIDGE_ASSETS__;
  const dir = join(process.cwd(), "dist", "bridge"); // dev/test fallback
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return {
    "/": { type: "text/html; charset=utf-8", body: read("index.html") },
    "/bridge.js": { type: "text/javascript; charset=utf-8", body: read("bridge.js") },
  };
}

/** Origins allowed to embed the panel page: Forma (EU + US) and ourselves. FORMA_MCP_FRAME_ANCESTORS overrides. */
export const frameAncestors = () => process.env.FORMA_MCP_FRAME_ANCESTORS ?? "'self' https://*.autodeskforma.eu https://*.autodeskforma.com https://*.autodesk.com";

const notConnected = () => new FormaError("Forma is not connected", NOT_CONNECTED_FIX);

// ---------------- hub ----------------
type Bridge = { id: string; ws: WebSocket; info: BridgeInfo; since: number; lastRx: number };
type Origin = { kind: "local"; resolve: (v: unknown) => void; reject: (e: Error) => void } | { kind: "agent"; ws: WebSocket | null };
type Pending = { req: Req; origin: Origin; bridge?: Bridge; sends: number; timer: NodeJS.Timeout; waitTimer?: NodeJS.Timeout };
type Agent = { ws: WebSocket; lastRx: number };

export class Hub {
  readonly role = "hub" as const;
  private server!: Server;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private bridges: Bridge[] = [];
  private agents = new Set<Agent>();
  private selected?: string;
  private pending = new Map<string, Pending>();
  private recent = new Map<string, { res: Res; at: number }>();
  private bseq = 0;
  private tok = token(true);
  private tick?: NodeJS.Timeout;
  private lastTick = Date.now();
  private graceUntil = 0;
  private startedAt = Date.now();
  private lastBridgeAt = 0;

  private runs = new Map<string, RunHandle>();
  /** the running panel task, so a reloaded panel can pick it up again */
  private active_?: { runId: string; prompt: string; steps: string[]; startedAt: number; tab?: string };
  private runner?: CodexRunner;
  private update?: UpdateInfo;
  private updateTimer?: NodeJS.Timeout;
  /** Set by LinkManager: a newer helper asked for the port; step back for `ms`. */
  onHandover?: (ms: number) => void;

  constructor(public port: number, private opts: { persistent?: boolean; timing?: Timing; host?: string; runner?: CodexRunner; runTimeoutMs?: number; updateDir?: string; build?: string } = {}) {}

  private get build() { return this.opts.build ?? BUILD; }

  /** A newer build (e.g. the background helper right after an update) asks this one for the port.
   *  Only a Codex-owned hub with no panel task running steps back; its Codex session stays
   *  connected as a relay, so nothing breaks, and the panel reconnects to the new code. */
  private handover(req: IncomingMessage): { status: number; text: string } {
    if (!safeEq(String(req.headers["x-forma-token"] ?? ""), this.tok)) return { status: 403, text: "forbidden" };
    if (this.opts.persistent) return { status: 409, text: "persistent hub" };
    if (this.active_) return { status: 409, text: "a panel task is running" };
    if (!isNewerBuild(String(req.headers["x-forma-build"] ?? ""), this.build)) return { status: 409, text: "not newer" };
    const ms = HANDOVER_MS;
    log("info", `handing the port to build ${req.headers["x-forma-build"]} (this is ${this.build})`);
    const raw = JSON.stringify({ t: "yield", ms });
    for (const a of this.agents) if (a.ws.readyState === WebSocket.OPEN) a.ws.send(raw);
    setTimeout(() => this.onHandover?.(ms), 50);
    return { status: 200, text: "ok" };
  }

  private checkForUpdate() {
    const u = checkUpdate(this.opts.build ?? BUILD, this.opts.updateDir);
    if (u && u.build !== this.update?.build) {
      this.update = u;
      log("info", `update available: ${u.version} build ${u.build} in ${u.source}`);
      this.broadcast({ t: "update", version: u.version, build: u.build });
    }
  }

  /** Codex runner for panel AI tasks (lazy; tests inject a fake). */
  private ai(): CodexRunner {
    this.runner ??= this.opts.runner ?? new ExecRunner({ serverPath: process.env.FORMA_MCP_SERVER_PATH ?? process.argv[1] });
    return this.runner;
  }

  private broadcast(m: Msg) {
    const raw = JSON.stringify(m);
    for (const b of this.bridges) if (b.ws.readyState === WebSocket.OPEN) b.ws.send(raw);
  }

  private async onAi(ws: WebSocket, msg: Msg) {
    const send = (m: Msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    if (msg.t === "ai.check") {
      send({ t: "ai.status", id: msg.id, status: await this.ai().check() });
    } else if (msg.t === "ai.cancel") {
      this.runs.get(msg.runId)?.cancel();
    } else if (msg.t === "ai.run") {
      const fail = (text: string, fix?: string) => send({ t: "ai.event", runId: msg.runId, ev: { kind: "error", text, fix } });
      if (this.runs.size) return fail("Another assistant task is still running.", "Wait for it to finish, or press Stop.");
      const prompt = String(msg.prompt ?? "");
      if (!prompt.trim()) return fail("The request is empty.");
      if (prompt.length > 20000) return fail("The request is too long.", "Shorten it to a few paragraphs.");
      const from = this.bridges.find((x) => x.ws === ws);
      if (from && outdated(from)) return fail("This panel is an older version.", "Reload the Forma tab (F5) and open the panel again.");
      const env: Record<string, string> = { FORMA_MCP_PORT: String(this.port), FORMA_MCP_APPROVAL: "panel" };
      // The assistant works in the Forma window whose panel started it — never in another open window.
      if (from?.info.tabId) env.FORMA_MCP_TAB = from.info.tabId;
      for (const k of ["FORMA_MCP_ONLY_PROPOSAL", "FORMA_MCP_HOME", "FORMA_MCP_LOG_DIR", "FORMA_MCP_REPORT_DIR"]) if (process.env[k]) env[k] = process.env[k]!;
      const startedAt = Date.now();
      const act = { runId: msg.runId, prompt: (msg.title ?? prompt).slice(0, 300), steps: [] as string[], startedAt, tab: from?.info.tabId };
      this.active_ = act;
      log("info", `task ${msg.runId} started (${msg.threadId ? "follow-up" : "new"}, ${prompt.length} chars, tab ${from?.info.tabId ?? "?"})`);
      let outcome = "?";
      const handle = this.ai().start({
        prompt: msg.threadId ? prompt : wrapPrompt(prompt),
        threadId: msg.threadId,
        env,
        onEvent: (ev) => {
          if (ev.kind === "step" && act.steps.at(-1) !== ev.text) act.steps.push(ev.text);
          if (ev.kind === "done" || ev.kind === "error" || ev.kind === "cancelled") outcome = ev.kind === "error" ? `error: ${ev.text}` : ev.kind;
          // to every panel: a reloaded panel still sees the end of a running task
          this.broadcast({ t: "ai.event", runId: msg.runId, ev });
        },
      });
      this.runs.set(msg.runId, handle);
      // A hung Codex run must never block the panel forever.
      const limit = this.opts.runTimeoutMs ?? envNum("FORMA_MCP_RUN_TIMEOUT_MS", 20 * 60000);
      const guard = setTimeout(() => {
        log("warn", `task ${msg.runId} exceeded ${Math.round(limit / 60000)} min; stopping it`);
        this.broadcast({ t: "ai.event", runId: msg.runId, ev: { kind: "step", text: "The task took too long and was stopped." } });
        handle.cancel();
      }, limit);
      guard.unref();
      handle.done.finally(() => {
        clearTimeout(guard);
        this.runs.delete(msg.runId);
        if (this.active_ === act) this.active_ = undefined;
        log("info", `task ${msg.runId} ended after ${Math.round((Date.now() - startedAt) / 1000)} s: ${outcome}`);
      });
    } else if (msg.t === "diag") {
      const text = await diagnostics({ version: VERSION, build: BUILD, port: this.port, hub: this.status(), codex: () => this.ai().check() });
      send({ t: "diag.res", id: msg.id, text });
    } else if (msg.t === "update.run") {
      if (!this.update) return;
      log("info", `update to build ${this.update.build} requested from the panel`);
      runUpdate(this.update);
    }
  }
  private get t() { return this.opts.timing ?? defaultTiming(); }

  listen(): Promise<void> {
    const files = assets();
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      // DNS-rebinding guard: only requests addressed to this computer by name/IP.
      if (!this.hostOk(req)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (path === "/health") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ app: APP, protocol: PROTOCOL, version: VERSION, build: this.build, persistent: !!this.opts.persistent, bridges: this.bridges.length, agents: this.agentCount() }));
      }
      if (path === "/handover" && req.method === "POST") {
        const r = this.handover(req);
        res.writeHead(r.status, { "content-type": "text/plain" });
        return res.end(r.text);
      }
      const f = files[path] ?? (path.endsWith("/") || !path.includes(".") ? files["/"] : undefined);
      if (!f?.body) {
        res.writeHead(404);
        return res.end("not found");
      }
      // The panel page may only be embedded by Forma itself (not by another website).
      const headers: Record<string, string> = { "content-type": f.type, "cache-control": "no-cache" };
      if (f.type.startsWith("text/html")) headers["content-security-policy"] = `frame-ancestors ${frameAncestors()}`;
      res.writeHead(200, headers);
      res.end(f.body);
    });
    this.server.on("upgrade", (req, sock, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (!this.hostOk(req)) sock.destroy();
      else if (url.pathname === "/ws/bridge" && this.originOk(req)) this.wss.handleUpgrade(req, sock, head, (ws) => this.onBridge(ws));
      else if (url.pathname === "/ws/agent" && safeEq(url.searchParams.get("token") ?? "", this.tok)) this.wss.handleUpgrade(req, sock, head, (ws) => this.onAgent(ws));
      else {
        log("warn", `refused a connection to ${url.pathname} (origin ${req.headers.origin ?? "none"})`);
        sock.destroy();
      }
    });
    this.tick = setInterval(() => this.heartbeat(), this.t.heartbeatMs);
    this.tick.unref();
    this.checkForUpdate();
    this.updateTimer = setInterval(() => this.checkForUpdate(), envNum("FORMA_MCP_UPDATE_CHECK_MS", 6 * 3600000));
    this.updateTimer.unref();
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.opts.host ?? "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  private hostOk(req: IncomingMessage) {
    const h = (req.headers.host ?? "").toLowerCase();
    return h === `localhost:${this.port}` || h === `127.0.0.1:${this.port}` || h === `[::1]:${this.port}`;
  }

  /** Only pages we serve ourselves (http://localhost:PORT) may act as the bridge. */
  private originOk(req: IncomingMessage) {
    const o = req.headers.origin ?? "";
    return o === `http://localhost:${this.port}` || o === `http://127.0.0.1:${this.port}`;
  }

  private agentCount() {
    return (this.opts.persistent ? 0 : 1) + this.agents.size;
  }

  private broadcastAgents() {
    const m = JSON.stringify({ t: "agents", n: this.agentCount() } satisfies Msg);
    for (const b of this.bridges) b.ws.send(m);
  }

  private heartbeat() {
    const now = Date.now();
    if (now - this.lastTick > this.t.heartbeatMs * 3) this.graceUntil = now + this.t.deadMs; // we slept
    this.lastTick = now;
    const dead = (rx: number) => now > this.graceUntil && now - rx > this.t.deadMs;
    for (const b of this.bridges) {
      if (dead(b.lastRx)) { b.ws.terminate(); continue; }
      b.ws.ping(); // answered by the browser itself, even in throttled background tabs
      b.ws.send(JSON.stringify({ t: "ping" })); // lets the bridge detect a dead hub
    }
    for (const a of this.agents) {
      if (dead(a.lastRx)) { a.ws.terminate(); continue; }
      a.ws.ping();
    }
    for (const [k, v] of this.recent) if (now - v.at > 60000) this.recent.delete(k);
  }

  private onBridge(ws: WebSocket) {
    const b: Bridge = { id: `b${++this.bseq}`, ws, info: { projectId: "?" }, since: Date.now(), lastRx: Date.now() };
    let registered = false;
    ws.on("pong", () => (b.lastRx = Date.now()));
    ws.on("message", (raw) => {
      b.lastRx = Date.now();
      let msg: Msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === "hello") {
        b.info = msg.info;
        if (!registered) { this.bridges.push(b); registered = true; }
        this.selected = b.id; // newest bridge wins (reloaded tab, popped-out panel)
        this.lastBridgeAt = Date.now();
        ws.send(JSON.stringify({ t: "agents", n: this.agentCount() } satisfies Msg));
        if (outdated(b)) ws.send(JSON.stringify({ t: "outdated" } satisfies Msg));
        if (this.active_) ws.send(JSON.stringify({ t: "ai.active", ...this.active_ } satisfies Msg));
        if (this.update) ws.send(JSON.stringify({ t: "update", version: this.update.version, build: this.update.build } satisfies Msg));
        log("info", `panel ${b.id} connected (tab ${b.info.tabId ?? "?"}, build ${b.info.build ?? "?"}${outdated(b) ? ", OUTDATED" : ""}, can edit: ${b.info.canEdit})`);
        for (const p of this.pending.values()) if (!p.bridge) this.dispatch(p);
      } else if (msg.t === "info") b.info = { ...b.info, ...msg.info };
      else if (msg.t === "focus") this.selected = b.id;
      else if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      else if (msg.t === "ai.check" || msg.t === "ai.run" || msg.t === "ai.cancel" || msg.t === "diag" || msg.t === "update.run") void this.onAi(ws, msg).catch((e) => log("error", `${msg.t}: ${(e as Error)?.message ?? e}`));
      else if (msg.t === "res") this.settle(msg);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (registered) log("info", `panel ${b.id} disconnected`);
      this.bridges = this.bridges.filter((x) => x !== b);
      if (this.selected === b.id) this.selected = this.bridges.at(-1)?.id;
      this.lastBridgeAt = Date.now();
      // In-flight work moves to the next bridge (or waits for this one to come back).
      for (const p of this.pending.values()) if (p.bridge === b) this.dispatch(p);
    });
  }

  private onAgent(ws: WebSocket) {
    const a: Agent = { ws, lastRx: Date.now() };
    this.agents.add(a);
    this.broadcastAgents();
    ws.on("pong", () => (a.lastRx = Date.now()));
    ws.on("error", () => {});
    ws.on("close", () => {
      this.agents.delete(a);
      this.broadcastAgents();
      for (const p of this.pending.values()) if (p.origin.kind === "agent" && p.origin.ws === ws) p.origin.ws = null;
    });
    ws.on("message", async (raw) => {
      a.lastRx = Date.now();
      let req: Req;
      try { req = JSON.parse(String(raw)); } catch { return; }
      if (req.t !== "req") return;
      const reply = (r: Res) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(r));
      if (req.op === "__status" || req.op === "__select") {
        try {
          const result = req.op === "__status" ? this.status() : this.select(String((req.args as AnyObj)?.id ?? ""));
          reply({ t: "res", id: req.id, ok: true, result });
        } catch (e) {
          const err = e as FormaError;
          reply({ t: "res", id: req.id, ok: false, error: { message: err.message, fix: err.fix } });
        }
        return;
      }
      const done = this.recent.get(req.id);
      if (done) return reply(done.res);
      const p = this.pending.get(req.id);
      if (p) { p.origin = { kind: "agent", ws }; return; } // resend of an in-flight request: re-attach
      this.submit(req, { kind: "agent", ws });
    });
  }

  /** Local call from this process. */
  request(req: Req): Promise<unknown> {
    return new Promise((resolve, reject) => this.submit(req, { kind: "local", resolve, reject }));
  }

  private submit(req: Req, origin: Origin) {
    const timeoutMs = req.timeoutMs ?? 30000;
    const p: Pending = {
      req, origin, sends: 0,
      timer: setTimeout(() => (log("warn", `${req.op} timed out after ${Math.round(timeoutMs / 1000)} s (write: ${!!req.write}, sends: ${p.sends})`), this.finish(p, {
        t: "res", id: req.id, ok: false,
        error: {
          message: `'${req.op}' timed out after ${Math.round(timeoutMs / 1000)} s`,
          fix: req.write ? "State unknown: check with forma_find / forma_status before retrying." : "Forma may be busy (large scene). Retry with a smaller scope.",
        },
      })), timeoutMs),
    };
    this.pending.set(req.id, p);
    this.dispatch(p);
  }

  private waitWindow() {
    const now = Date.now();
    return now - this.startedAt < 20000 || now - this.lastBridgeAt < 120000 ? this.t.bridgeWaitMs : this.t.coldBridgeWaitMs;
  }

  private dispatch(p: Pending) {
    clearTimeout(p.waitTimer);
    const b = p.req.tab ? [...this.bridges].reverse().find((x) => x.info.tabId === p.req.tab) : this.active();
    if (b && outdated(b) && p.req.write) {
      // Old panel code still loaded in that window: never let it write.
      return this.finish(p, { t: "res", id: p.req.id, ok: false, error: { message: "the Forma MCP panel in this Forma window is an older version, so nothing was changed", fix: "Tell the user: reload the Forma tab (F5) and reopen the Forma MCP panel, then try again." } });
    }
    if (b) {
      p.bridge = b;
      p.sends++;
      try {
        b.ws.send(JSON.stringify({ ...p.req, t: "req", attempt: p.sends } satisfies Req));
      } catch {
        /* socket is closing; its close handler re-dispatches this request */
      }
      return;
    }
    p.bridge = undefined;
    p.waitTimer = setTimeout(() => {
      if (p.bridge || !this.pending.has(p.req.id)) return;
      const err = p.req.tab && !p.sends
        ? { message: "the Forma window that started this task is closed or not connected", fix: "Tell the user to keep that Forma window open (or reopen the Forma MCP panel there) and start the task again." }
        : p.sends && p.req.write
        ? { message: `Forma disconnected while '${p.req.op}' was running; it may or may not have applied`, fix: "When Forma is back (forma_status), check with forma_find before repeating it." }
        : { message: notConnected().message, fix: NOT_CONNECTED_FIX };
      this.finish(p, { t: "res", id: p.req.id, ok: false, error: err });
    }, p.req.tab ? Math.max(this.waitWindow(), this.t.pinnedWaitMs ?? 30000) : this.waitWindow());
  }

  private settle(res: Res) {
    const p = this.pending.get(res.id);
    if (p) this.finish(p, res);
  }

  private finish(p: Pending, res: Res) {
    if (!this.pending.has(p.req.id)) return;
    clearTimeout(p.timer);
    clearTimeout(p.waitTimer);
    this.pending.delete(p.req.id);
    if (p.origin.kind === "local") {
      if (res.ok) p.origin.resolve(res.result);
      else p.origin.reject(new FormaError(res.error.message, res.error.fix));
      return;
    }
    const ws = p.origin.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    else this.recent.set(res.id, { res, at: Date.now() }); // relay will resend this id
  }

  private active(): Bridge | undefined {
    return this.bridges.find((b) => b.id === this.selected) ?? this.bridges.at(-1);
  }

  status(): LinkStatus {
    const act = this.active()?.id;
    return {
      role: "hub", version: VERSION, port: this.port, url: `http://localhost:${this.port}/`, agents: this.agentCount(),
      bridges: this.bridges.map((b) => ({ id: b.id, project: b.info.projectName ?? b.info.projectId, proposal: b.info.proposalId, canEdit: b.info.canEdit, active: b.id === act, since: new Date(b.since).toISOString().slice(11, 19), tab: b.info.tabId, outdated: outdated(b) })),
    };
  }

  select(id: string) {
    if (!this.bridges.some((b) => b.id === id)) throw new FormaError(`no bridge '${id}'`, "See forma_status for connected bridges.");
    this.selected = id;
    return { selected: id };
  }

  async close() {
    for (const r of this.runs.values()) r.cancel();
    clearInterval(this.tick);
    clearInterval(this.updateTimer);
    for (const b of this.bridges) b.ws.terminate();
    for (const a of this.agents) a.ws.terminate();
    this.wss.close();
    await new Promise((r) => this.server?.close(r));
  }
}

type AnyObj = Record<string, any>;

// ---------------- relay ----------------
export class Relay {
  readonly role = "relay" as const;
  private ws?: WebSocket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private tick?: NodeJS.Timeout;
  private lastRx = Date.now();
  private lastTick = Date.now();
  private graceUntil = 0;
  onClose?: () => void;
  /** the hub is handing over to a newer build: do not race to become the hub for `ms` */
  onYield?: (ms: number) => void;

  constructor(public port: number, private timing: Timing = defaultTiming()) {}

  connect(): Promise<void> {
    const tok = token(false);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws/agent?token=${tok}`, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 3000 });
      ws.once("open", () => {
        this.ws = ws;
        this.lastRx = Date.now();
        this.tick = setInterval(() => {
          const now = Date.now();
          if (now - this.lastTick > this.timing.heartbeatMs * 3) this.graceUntil = now + this.timing.deadMs;
          this.lastTick = now;
          if (now > this.graceUntil && now - this.lastRx > this.timing.deadMs) return ws.terminate();
          ws.ping();
        }, this.timing.heartbeatMs);
        this.tick.unref();
        resolve();
      });
      ws.once("error", reject);
      ws.on("pong", () => (this.lastRx = Date.now()));
      ws.on("ping", () => (this.lastRx = Date.now()));
      ws.on("message", (raw) => {
        this.lastRx = Date.now();
        const msg = JSON.parse(String(raw)) as Res | { t: "yield"; ms: number; id?: undefined };
        if (msg.t === "yield") return this.onYield?.(msg.ms);
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new FormaError(msg.error.message, msg.error.fix));
      });
      ws.on("close", () => {
        clearInterval(this.tick);
        const wasOpen = this.ws === ws;
        this.ws = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new LinkLost("hub connection lost")); }
        this.pending.clear();
        if (wasOpen) this.onClose?.();
      });
    });
  }

  request(req: Req): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new LinkLost("hub not connected"));
    return new Promise((resolve, reject) => {
      // safety net only: the hub enforces the real timeout and answers
      const timer = setTimeout(() => { this.pending.delete(req.id); reject(new FormaError(`'${req.op}' got no answer from the hub`, req.write ? "State unknown: check before retrying." : "Retry.")); }, (req.timeoutMs ?? 30000) + 20000);
      this.pending.set(req.id, { resolve, reject, timer });
      ws.send(JSON.stringify(req));
    });
  }

  async close() {
    this.onClose = undefined;
    clearInterval(this.tick);
    this.ws?.close();
  }
}

// ---------------- manager: owns/joins the hub, resends across takeovers ----------------
export class LinkManager {
  private cur?: Hub | Relay;
  private starting?: Promise<Hub | Relay>;
  private seq = 0;
  private readonly origin = `${process.pid.toString(36)}${randomBytes(3).toString("hex")}`;
  private closed = false;
  private ensureTimer?: NodeJS.Timeout;
  private ensureAttempt = 0;
  private yieldUntil = 0;
  lastError?: string;

  constructor(public port: number, private opts: { persistent?: boolean; timing?: Timing; build?: string } = {}) {}

  private yieldFor(ms: number) { if (!this.opts.persistent) this.yieldUntil = Date.now() + ms; }

  /** Port owned by an older, Codex-owned helper: ask it to hand over. True if it agreed. */
  async requestHandover(): Promise<boolean> {
    try {
      const h = (await (await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })).json()) as { app?: string; build?: string; persistent?: boolean };
      if (h.app !== APP || h.persistent || !isNewerBuild(this.opts.build ?? BUILD, h.build ?? "")) return false;
      const r = await fetch(`http://127.0.0.1:${this.port}/handover`, { method: "POST", headers: { "x-forma-token": token(false), "x-forma-build": this.opts.build ?? BUILD }, signal: AbortSignal.timeout(3000) });
      return r.ok && (await r.text()) === "ok"; // older builds answer unknown paths with the panel page
    } catch {
      return false;
    }
  }

  private async probe(): Promise<"ours" | "foreign" | "free"> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
      return ((await r.json()) as { app?: string }).app === APP ? "ours" : "foreign";
    } catch (e) {
      return (e as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED" ? "free" : "foreign";
    }
  }

  private async start(): Promise<Hub | Relay> {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (Date.now() >= this.yieldUntil) {
        const hub = new Hub(this.port, { persistent: this.opts.persistent, timing: this.opts.timing, build: this.opts.build });
        try {
          await hub.listen();
          hub.onHandover = (ms) => {
            this.yieldFor(ms);
            if (this.cur === hub) this.cur = undefined;
            void hub.close().finally(() => this.ensure(true));
          };
          return hub;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        }
      }
      const who = await this.probe();
      if (who === "ours") {
        const relay = new Relay(this.port, this.opts.timing);
        try {
          await relay.connect();
          relay.onClose = () => this.lost(relay);
          relay.onYield = (ms) => this.yieldFor(ms);
          return relay;
        } catch { /* hub vanished between probe and connect: race for it */ }
      } else if (who === "foreign" && attempt >= 2) {
        throw new FormaError(`port ${this.port} is used by another program`, `Close that program, or set FORMA_MCP_PORT for forma-mcp and change the extension URL in Forma to match.`);
      }
      await sleep(backoffDelay(attempt, 60, 600));
    }
    throw new FormaError(`could not start on port ${this.port}`, "Retry in a few seconds.");
  }

  private lost(l: Hub | Relay) {
    if (this.cur === l) this.cur = undefined;
    if (!this.closed) this.ensure(true); // take over right away so the bridge has someone to reconnect to
  }

  private link(): Promise<Hub | Relay> {
    if (this.cur) return Promise.resolve(this.cur);
    this.starting ??= this.start().then(
      (l) => { this.cur = l; this.starting = undefined; this.lastError = undefined; this.ensureAttempt = 0; return l; },
      (e) => { this.starting = undefined; this.lastError = (e as Error).message; throw e; },
    );
    return this.starting;
  }

  /** Keep a hub or relay up in the background, forever. Never blocks the caller. */
  ensure(soon = false) {
    if (this.closed) return;
    clearTimeout(this.ensureTimer);
    const delay = soon ? Math.random() * 300 : 0;
    this.ensureTimer = setTimeout(() => {
      this.link().catch(() => {
        this.ensureTimer = setTimeout(() => this.ensure(), backoffDelay(this.ensureAttempt++, 500, 5000));
      });
    }, delay);
    this.ensureTimer.unref?.();
  }

  async call(op: string, args: unknown, opts: CallOpts = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 30000;
    const req: Req = { t: "req", id: `${this.origin}.${++this.seq}`, op, args, write: opts.write, timeoutMs, ...(process.env.FORMA_MCP_TAB ? { tab: process.env.FORMA_MCP_TAB } : {}) };
    const deadline = Date.now() + timeoutMs + 15000;
    for (let attempt = 0; ; attempt++) {
      const l = await this.link();
      try {
        return await l.request({ ...req, timeoutMs: Math.max(1000, Math.min(timeoutMs, deadline - Date.now())) });
      } catch (e) {
        if (!(e instanceof LinkLost)) throw e;
        if (this.cur === l) this.cur = undefined;
        if (Date.now() > deadline) {
          throw new FormaError(`lost the connection during '${op}'`, opts.write ? "State unknown: check with forma_find before retrying." : "Retry.");
        }
        await sleep(backoffDelay(attempt, 50, 500)); // same id: hub/bridge deduplicate
      }
    }
  }

  async status(): Promise<LinkStatus> {
    const l = await this.link();
    if (l.role === "hub") return l.status();
    return { ...((await this.call("__status", {})) as LinkStatus), role: "relay" };
  }

  async select(id: string) {
    const l = await this.link();
    if (l.role === "hub") return l.select(id);
    return this.call("__select", { id });
  }

  role() {
    return this.cur?.role;
  }

  /** Persistent mode: become the hub if the port is free; if another hub owns it, detach and report. */
  async claim(): Promise<"hub" | "relay"> {
    const l = await this.link();
    if (l.role === "relay") {
      await l.close();
      if (this.cur === l) this.cur = undefined;
    }
    return l.role;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.ensureTimer);
    await this.cur?.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HANDOVER_MS = 15000;
/** Builds are base36 timestamps; "dev" or unknown is never newer. */
export function isNewerBuild(a: string, b: string): boolean {
  const x = parseInt(a, 36), y = parseInt(b, 36);
  return /^[0-9a-z]{6,}$/.test(a) && Number.isFinite(x) && (!Number.isFinite(y) || !/^[0-9a-z]{6,}$/.test(b) || x > y);
}
