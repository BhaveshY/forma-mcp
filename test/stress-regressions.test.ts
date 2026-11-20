import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { Ops } from "../src/bridge/ops.js";
import { registerTools } from "../src/server/tools.js";
import { saveReport, toCsv, toHtml } from "../src/server/report.js";
import { wrapPrompt } from "../src/server/codex.js";
import { mockForma } from "./mockForma.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function connect(mock = mockForma(), lock = "") {
  vi.stubEnv("FORMA_MCP_ONLY_PROPOSAL", lock);
  vi.stubEnv("FORMA_MCP_APPROVAL", "");
  const ops = new Ops(mock.F);
  const link = { call: vi.fn((op: string, args: Record<string, unknown>, _opts?: unknown) => ops.run(op, args)), status: async () => ({ bridges: [], role: "test" }) };
  const server = new McpServer({ name: "forma", version: "0" });
  registerTools(server, link as unknown as Parameters<typeof registerTools>[1]);
  const client = new Client({ name: "test", version: "0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  clients.push(client);
  async function callResult(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP text content");
    return { isError: result.isError, text: result.content.map((item) => item.text).join("\n") };
  }
  return {
    client,
    dispatch: link.call,
    callResult,
    async call(name: string, args: Record<string, unknown>) {
      return (await callResult(name, args)).text;
    },
  };
}

it.each(["forma_create", "forma_edit"])("%s reports a timed-out save and refuses a handle for paths that cannot be read", async (name) => {
  const mock = mockForma();
  mock.F.elements.batch = async ({ operations }: { operations: unknown[] }) =>
    operations.map(() => ({ path: "root/missing" }));
  mock.F.udm.awaitPersisted = () => new Promise(() => {});
  const { call, callResult } = await connect(mock);
  vi.useFakeTimers();
  const pending = callResult(name, name === "forma_create"
    ? { items: [{ rect: [42, 10, 5, 5] }] }
    : { ops: [{ op: "move", paths: [mock.paths.b1], dx: 5 }] });
  await vi.advanceTimersByTimeAsync(20001);
  const { isError, text } = await pending;
  expect(isError).toBe(true);
  expect(text).toMatch(/saved state unconfirmed/i);
  expect(text).toMatch(/could not find.*root\/missing/i);
  expect(text).toMatch(name === "forma_create"
    ? /^unverified path\t[^\n]*\nroot\/missing\t/m
    : /^unverified paths: \["root\/missing"\]/m);
  expect(text).toMatch(/fix: .*forma_find.*before retrying/i);
  expect(await call("forma_read", { from: "last" })).toContain("'last' is empty");
});

it("returns an MCP error and labels paths when an undo save is unconfirmed", async () => {
  const mock = mockForma();
  const { call, callResult } = await connect(mock);
  const moved = await callResult("forma_edit", { ops: [{ op: "move", paths: [mock.paths.b1], dx: 5 }] });
  expect(moved.isError).toBeUndefined();
  expect(moved.text).toMatch(/^paths: /m);

  mock.F.elements.batch = async ({ operations }: { operations: unknown[] }) =>
    operations.map(() => ({ path: "root/missing" }));
  mock.F.udm.awaitPersisted = () => new Promise(() => {});
  vi.useFakeTimers();
  const pending = callResult("forma_edit", { undo: 1 });
  await vi.advanceTimersByTimeAsync(20001);

  const { isError, text } = await pending;
  expect(isError).toBe(true);
  expect(text).toMatch(/saved state unconfirmed/i);
  expect(text).toMatch(/^unverified paths: .*root\/missing/m);
  expect(text).toMatch(/fix: .*forma_find.*before retrying/i);
  expect(await call("forma_read", { from: "last" })).toContain("'last' is empty");
});

it("returns normal results for confirmed creates, edits and undos", async () => {
  const { call, callResult } = await connect();
  const created = await callResult("forma_create", { items: [{ rect: [42, 10, 5, 5], name: "Saved block" }] });
  expect(created.isError).toBeUndefined();
  expect(created.text).toMatch(/^path\t/m);
  expect(await call("forma_read", { from: "last" })).toContain("Saved block");

  const edited = await callResult("forma_edit", { ops: [{ op: "move", from: "last", dx: 5 }] });
  expect(edited.isError).toBeUndefined();
  expect(edited.text).toMatch(/^paths: /m);

  const undone = await callResult("forma_edit", { undo: 1 });
  expect(undone.isError).toBeUndefined();
  expect(undone.text).toMatch(/^undone: \["edit move"\]/m);
  expect(undone.text).toMatch(/^paths: /m);
});

it("keeps a verified last handle even when Forma has not confirmed saving", async () => {
  const mock = mockForma();
  mock.F.udm.awaitPersisted = async () => { throw new Error("timeout"); };
  const { call, callResult } = await connect(mock);
  const { isError, text } = await callResult("forma_create", { items: [{ rect: [42, 10, 5, 5], name: "Visible block" }] });
  expect(isError).toBe(true);
  expect(text).toMatch(/saved state unconfirmed/i);
  expect(text).toContain("Visible elements: handle 'last'.");
  expect(await call("forma_read", { from: "last" })).toContain("Visible block");
});

it("blocks writes after one unreadable save readback and recovers after a successful read", async () => {
  const mock = mockForma();
  const { F, calls, paths } = mock;
  const get = F.elements.get;
  let readable = true;
  F.elements.get = vi.fn((args) => readable ? get(args) : Promise.reject(new Error("not_found")));
  const batch = F.elements.batch;
  F.elements.batch = async (args: unknown) => {
    const result = await batch(args);
    readable = false;
    return result;
  };
  F.udm.awaitPersisted = () => new Promise(() => {});
  const { call, callResult } = await connect(mock, "prop1");
  vi.useFakeTimers();
  const input = { items: [{ rect: [42, 10, 5, 5] }] };
  const pending = callResult("forma_create", input);
  await vi.advanceTimersByTimeAsync(1);
  F.elements.get.mockClear();
  await vi.advanceTimersByTimeAsync(20000);
  const { isError, text } = await pending;
  expect(isError).toBe(true);
  expect(text).toMatch(/Saved state unconfirmed.*could not be read back/);
  expect(text).toMatch(/fix: Reload the Forma page .*check with forma_find before retrying\.$/);
  expect(F.elements.get).toHaveBeenCalledTimes(1);
  const stale = /Forma isn't saving changes from this page\.\nfix: Reload the Forma page \(or open the design option directly\), reopen the Forma MCP panel, then check with forma_find before retrying\.$/;
  expect(await call("forma_create", input)).toMatch(stale);
  expect(await call("forma_edit", { ops: [{ op: "floors", path: paths.b1, floors: 2 }] })).toMatch(stale);
  expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(1);
  expect(calls.some(({ fn }) => fn === "createFromFloors")).toBe(false);

  readable = true;
  F.elements.batch = batch;
  F.udm.awaitPersisted = async () => {};
  expect(await call("forma_find", { category: "building" })).toContain("3 matches");
  expect(await call("forma_create", input)).toMatch(/^created 1/);
});

it("resolves the session kind and tree again after a proposal switch", async () => {
  const { F, paths, children } = mockForma();
  const ops = new Ops(F);
  expect(await ops.sessionKind()).toBe("proposal");
  await ops.getTree();
  F.proposal.switch = async () => {
    await ops.getTree();
    children.find((child) => `root/${child.key}` === paths.b1)!.name = "New option block";
    F.proposal.getId = async () => { throw new Error("UDM session"); };
  };
  expect(await ops.site({ action: "switch", id: "prop2" })).toMatchObject({ switched: "prop2" });
  expect(await ops.sessionKind()).toBe("udm");
  expect((await ops.getTree()).get(paths.b1)?.name).toBe("New option block");
});

it("locks writes and inactive deletion by proposal ID, and rejects a project ID", async () => {
  const mock = mockForma();
  mock.F.proposal.delete = async () => {};
  const active = await connect(mock, "prop1");
  const input = { items: [{ rect: [42, 10, 5, 5] }] };
  expect(await active.call("forma_create", input)).toMatch(/^created 1/);
  const locked = await connect(mock, "prop2");
  expect(await locked.call("forma_site", { action: "delete_proposal", id: "prop2", confirm: true })).toContain("deleted");
  const wrong = await connect(mock, "proj");
  expect(await wrong.call("forma_create", input)).toMatch(/write blocked[\s\S]*fix: .*forma_site/);
});

it.each([
  ["forma_create", "create", { items: [{ rect: [42, 10, 5, 5] }] }],
  ["forma_edit", "edit", { ops: [{ op: "move", category: "building", dx: 1 }] }],
] as const)("%s previews obey the proposal lock and dispatch read-only", async (tool, op, input) => {
  const mock = mockForma();
  const locked = await connect(mock, "prop2");
  const blocked = await locked.call(tool, { ...input });
  expect(blocked).toMatch(/write blocked[\s\S]*fix: .*forma_site/);
  expect(await locked.call(tool, { ...input, preview: true })).toBe(blocked);
  expect(locked.dispatch.mock.calls.some(([name]) => name === op)).toBe(false);

  const active = await connect(mock, "prop1");
  expect(await active.call(tool, { ...input, preview: true })).toMatch(/^preview/);
  expect(active.dispatch).toHaveBeenCalledWith(op, expect.objectContaining({ preview: true }), expect.objectContaining({ write: false }));
  expect(mock.calls).toHaveLength(0);
});

it("declares the full find scope and reports targets even when a copy makes more elements", async () => {
  const { call } = await connect();
  expect(await call("forma_find", { category: "building", limit: 1 })).toContain("r1: 2 matches (showing 1) — from:'r1' targets all 2");
  const args = { ops: [{ op: "copy", from: "r1", count: 3, dx: 5 }] };
  expect(await call("forma_edit", { ...args, preview: true })).toContain("from:'r1' targets 2 elements");
  expect(await call("forma_edit", args)).toContain("from:'r1' targets 2 elements");
});

it("rejects unknown fields on all MCP tools and suggests obvious nested corrections", async () => {
  const { call, client } = await connect();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const result = await call(tool.name, { unexpectedField: true });
    expect(result, tool.name).toMatch(/unexpectedField[\s\S]*fix: /);
  }
  expect(await call("forma_create", { items: [{ rect: [0, 0, 5, 5], tiers: [{ floors: 1, floorHeigth: 4 }] }] }))
    .toMatch(/items\[0\]\.tiers\[0\].*floorHeigth.*did you mean floorHeight\?\)\.\nfix: Correct the field name or remove it from the request\.$/i);
  expect(await call("forma_view", { action: "capture", width: "wide" })).toMatch(/width: .*number.*\nfix: /i);
  expect(await call("forma_edit", { ops: [{ op: "move", from: "selection", dxx: 1 }] })).toMatch(/dxx[\s\S]*did you mean dx/i);
});

