// Risky steps in panel-driven runs wait for Approve/Reject in the panel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BridgeClient, type WsLike } from "../src/bridge/client.js";
import { Hub } from "../src/server/link.js";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "./mockForma.js";

const PORT = 28000 + Math.floor(Math.random() * 1500);
const HOME = mkdtempSync(join(tmpdir(), "fmcp-appr-"));
process.env.FORMA_MCP_HOME = HOME;
const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");

describe("panel approvals", () => {
  const mock = mockForma();
  const asked: string[] = [];
  let answer = false;
  let hub: Hub;
  let bridge: BridgeClient;
  let client: Client;

  beforeAll(async () => {
    hub = new Hub(PORT);
    await hub.listen();
    const ops = new Ops(mock.F);
    bridge = new BridgeClient({
      url: `ws://127.0.0.1:${PORT}/ws/bridge`,
      connect: (u) => new WebSocket(u, { origin: `http://localhost:${PORT}` }) as unknown as WsLike,
      run: async (op, args) => (op === "ui.approve" ? (asked.push(String(args.title)), { approved: answer }) : ops.run(op, args)),
      info: async () => ({ projectId: "proj" }),
    });
    bridge.start();
    client = new Client({ name: "t", version: "0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["dist/server.js"], stderr: "ignore",
      env: { ...process.env, FORMA_MCP_PORT: String(PORT), FORMA_MCP_HOME: HOME, FORMA_MCP_APPROVAL: "panel" } as Record<string, string>,
    }));
    for (let i = 0; i < 100 && !bridge.connected; i++) await new Promise((r) => setTimeout(r, 30));
  }, 20000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    bridge?.stop();
    await hub?.close();
  });

  it("rejected removal changes nothing and tells the assistant not to retry", async () => {
    answer = false;
    const r: any = await client.callTool({ name: "forma_edit", arguments: { ops: [{ op: "remove", paths: [mock.paths.b2] }] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/the user rejected: Remove 1 element from the design\nfix: Do not retry/);
    expect(mock.children.some((c) => `root/${c.key}` === mock.paths.b2)).toBe(true);
  }, 20000);

  it("approved removal goes ahead", async () => {
    answer = true;
    const r: any = await client.callTool({ name: "forma_edit", arguments: { ops: [{ op: "remove", paths: [mock.paths.b2] }] } });
    expect(text(r)).toContain("removed: 1");
    expect(mock.children.some((c) => `root/${c.key}` === mock.paths.b2)).toBe(false);
  }, 20000);

  it("safe steps (create, move) never ask; scripts always ask", async () => {
    const before = asked.length;
    await client.callTool({ name: "forma_create", arguments: { items: [{ rect: [0, 0, 10, 10], floors: 2 }] } });
    expect(asked.length).toBe(before);
    answer = false;
    const s: any = await client.callTool({ name: "forma_script", arguments: { code: "return 1" } });
    expect(text(s)).toMatch(/rejected: Run an advanced custom step/);
  }, 20000);
});
