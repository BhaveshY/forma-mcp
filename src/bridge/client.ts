// Connection state machine for the Forma-side bridge. Environment-agnostic (browser
// WebSocket in Forma, `ws` in tests). Reconnects forever, detects half-open sockets,
// and deduplicates resent writes by request id.
import { PROTOCOL, backoffDelay, type BridgeInfo, type Msg, type Req, type Res } from "../shared/protocol.js";

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface KvStore {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
  keys(): string[];
}

export type UiState = "connected" | "reconnecting" | "waiting";

export type BridgeClientOpts = {
  url: string;
  connect: (url: string) => WsLike;
  run: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  info: () => Promise<BridgeInfo>;
  store?: KvStore;
  heartbeatMs?: number; // how often we check / send app pings
  deadMs?: number; // silence after which the socket is presumed dead
  connectTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  reconnectingGraceMs?: number; // show "Reconnecting…" this long after a drop, then "Waiting for Codex"
  onState?: (s: { state: UiState; agents: number; text: string }) => void;
  onLog?: (line: string) => void;
  /** messages the connection layer does not handle itself (panel AI: ai.status, ai.event) */
  onMessage?: (m: Msg) => void;
};

const OPEN = 1;
const REC_PREFIX = "fmcp:req:";
const REC_TTL = 60 * 60 * 1000;
const REC_MAX = 200;

export class BridgeClient {
  private ws?: WsLike;
  private attempt = 0;
  private lastRx = 0;
  private lastTick = 0;
  private graceUntil = 0;
  private everConnected = false;
  private lostAt = 0;
  private agents = 0;
  private helloDone = false;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  private inflight = new Map<string, Promise<Res>>();
  private recentReads = new Map<string, { res: Res; at: number }>();
  readonly o: Required<Omit<BridgeClientOpts, "store" | "onState" | "onLog" | "onMessage">> & BridgeClientOpts;
  stats = { connects: 0, served: 0, deduped: 0 };

  constructor(opts: BridgeClientOpts) {
    this.o = { heartbeatMs: 5000, deadMs: 20000, connectTimeoutMs: 5000, minBackoffMs: 250, maxBackoffMs: 5000, reconnectingGraceMs: 15000, ...opts };
  }