it("accepts the original two-point polygon input for creating a line", async () => {
  const { call } = await connect();
  expect(await call("forma_create", { items: [{ type: "line", polygon: [[0, 0], [10, 0]] }], preview: true }))
    .toMatch(/^preview/);
});

it("returns working examples for missing create items and edit operations", async () => {
  const { call } = await connect();
  for (const name of ["forma_create", "forma_edit"]) {
    const error = await call(name, {});
    const example = error.match(/fix: .*?(\{.*\})/)?.[1];
    expect(example, error).toBeTruthy();
    if (!example) throw new Error(error);
    expect(await call(name, JSON.parse(example))).toContain("preview");
  }
});

it("rejects self-crossing footprints before any geometry is written", async () => {
  const mock = mockForma();
  const { call } = await connect(mock);
  const result = await call("forma_create", { items: [{ rect: [42, 10, 5, 5] }, { polygon: [[0, 0], [8, 5], [0, 6], [5, 0]] }] });
  expect(result).toMatch(/items\[1\].*self-intersect[\s\S]*fix: /i);
  expect(mock.calls).toHaveLength(0);
});

it("warns about off-site footprints and overlapping context buildings in preview and create", async () => {
  const mock = mockForma();
  mock.footprints.set(mock.children[1].urn, [[55, 12], [65, 12], [65, 22], [55, 22]]);
  const { call } = await connect(mock);
  const args = { items: [{ name: "Boundary block", rect: [56, 14, 8, 5] }, { name: "Outside block", rect: [80, 80, 5, 5] }] };
  for (const preview of [true, false]) {
    const result = await call("forma_create", { ...args, preview });
    expect(result).toMatch(/Boundary block.*partly outside.*site boundary/i);
    expect(result).toMatch(/Boundary block.*overlaps.*Block A/i);
    expect(result).toMatch(/Outside block.*fully outside.*site boundary/i);
  }
});

