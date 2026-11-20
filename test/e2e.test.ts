import { execFileSync } from "node:child_process";
// Spawns the built server (dist/server.js) twice, attaches a fake Forma bridge over
// WebSocket, and drives both through real MCP clients. Covers hub, relay and failover.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "./mockForma.js";
import { BridgeClient, type WsLike } from "../src/bridge/client.js";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const HOME = mkdtempSync(join(tmpdir(), "forma-mcp-test-"));

function startClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    env: { ...process.env, FORMA_MCP_PORT: String(PORT), FORMA_MCP_HOME: HOME } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0" });
  return { client, transport, ready: client.connect(transport) };
}

// The panel must carry the same build id as the server, or the server treats it as outdated.
const SERVER_BUILD = execFileSync(process.execPath, ["dist/server.js", "--version", "--build"], { encoding: "utf8" }).trim().split(" ")[1];

/** The real bridge connection code (BridgeClient) driving Ops against the mock SDK. */
function startBridge(F: any) {
  const ops = new Ops(F);
  const c = new BridgeClient({
    url: `ws://127.0.0.1:${PORT}/ws/bridge`,
    connect: (u) => new WebSocket(u, { origin: `http://localhost:${PORT}` }) as unknown as WsLike,
    run: (op, args) => ops.run(op, args),
    info: async () => ({ projectId: "proj", projectName: "Test Site", canEdit: true, build: SERVER_BUILD }),
  });
  c.start();
  return { stop: () => c.stop(), client: c };
}