  start() {
    this.stopped = false;
    this.pruneStore();
    this.tick = setInterval(() => this.onTick(), this.o.heartbeatMs);
    this.open();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tick);
    clearTimeout(this.retryTimer);
    this.drop("stopped");
  }

  /** Reconnect now (network came back, tab visible again). */
  nudge() {
    if (this.stopped) return;
    if (this.ws?.readyState === OPEN) {
      this.safeSend({ t: "ping" });
      return;
    }
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.open();
  }

  /** Send an unsolicited message (e.g. info update) if connected. */
  push(m: Msg) {
    if (this.connected) this.safeSend(m);
  }

  get connected() {
    return this.ws?.readyState === OPEN && this.helloDone;
  }

  // ---- connection ----
  private open() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.emit();
    let sock: WsLike;
    try {
      sock = this.o.connect(this.o.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = sock;
    this.helloDone = false;
    const connectTimer = setTimeout(() => sock === this.ws && sock.readyState !== OPEN && this.drop("connect timeout"), this.o.connectTimeoutMs);
    sock.onopen = async () => {
      clearTimeout(connectTimer);
      if (sock !== this.ws) return;
      this.lastRx = Date.now();
      try {
        const info = await this.o.info();
        if (sock !== this.ws || sock.readyState !== OPEN) return;
        sock.send(JSON.stringify({ t: "hello", protocol: PROTOCOL, info } satisfies Msg));
        this.helloDone = true;
        this.attempt = 0;
        this.everConnected = true;
        this.stats.connects++;
        this.log("connected");
        this.emit();
      } catch {
        this.drop("hello failed");
      }
    };
    sock.onmessage = (ev) => {
      if (sock !== this.ws) return;
      this.lastRx = Date.now();
      let msg: Msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.t === "ping") this.safeSend({ t: "pong" });
      else if (msg.t === "agents") { this.agents = msg.n; this.emit(); }
      else if (msg.t === "req") void this.onReq(msg);
      else this.o.onMessage?.(msg);
    };
    sock.onclose = () => {
      clearTimeout(connectTimer);
      if (sock === this.ws) this.drop("closed");
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  private drop(reason: string) {
    const sock = this.ws;
    this.ws = undefined;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try { sock.close(); } catch { /* already closed */ }
      if (this.helloDone) {
        this.lostAt = Date.now();
        this.log(`connection lost (${reason})`);
      }
    }
    this.helloDone = false;
    if (!this.stopped) this.scheduleRetry();
    this.emit();
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const d = backoffDelay(this.attempt++, this.o.minBackoffMs, this.o.maxBackoffMs);
    this.retryTimer = setTimeout(() => this.open(), d);
  }

  private onTick() {
    const now = Date.now();
    // A long gap between ticks means the machine slept or the tab was frozen:
    // give the socket a fresh deadline instead of killing it on stale timestamps.
    if (this.lastTick && now - this.lastTick > this.o.heartbeatMs * 3) this.graceUntil = now + this.o.deadMs;
    this.lastTick = now;
    if (this.ws?.readyState === OPEN) {
      if (now > this.graceUntil && now - this.lastRx > this.o.deadMs) return this.drop("heartbeat timeout");
      this.safeSend({ t: "ping" });
    }
    this.emit();
    this.pruneReads(now);
  }

  private safeSend(m: Msg) {
    const s = this.ws;
    if (s?.readyState === OPEN) {
      try { s.send(JSON.stringify(m)); } catch { /* close handler reconnects */ }
    }
  }

  // ---- requests ----
  private async onReq(req: Req) {
    const existing = this.inflight.get(req.id);
    if (existing) {
      this.stats.deduped++;
      return this.safeSend(await existing);
    }
    const cachedRead = this.recentReads.get(req.id);
    if (cachedRead) {
      this.stats.deduped++;
      return this.safeSend(cachedRead.res);
    }
    if (req.write) {
      const rec = this.readRec(req.id);
      if (rec?.s === "done" && rec.res) {
        this.stats.deduped++;
        return this.safeSend(rec.res);
      }
      if (rec?.s === "started") {
        return this.safeSend({
          t: "res", id: req.id, ok: false,
          error: {
            message: "this write was interrupted (Forma panel reloaded or closed) before it finished; it may or may not have applied",
            fix: "Check the current state with forma_find / forma_status before deciding to repeat it.",
          },
        });
      }
      this.writeRec(req.id, { s: "started", t: Date.now() });
    }
    const p = this.exec(req);
    this.inflight.set(req.id, p);
    const res = await p;
    this.inflight.delete(req.id);
    if (req.write) {
      const json = JSON.stringify(res);
      this.writeRec(req.id, { s: "done", t: Date.now(), res: json.length < 200_000 ? res : { t: "res", id: req.id, ok: true, result: { note: "applied (result too large to cache)" } } });
    } else this.recentReads.set(req.id, { res, at: Date.now() });
    this.stats.served++;
    this.safeSend(res); // current socket; if down, the hub resends this id and gets the cached result
  }

  private async exec(req: Req): Promise<Res> {
    const t0 = Date.now();
    try {
      const result = await this.o.run(req.op, (req.args ?? {}) as Record<string, unknown>);
      this.log(`✓ ${req.op} ${Date.now() - t0}ms`);
      return { t: "res", id: req.id, ok: true, result };
    } catch (e) {
      const err = e as { message?: string; fix?: string };
      const message = err?.message ?? String(e);
      this.log(`✗ ${req.op} · ${message.slice(0, 60)}`);
      return { t: "res", id: req.id, ok: false, error: { message, fix: err?.fix ?? sdkFix(message) } };
    }
  }

  // ---- write records (survive panel reloads via localStorage) ----
  private readRec(id: string): { s: "started" | "done"; t: number; res?: Res } | undefined {
    try {
      const v = this.o.store?.get(REC_PREFIX + id);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  }

  private writeRec(id: string, rec: { s: string; t: number; res?: Res }) {
    try { this.o.store?.set(REC_PREFIX + id, JSON.stringify(rec)); } catch { /* storage full/blocked: dedup degrades to in-memory */ }
  }

  private pruneStore() {
    const st = this.o.store;
    if (!st) return;
    try {
      const recs = st.keys().filter((k) => k.startsWith(REC_PREFIX)).map((k) => ({ k, t: (JSON.parse(st.get(k) ?? "{}").t as number) ?? 0 }));
      recs.sort((a, b) => b.t - a.t);
      const now = Date.now();
      recs.forEach((r, i) => { if (i >= REC_MAX || now - r.t > REC_TTL) st.remove(r.k); });
    } catch { /* ignore */ }
  }

  private pruneReads(now: number) {
    for (const [k, v] of this.recentReads) if (now - v.at > 60000) this.recentReads.delete(k);
  }

  // ---- ui ----
  private emit() {
    const s = this.uiState();
    this.o.onState?.(s);
  }

  uiState(): { state: UiState; agents: number; text: string } {
    if (this.connected) {
      return { state: "connected", agents: this.agents, text: this.agents > 0 ? `Connected · Codex chats: ${this.agents}` : "Connected" };
    }
    if (this.everConnected && Date.now() - this.lostAt < this.o.reconnectingGraceMs) return { state: "reconnecting", agents: 0, text: "Reconnecting…" };
    return { state: "waiting", agents: 0, text: "Not connected yet — the Forma MCP service is starting or not running. Open Codex (or restart the computer); it connects by itself." };
  }

  private log(line: string) {
    this.o.onLog?.(line);
  }
}

function sdkFix(m: string): string | undefined {
  if (/permission|forbidden|403|edit access/i.test(m)) return "No edit rights here; check project permissions.";
  if (/not found|404/i.test(m)) return "The element/path no longer exists; re-run forma_find.";
  if (/timeout/i.test(m)) return "Forma is busy; retry once, then check forma_status.";
  return undefined;
}

/** localStorage adapter (guarded: storage may be blocked in some iframes). */
export function browserStore(): KvStore | undefined {
  try {
    const ls = globalThis.localStorage;
    ls.setItem("fmcp:probe", "1");
    ls.removeItem("fmcp:probe");
    return {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
      keys: () => Array.from({ length: ls.length }, (_, i) => ls.key(i)!).filter(Boolean),
    };
  } catch {
    return undefined;
  }
}
