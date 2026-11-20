// Reliability: reconnect, owner takeover, half-open detection, write dedup.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, connect, type Socket, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BridgeClient, type KvStore, type WsLike } from "../src/bridge/client.js";
import { Hub, LinkManager, type Timing } from "../src/server/link.js";

process.env.FORMA_MCP_HOME = mkdtempSync(join(tmpdir(), "forma-mcp-rc-"));
const T: Timing = { heartbeatMs: 80, deadMs: 400, bridgeWaitMs: 2500, coldBridgeWaitMs: 300 };
let port = 21000 + Math.floor(Math.random() * 3000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(step); }
  throw new Error("condition not met in time");
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); port += 7; });

function memStore(): KvStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), keys: () => [...m.keys()] };
}

/** Real BridgeClient against `url`, with a scriptable op runner. */
function bridge(url: string, hubPort: number, run: (op: string, args: any) => Promise<unknown>, store = memStore()) {
  const states: string[] = [];
  const c = new BridgeClient({
    url,
    // via the test proxy the Host header would name the proxy port; a browser talks to the hub directly
    connect: (u) => new WebSocket(u, { origin: `http://localhost:${hubPort}`, headers: { host: `localhost:${hubPort}` } }) as unknown as WsLike,
    run,
    info: async () => ({ projectId: "p", projectName: "Proj" }),
    store,
    heartbeatMs: 80, deadMs: 400, minBackoffMs: 20, maxBackoffMs: 200, connectTimeoutMs: 1000, reconnectingGraceMs: 2000,
    onState: (s) => { if (states.at(-1) !== s.state) states.push(s.state); },
  });
  c.start();
  cleanup.push(() => c.stop());
  return { c, states, store };
}

/** TCP proxy whose live connections can be black-holed (no FIN/RST, nothing delivered). */
function proxy(target: number) {
  const pairs: [Socket, Socket][] = [];
  const srv: Server = createServer((a) => {
    const b = connect(target, "127.0.0.1");
    a.pipe(b); b.pipe(a);
    a.on("error", () => {}); b.on("error", () => {});
    pairs.push([a, b]);
  });
  const p = port + 3;
  srv.listen(p, "127.0.0.1");
  cleanup.push(() => { pairs.forEach(([a, b]) => { a.destroy(); b.destroy(); }); srv.close(); });
  return {
    port: p,
    blackhole() { for (const [a, b] of pairs.splice(0)) { a.unpipe(b); b.unpipe(a); a.pause(); b.pause(); } },
    cut() { for (const [a, b] of pairs.splice(0)) { a.destroy(); b.destroy(); } },
  };
}

async function hub(p = port) {
  const h = new Hub(p, { timing: T });
  await h.listen();
  cleanup.push(() => h.close());
  return h;
}

describe("bridge ⇄ hub reconnect", () => {
  it("reconnects forever after the hub goes away and comes back; UI goes connected → reconnecting → connected", async () => {
    let h = await hub();
    const b = bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => "ok");
    await until(() => h.status().bridges.length === 1);
    expect(b.states.at(-1)).toBe("connected");
    await h.close();
    await until(() => b.states.includes("reconnecting"));
    await sleep(600); // several failed attempts while nobody listens
    h = await hub();
    await until(() => h.status().bridges.length === 1 && b.c.connected, 3000);
    expect(b.states.slice(-3)).toEqual(["connected", "reconnecting", "connected"]);
    expect(b.c.stats.connects).toBe(2);
  });

  it("shows 'Connected' even when no Codex chat is attached (the panel assistant works standalone)", async () => {
    const h = new Hub(port, { timing: T, persistent: true });
    await h.listen();
    cleanup.push(() => h.close());
    const b = bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => "ok");
    await until(() => b.c.connected);
    await sleep(50);
    expect(b.c.uiState()).toMatchObject({ state: "connected", text: "Connected", agents: 0 });
  });

  it("detects a half-open socket on both sides and recovers", async () => {
    const h = await hub();
    const px = proxy(port);
    const b = bridge(`ws://127.0.0.1:${px.port}/ws/bridge`, port, async () => "ok");
    await until(() => h.status().bridges.length === 1);
    const mark = b.states.length;
    px.blackhole(); // like a laptop lid / Wi-Fi change: no close frame, nothing arrives
    await until(() => b.states.slice(mark).includes("reconnecting"), 2000); // bridge side noticed
    await until(() => b.c.connected && h.status().bridges.length === 1, 3000); // fresh socket through the proxy
    await until(() => h.status().bridges.length === 1, 2000); // hub dropped the dead one
    expect(b.c.stats.connects).toBe(2);
  });
});