const text = (r: any) => r.content.map((c: any) => c.text ?? `<${c.type}>`).join("\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: MCP ⇄ hub ⇄ bridge", () => {
  const A = startClient();
  let B: ReturnType<typeof startClient>;
  const mock = mockForma();
  let bridge: ReturnType<typeof startBridge>;

  beforeAll(async () => {
    await A.ready;
    // first tool call triggers hub start; wait for it to listen before bridge connects
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not yet */ }
      await wait(100);
    }
    bridge = startBridge(mock.F);
    await wait(300);
  }, 20000);

  afterAll(async () => {
    bridge?.stop();
    await A.client.close().catch(() => {});
    await B?.client.close().catch(() => {});
  });

  it("lists 12 compact tools", async () => {
    const { tools } = await A.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["forma_analysis", "forma_check", "forma_report", "forma_create", "forma_edit", "forma_find", "forma_metrics", "forma_read", "forma_script", "forma_site", "forma_status", "forma_view"].sort());
    // Codex (OpenAI function schemas) silently drops tools with tuple-style "items": [...] — found live.
    for (const t of tools) expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"items":\[/);
    const schemaChars = JSON.stringify(tools).length;
    console.log(`tool schema size: ${schemaChars} chars (~${Math.round(schemaChars / 4)} tokens)`);
    // Budget includes the shared planning-rule schema advertised by both check and report.
    expect(schemaChars).toBeLessThan(20000);
  });

  it("checks Abstandsflächen through the MCP tool", async () => {
    const result = await A.client.callTool({ name: "forma_check", arguments: { rules: { abstand: { state: "BW", area: "GE" } }, show: true } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("BW · Gewerbegebiet · Faktor 0.125");
    expect(text(result)).toContain("§§ 5–7");
    expect(mock.calls.some((c) => c.fn === "geojson.add")).toBe(true);
  });

  it("returns the capacity table and previews a block through the MCP tool", async () => {
    const before = mock.calls.filter((c) => c.fn === "batch").length;
    const result = await A.client.callTool({ name: "forma_check", arguments: {
      action: "capacity", rules: { maxFullStoreys: 5, maxHeight: 12, maxGrz: 0.2, maxGfz: 0.8 },
      create: true, preview: true,
    } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("2.800 m² Bruttogrundfläche bei 4 Vollgeschossen");
    expect(text(result)).toContain("Maßgebend: GFZ 0,8, GRZ 0,2, Höhenlimit 12 m");
    expect(text(result)).toContain("preview (nothing written)");
    expect(mock.calls.filter((c) => c.fn === "batch")).toHaveLength(before);
  });

  it("renders the clipped inventory and existing problems for an add-mode preview", async () => {
    const result = await A.client.callTool({ name: "forma_check", arguments: {
      action: "capacity", mode: "add", rules: { maxHeight: 12, maxGrz: 0.2, maxGfz: 1 }, preview: true,
    } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Counted footprint m2");
    expect(text(result)).toContain("Block A\troot/k2\t200\t1.400 (measured)");
    expect(text(result)).toContain("Existing problems (not caused by the new block)");
    expect(text(result)).toContain("Geometrische Obergrenze");
    expect(text(result)).toMatch(/Footprint \(local XY in metres, rounded to cm\): \[\[/);
    expect(text(result)).toContain("Candidate validation: validated");
    expect(text(result)).toContain("preview (nothing written)");
  });

  it("serves the bridge page", async () => {
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    expect(html).toContain("<title>Forma MCP</title>");
    expect((await fetch(`http://127.0.0.1:${PORT}/bridge.js`)).status).toBe(200);
  });

  it("rejects bridge sockets from foreign origins", async () => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bridge`, { origin: "https://evil.example" });
    const res = await new Promise((r) => { s.on("open", () => r("open")); s.on("error", () => r("rejected")); });
    expect(res).toBe("rejected");
  });

  it("status → find (handle) → edit via handle → undo", async () => {
    const st = text(await A.client.callTool({ name: "forma_status", arguments: {} }));
    expect(st).toContain("link: hub");
    expect(st).toContain('counts: {"terrain":1,"building":2,"site_limit":1}');

    const f = text(await A.client.callTool({ name: "forma_find", arguments: { category: "building" } }));
    expect(f.split("\n")[0]).toBe("r1: 2 matches — from:'r1' targets all 2");
    expect(f).toContain("path\tcat\tname\tfunc\tarea\theight");
    console.log("find output:\n" + f);

    const e = text(await A.client.callTool({ name: "forma_edit", arguments: { ops: [{ op: "move", from: "r1", dx: 3 }] } }));
    expect(e).toMatch(/paths: \["root\/k\d+","root\/k\d+"\]/);

    const back = text(await A.client.callTool({ name: "forma_find", arguments: { from: "last", fields: ["bbox"] } }));
    expect(back).toContain("[[3,0,0],[23,10,21]]");

    const u = text(await A.client.callTool({ name: "forma_edit", arguments: { undo: 1 } }));
    expect(u).toContain('undone: ["edit move"]');
  });

  it("create returns a compact table; capture returns an image block", async () => {
    const c = text(await A.client.callTool({ name: "forma_create", arguments: { items: [{ type: "building", rect: [0, 100, 18, 12], floors: 6, func: "Residential", name: "N1" }] } }));
    expect(c).toMatch(/^created 1/);
    expect(c).toContain("N1\t6\t18\t216\t1296");
    const img: any = await A.client.callTool({ name: "forma_view", arguments: { action: "capture", fit: "iso", width: 640, height: 400 } });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: "QUJD" });
  });

  it("errors carry a fix line", async () => {
    const r: any = await A.client.callTool({ name: "forma_edit", arguments: { ops: [{ op: "remove", paths: ["root/nope"] }] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/error: element 'root\/nope' not found\nfix: /);
  });

  it("second session relays through the hub", async () => {
    B = startClient();
    await B.ready;
    const st = text(await B.client.callTool({ name: "forma_status", arguments: {} }));
    expect(st).toContain("link: relay");
    expect(st).toContain("Test Site");
    const m = text(await B.client.callTool({ name: "forma_metrics", arguments: {} }));
    expect(m).toContain("far: 0.4");
  }, 15000);

  it("relay takes over when the hub process exits", async () => {
    await A.client.close();
    let st = "";
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const r: any = await B.client.callTool({ name: "forma_status", arguments: {} });
      st = text(r);
      if (st.includes("link: hub") && !r.isError) break;
    }
    expect(st).toContain("link: hub");
    expect(st).toContain("Test Site"); // bridge reconnected to the new hub
  }, 20000);

  it("latency: 50 sequential reads", async () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) await B.client.callTool({ name: "forma_find", arguments: { category: "building", fields: [] } });
    const per = (performance.now() - t0) / 50;
    console.log(`round trip MCP→hub→bridge→MCP: ${per.toFixed(2)} ms/call`);
    expect(per).toBeLessThan(50);
  });
});