it("reports the same measured footprint area on create and find when Forma changes the geometry", async () => {
  const { F } = mockForma();
  const get = F.geometry.getFootprint;
  F.geometry.getFootprint = ({ path }: { path: string }) => path === "root/k6"
    ? Promise.resolve({ type: "Polygon", coordinates: [[40, 20], [45, 20], [45, 26], [40, 26]] })
    : get({ path });
  const ops = new Ops(F);
  const made = await ops.create({ items: [{ rect: [40, 20, 5, 5] }] });
  const found = await ops.find({ paths: made.paths, fields: ["area"] });
  expect(found.rows[0][4]).toBe(30);
  expect(made.items[0]).toMatchObject({ footprint: found.rows[0][4] });
});

it("keeps a historical sun result separate from current-scene calculations", async () => {
  const { F } = mockForma();
  F.analysis.getGroundGrid = async () => { throw new Error("Missing texture metadata"); };
  F.analysis.getSunAnalysis = async () => ({ parameters: { sunDate: { month: 6, date: 21 } } });
  const ops = new Ops(F);
  const result = await ops.analysis({ action: "result", id: "a1" });
  expect(result).toMatchObject({ status: "SUCCEEDED", grid: "not shared by Forma", next: expect.stringMatching(/Analyze panel.*current-scene.*sun_hours/i) });
  expect(result).not.toHaveProperty("median");
  expect(await ops.analysis({ action: "sun_hours", show: false })).toMatchObject({ scope: "current-scene" });
});