describe("in-flight requests across drops", () => {
  it("a write interrupted by a dropped socket is resent with the same id and runs exactly once", async () => {
    const h = await hub();
    const px = proxy(port);
    let runs = 0;
    bridge(`ws://127.0.0.1:${px.port}/ws/bridge`, port, async (op) => { runs++; await sleep(300); return { op, made: 1 }; });
    await until(() => h.status().bridges.length === 1);
    const call = h.request({ t: "req", id: "w1", op: "create", args: {}, write: true, timeoutMs: 5000 });
    await sleep(100);
    px.cut(); // connection dies while the write executes in Forma
    await expect(call).resolves.toEqual({ op: "create", made: 1 });
    expect(runs).toBe(1);
  });

  it("a write whose panel reloaded mid-flight reports uncertain state instead of re-running", async () => {
    const h = await hub();
    const store = memStore();
    let runs = 0;
    const first = bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => { runs++; await sleep(10_000); return 1; }, store);
    await until(() => h.status().bridges.length === 1);
    const call = h.request({ t: "req", id: "w2", op: "edit", args: {}, write: true, timeoutMs: 8000 });
    await sleep(100);
    first.c.stop(); // tab reload: this JS context is gone, the write never reported back
    bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => { runs++; return 2; }, store); // reloaded panel, same localStorage
    await expect(call).rejects.toMatchObject({ message: expect.stringMatching(/may or may not have applied/), fix: expect.stringMatching(/forma_find/) });
    expect(runs).toBe(1);
  });

  it("a read interrupted by a panel reload is retried transparently", async () => {
    const h = await hub();
    let runs = 0;
    const first = bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => { runs++; await sleep(10_000); return "stale"; });
    await until(() => h.status().bridges.length === 1);
    const call = h.request({ t: "req", id: "r1", op: "find", args: {}, timeoutMs: 8000 });
    await sleep(100);
    first.c.stop();
    bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async () => { runs++; return "fresh"; });
    await expect(call).resolves.toBe("fresh");
    expect(runs).toBe(2);
  });

  it("no panel at all: fails within the grace window with the actionable message", async () => {
    const h = new Hub(port, { timing: { ...T, bridgeWaitMs: 300 } });
    await h.listen();
    cleanup.push(() => h.close());
    const t0 = Date.now();
    await expect(h.request({ t: "req", id: "x", op: "find", args: {}, timeoutMs: 5000 })).rejects.toMatchObject({ message: "Forma is not connected", fix: expect.stringMatching(/Forma MCP' panel/) });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("multi-session port sharing", () => {
  it("second instance joins as relay; when the owner exits it takes over and in-flight writes complete exactly once", async () => {
    const A = new LinkManager(port, { timing: T });
    const B = new LinkManager(port, { timing: T });
    cleanup.push(() => A.close(), () => B.close());
    A.ensure();
    await until(() => A.role() === "hub");
    B.ensure();
    await until(() => B.role() === "relay");

    let runs = 0;
    const b = bridge(`ws://127.0.0.1:${port}/ws/bridge`, port, async (op) => { runs++; await sleep(op === "slow" ? 400 : 0); return `${op}-done`; });
    await until(() => b.c.connected);
    await until(() => b.c.uiState().agents === 2); // panel knows two Codex sessions are attached

    expect(await B.call("find", {})).toBe("find-done");
    const inflight = B.call("slow", {}, { write: true, timeoutMs: 6000 });
    await sleep(100);
    await A.close(); // owner Codex window closed mid-write

    await expect(inflight).resolves.toBe("slow-done");
    expect(B.role()).toBe("hub");
    expect(runs).toBe(2); // find + slow, never re-executed
    expect(await B.call("find", {})).toBe("find-done");
  });

  it("five instances started at once: exactly one hub, the rest relays", async () => {
    const ms = Array.from({ length: 5 }, () => new LinkManager(port, { timing: T }));
    cleanup.push(...ms.map((m) => () => m.close()));
    ms.forEach((m) => m.ensure());
    await until(() => ms.every((m) => m.role()));
    expect(ms.filter((m) => m.role() === "hub")).toHaveLength(1);
    const statuses = await Promise.all(ms.map((m) => m.status()));
    expect(new Set(statuses.map((s) => s.agents))).toEqual(new Set([5]));
  });
});

describe("soak", () => {
  it("300 mixed reads and writes while the connection is cut every ~150 ms: every call answers, every write runs exactly once", async () => {
    const h = await hub();
    const px = proxy(port);
    const runs = new Map<string, number>();
    bridge(`ws://127.0.0.1:${px.port}/ws/bridge`, port, async (_op, args) => {
      runs.set(args.k, (runs.get(args.k) ?? 0) + 1);
      await sleep(5 + Math.random() * 40);
      return { k: args.k };
    });
    await until(() => h.status().bridges.length === 1);
    let cutting = true;
    const chaos = (async () => { while (cutting) { await sleep(100 + Math.random() * 100); px.cut(); } })();
    const results = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => (async () => {
      await sleep(i * 8);
      return h.request({ t: "req", id: `s${i}`, op: i % 3 ? "find" : "edit", args: { k: `s${i}` }, write: i % 3 === 0, timeoutMs: 15000 });
    })()));
    cutting = false;
    await chaos;
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    // A write cut mid-flight may honestly report "may or may not have applied"; nothing else may fail.
    for (const f of failed) expect(String(f.reason?.message)).toMatch(/may or may not have applied/);
    expect(failed.length).toBeLessThan(15);
    for (let i = 0; i < 300; i += 3) expect(runs.get(`s${i}`) ?? 0).toBeLessThanOrEqual(1); // never twice
  }, 30000);
});
