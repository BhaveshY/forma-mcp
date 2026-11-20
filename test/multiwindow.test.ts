// Several Forma windows on one site: the right window is used, stale windows never write, unsaved writes are reported.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Hub, defaultTiming } from "../src/server/link.js";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "./mockForma.js";

describe("bridge: stale window and unsaved writes", () => {
  it("refuses to write when Forma has a newer saved version than this window shows", async () => {
    const m = mockForma();
    m.F.proposal.getAll = async () => [{ urn: "urn:adsk-forma-elements:proposal:proj:prop1:999999", properties: { name: "Option A" } }];
    const c0 = m.children.length;
    await expect(new Ops(m.F).run("edit", { ops: [{ op: "move", paths: [m.paths.b1], dx: 5 }] })).rejects.toMatchObject({ message: expect.stringMatching(/older version/), fix: expect.stringMatching(/reload/i) });
    expect(m.children.length).toBe(c0);
    expect(m.calls.some((c) => c.fn === "batch")).toBe(false);
  });
  it("reads still work in a stale window", async () => {
    const m = mockForma();
    m.F.proposal.getAll = async () => [{ urn: "urn:adsk-forma-elements:proposal:proj:prop1:999999", properties: {} }];
    const r: any = await new Ops(m.F).run("find", { category: "building" });
    expect(r.total).toBe(2);
  });
  it("a write Forma does not confirm as saved says so", async () => {
    const m = mockForma();
    m.F.udm.awaitPersisted = async () => { throw new Error("not persisted"); };
    const r: any = await new Ops(m.F).run("edit", { ops: [{ op: "move", paths: [m.paths.b1], dx: 5 }] });
    expect(r.saved).toMatch(/NOT CONFIRMED/);
  });
});

describe("hub: which Forma window gets the work", () => {
  async function setup() {
    process.env.FORMA_MCP_HOME = mkdtempSync(join(tmpdir(), "fmcp-mw-"));
    const port = 28000 + Math.floor(Math.random() * 2000);
    const hub = new Hub(port, { timing: { ...defaultTiming(), pinnedWaitMs: 1500, bridgeWaitMs: 500, coldBridgeWaitMs: 500 } });
    await hub.listen();
    const win = async (tabId: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge`, { origin: `http://localhost:${port}` });
      await new Promise((r) => ws.on("open", r));
      const got: string[] = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.t === "req") { got.push(m.op); ws.send(JSON.stringify({ t: "res", id: m.id, ok: true, result: tabId })); }
      });
      ws.send(JSON.stringify({ t: "hello", protocol: 2, info: { projectId: "p", tabId } }));
      await new Promise((r) => setTimeout(r, 50));
      return { ws, got };
    };
    return { hub, win };
  }
  it("the window the user last worked in is used; a task stays pinned to its own window", async () => {
    const { hub, win } = await setup();
    const A = await win("A");
    const B = await win("B"); // newest connects last
    expect(await hub.request({ t: "req", id: "1", op: "status", args: {} })).toBe("B");
    A.ws.send(JSON.stringify({ t: "focus" })); // user clicks in window A
    await new Promise((r) => setTimeout(r, 50));
    expect(await hub.request({ t: "req", id: "2", op: "status", args: {} })).toBe("A");
    expect(await hub.request({ t: "req", id: "3", op: "status", args: {}, tab: "B" })).toBe("B"); // pinned task
    A.ws.close(); B.ws.close();
    await hub.close();
  });
  it("a pinned task whose window is gone fails clearly instead of using another window", async () => {
    const { hub, win } = await setup();
    const A = await win("A");
    await expect(hub.request({ t: "req", id: "4", op: "edit", args: {}, write: true, tab: "gone", timeoutMs: 8000 })).rejects.toMatchObject({ message: expect.stringMatching(/window that started this task/) });
    expect(A.got).toEqual([]);
    A.ws.close();
    await hub.close();
  }, 15000);
});