it("polls noise through the SDK's direct lookup before it appears in the list", async () => {
  const { F } = mockForma();
  const record = { analysisId: "a3", analysisType: "noise", status: "SUCCEEDED" };
  F.analysis.getNoiseAnalysis = vi.fn().mockRejectedValueOnce(new Error("not found")).mockResolvedValue(record);
  const ops = new Ops(F);
  expect(await ops.analysis({ action: "noise" })).toMatchObject({ next: expect.stringMatching(/noise/i) });
  expect(await ops.analysis({ action: "result", id: "a3" })).toMatchObject({ status: "registering", next: expect.stringMatching(/poll again/i) });
  expect(await ops.analysis({ action: "result", id: "a3" })).toMatchObject({ type: "noise", status: "SUCCEEDED", cells: 8 });
  expect(F.analysis.getNoiseAnalysis).toHaveBeenCalledWith({ analysisId: "a3" });
});

it("finds a listed noise result by ID after the panel has reconnected", async () => {
  const { F } = mockForma();
  const noise = { analysisId: "a3", analysisType: "noise", status: "SUCCEEDED", proposalId: "prop1", createdAt: 1 };
  F.analysis.list = async ({ analysisTypes }: { analysisTypes?: string[] }) => analysisTypes?.includes("noise") ? [noise] : [];
  F.analysis.getNoiseAnalysis = async () => { throw new Error("not found"); };
  const ops = new Ops(F);
  expect(await ops.analysis({ action: "result", id: "a3" })).toMatchObject({ status: "SUCCEEDED", type: "noise" });
  expect(await ops.analysis({ action: "list" })).toMatchObject({ rows: [["a3", "noise", "SUCCEEDED", expect.any(String)]] });
});

it("marks site-wide FAR and coverage when check is scoped to one building", async () => {
  const { F, paths } = mockForma();
  const result = await new Ops(F).check({ paths: [paths.b1], rules: { maxFar: 1, maxCoverage: 60 } });
  expect(result.note).toMatch(/FAR and coverage.*site-wide/i);
  expect(result.summary.buildings).toBe(1);
});

it("keeps the full-site alias in scoped checks and reports", async () => {
  const { F, paths, children } = mockForma();
  children[1].name = children[2].name = "Building 1";
  const ops = new Ops(F);
  const rules = { maxHeight: 1 };
  const full = await ops.check({ rules });
  const scoped = await ops.check({ paths: [paths.b2], rules });
  const expected = { path: paths.b2, name: "Building B (9 m)" };
  expect(full.violations).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  expect(scoped.violations).toEqual([expect.objectContaining(expected)]);
  expect((await ops.report({ paths: [paths.b2] })).buildings).toEqual([expect.objectContaining(expected)]);
});

it("resolves building aliases before filtering and shows them in MCP find results", async () => {
  const mock = mockForma();
  mock.children[1].name = mock.children[2].name = "Building 1";
  const { call } = await connect(mock);
  for (const name of ["Building A", "building a", "A", "Building A (21 m)"]) {
    const result = await call("forma_find", { name });
    expect(result).toContain("1 match");
    expect(result).toMatch(/path.*alias/);
    expect(result).toContain(mock.paths.b1);
    expect(result).toContain("Building A");
    expect(result).not.toContain(mock.paths.b2);
  }
  expect(await call("forma_find", { name: "A", paths: [mock.paths.b2] })).toContain("0 matches");
  expect(await call("forma_find", { name: "Building 1" })).toContain("2 matches");
});

it("exports per-building floor area by use in CSV and HTML", async () => {
  const { F } = mockForma();
  const calculate = F.areaMetrics.calculate;
  F.areaMetrics.calculate = async () => {
    const m = await calculate();
    m.builtInMetrics.grossFloorArea.functionBreakdown[0].value = 2664;
    m.builtInMetrics.grossFloorArea.functionBreakdown[1] = { functionId: "com", functionName: "Commercial", functionColor: "", value: 394 };
    return m;
  };
  const report = await new Ops(F).report({});
  const csv = toCsv(report);
  expect(csv).toContain("Use;Uses;");
  expect(csv).toContain('Residential;"Residential 2,664 m² · Commercial 394 m²"');
  expect(toHtml(report)).toContain("<td>Residential 2,664 m² · Commercial 394 m²</td>");
});

it("preserves report pairs across same-second runs and skips an occupied CSV name", () => {
  const report = { buildings: [{ name: "First block" }] };
  const dir = mkdtempSync(join(tmpdir(), "forma-stress-report-"));
  try {
    const when = new Date("2026-11-20T11:03:18Z");
    const first = saveReport(report, dir, when);
    expect(first.html).toMatch(/11-03-18\.html$/);
    const csv = readFileSync(first.csv, "utf8");
    writeFileSync(first.csv.replace(/\.csv$/, "-2.csv"), "keep this report");
    const next = saveReport({ ...report, buildings: [] }, dir, when);
    expect(next.csv).toMatch(/11-03-18-3\.csv$/);
    expect(readFileSync(first.csv, "utf8")).toBe(csv);
    expect(readFileSync(first.csv.replace(/\.csv$/, "-2.csv"), "utf8")).toBe("keep this report");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

it("guides the assistant to preview, verify both clearances, and explain when a building will not fit", () => {
  expect(wrapPrompt("Place a building")).toMatch(/placing or moving.*preview.*forma_check.*minSetback.*minSpacing.*measured free space/i);
});

it("guides the assistant to resolve report and check aliases before asking", () => {
  expect(wrapPrompt("How tall is Building A?")).toMatch(/Building A.*checks and reports.*forma_find.*before asking/i);
});
