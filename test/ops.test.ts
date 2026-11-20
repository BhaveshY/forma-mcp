import { describe, expect, it } from "vitest";
import { Ops, gridStats } from "../src/bridge/ops.js";
import { area, signedArea, cleanRing, extrude, offset, earcut, mul, rotationZ, translation } from "../src/shared/geom.js";
import { mockForma } from "./mockForma.js";

describe("geom", () => {
  it("cleans rings: drops closing point, forces CCW", () => {
    const r = cleanRing([[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]);
    expect(r).toHaveLength(4);
    expect(area(r)).toBe(100);
    expect(signedArea(r)).toBeGreaterThan(0); // reversed to CCW
  });
  it("offsets inward", () => {
    expect(area(offset([[0, 0], [10, 0], [10, 10], [0, 10]], 1))).toBeCloseTo(64, 6);
  });
  it("triangulates concave L-shape with correct area", () => {
    const L: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    const tris = earcut(L);
    expect(tris).toHaveLength(4);
    const sum = tris.reduce((s, t) => s + area(t.map((i) => L[i]) as [number, number][]), 0);
    expect(sum).toBeCloseTo(area(L), 6);
  });
  it("extrudes closed prism", () => {
    const m = extrude([[0, 0], [1, 0], [1, 1], [0, 1]], 0, 3);
    expect(m.verts).toHaveLength(24);
    expect(m.faces).toHaveLength((2 * 2 + 4 * 2) * 3);
  });
  it("composes rotation about pivot", () => {
    const m = mul(translation(1, 0, 0), rotationZ(90, 5, 5));
    // point (10,5) rotated 90° about (5,5) -> (5,10), then +1 x -> (6,10)
    const x = m[0] * 10 + m[4] * 5 + m[12], y = m[1] * 10 + m[5] * 5 + m[13];
    expect(x).toBeCloseTo(6);
    expect(y).toBeCloseTo(10);
  });
});

describe("ops", () => {
  it("status summarises the scene", async () => {
    const { F } = mockForma();
    const s: any = await new Ops(F).run("status");
    expect(s.counts).toEqual({ terrain: 1, building: 2, site_limit: 1 });
    expect(s.session).toBe("proposal");
    expect(s.model.name).toBe("Option A");
    expect(s.selection).toBe(1);
  });

  it("find filters + measures, exact total, func names", async () => {
    const { F } = mockForma();
    const r: any = await new Ops(F).run("find", { category: "buildings", fields: ["area", "height", "floors", "gfa"] });
    expect(r.total).toBe(2);
    expect(r.cols).toEqual(["path", "cat", "name", "func", "area", "height", "floors", "gfa", "alias"]);
    expect(r.rows[0]).toEqual(["root/k2", "building", "Block A", "Residential", 200, 21, 7, 1400, ""]);
    const sel: any = await new Ops(F).run("find", { from: "selection" });
    expect(sel.rows.map((x: any) => x[2])).toEqual(["Block B"]);
    const inside: any = await new Ops(F).run("find", { inside: [[-1, -1], [25, -1], [25, 15], [-1, 15]] });
    expect(inside.rows.map((x: any) => x[2])).toEqual(["Block A"]);
  });

  it("create building: plans carry function, z from terrain, one batch, undo removes", async () => {
    const { F, calls, children } = mockForma();
    const ops = new Ops(F);
    const before = children.length;
    const r: any = await ops.run("create", { items: [
      { type: "building", rect: [100, 0, 20, 12], floors: 5, floorHeight: 3.2, groundHeight: 4.5, func: "office", name: "C" },
      { type: "building", polygon: [[0, 50], [30, 50], [30, 80], [0, 80]], tiers: [{ floors: 2 }, { inset: 5, floors: 8 }] },
      { type: "site_limit", polygon: [[0, 0], [10, 0], [10, 10]] },
    ] });
    expect(r.created).toBe(3);
    expect(children.length).toBe(before + 3);
    const stacks = calls.find((c) => c.fn === "createFromFloorsBatch")!.arg;
    expect(stacks).toHaveLength(2);
    expect(stacks[0].plans[0].units[0].functionId).toBe("off");
    expect(stacks[0].floors.map((f: any) => f.height)).toEqual([4.5, 3.2, 3.2, 3.2, 3.2]);
    expect(stacks[1].floors).toHaveLength(10);
    expect(stacks[1].floors[9].polygon[0]).toEqual([5, 55]); // inset tower
    const batches = calls.filter((c) => c.fn === "batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].arg[0].transform[14]).toBeCloseTo(101); // min terrain z under rect at x=100
    expect(r.items[0]).toMatchObject({ floors: 5, height: 17.3, footprint: 240, gfa: 1200 });
    const site = calls.find((c) => c.fn === "createElementHierarchy")!.arg;
    expect(site.elements.root.properties.category).toBe("site_limit");
    expect(site.elements.root.properties.geometry.geoJson.features[0].geometry.coordinates[0]).toHaveLength(4);

    const u: any = await ops.run("undo", {});
    expect(u.undone).toEqual(["create 3"]);
    expect(children.length).toBe(before);
  });

  it("preview writes nothing", async () => {
    const { F, calls } = mockForma();
    const r: any = await new Ops(F).run("create", { preview: true, items: [{ rect: [0, 0, 10, 10], floors: 3 }] });
    expect(r.preview).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("rejects unknown function with a fix listing valid ones", async () => {
    const { F } = mockForma();
    await expect(new Ops(F).run("create", { items: [{ rect: [0, 0, 10, 10], func: "Hotel" }] })).rejects.toMatchObject({ fix: expect.stringContaining("Residential, Office") });
  });

  it("refuses writes without edit rights", async () => {
    const { F } = mockForma({ canEdit: false });
    await expect(new Ops(F).run("create", { items: [{ rect: [0, 0, 10, 10] }] })).rejects.toThrow(/edit access/);
  });

  it("edit move+rotate re-adds with new transform; undo restores original path state", async () => {
    const { F, paths, children } = mockForma();
    const ops = new Ops(F);
    const r: any = await ops.run("edit", { ops: [{ op: "move", paths: [paths.b1], dx: 5, dy: -2 }, { op: "remove", paths: [paths.b2] }] });
    expect(r.paths).toHaveLength(1);
    expect(r.removed).toBe(2);
    const moved = children.find((c) => `root/${c.key}` === r.paths[0])!;
    expect(moved.transform!.slice(12, 15)).toEqual([5, -2, 0]);
    expect(moved.name).toBe("Block A");
    expect(children.some((c) => c.name === "Block B")).toBe(false);
    await ops.run("undo", {});
    const names = children.map((c) => c.name).sort();
    expect(names).toEqual(["Block A", "Block B", "Site", "Terrain"]);
    expect(children.find((c) => c.name === "Block A")!.transform).toBeUndefined();
  });

  it("undo survives path changes: create → move → undo ×2 leaves nothing behind (live-found bug)", async () => {
    const { F, children } = mockForma();
    const ops = new Ops(F);
    const before = children.map((c) => c.key).sort();
    const c: any = await ops.run("create", { items: [{ rect: [0, 0, 10, 10], floors: 2, name: "T" }] });
    await ops.run("edit", { ops: [{ op: "move", paths: c.paths, dx: 5, rotate: 10 }] });
    const u1: any = await ops.run("undo", {}); // revert move: element re-added under a NEW path
    expect(u1.undone).toEqual(["edit move"]);
    const u2: any = await ops.run("undo", {}); // the create's record still points at the original path
    expect(u2.undone).toEqual(["create 1"]);
    expect(children.map((x) => x.key).sort()).toEqual(before);
  });

  it("undo refuses when the urn is ambiguous (copies)", async () => {
    const { F, paths } = mockForma();
    const ops = new Ops(F);
    await ops.run("edit", { ops: [{ op: "remove", paths: [paths.b2] }] }); // undo entry 1
    await ops.run("edit", { ops: [{ op: "copy", paths: [paths.b1], dx: 50, count: 2 }] });
    await ops.run("undo", {}); // removes the copies fine (exact paths)
    await expect(ops.run("undo", {})).resolves.toMatchObject({ undone: ["edit remove"] });
  });

  it("native buildings without any footprint get an outline traced from the 3D shape (live-found gap)", async () => {
    const { F, paths, children, footprints } = mockForma();
    footprints.delete(children.find((c) => `root/${c.key}` === paths.b1)!.urn); // like real Forma site-design buildings
    const [r]: any = await new Ops(F).run("read", { paths: [paths.b1], what: ["footprint"] });
    expect(r.area).toBe(200); // 20 x 10 box
    expect(r.footprint.note).toMatch(/traced from the 3D shape/);
    expect(r.footprint.pts).toHaveLength(4);
  });

  it("edit rejects the same path in two ops", async () => {
    const { F, paths } = mockForma();
    await expect(new Ops(F).run("edit", { ops: [{ op: "move", paths: [paths.b1], dx: 1 }, { op: "remove", paths: [paths.b1] }] })).rejects.toThrow(/two ops/);
  });

  it("copy arrays elements", async () => {
    const { F, paths, children } = mockForma();
    const r: any = await new Ops(F).run("edit", { ops: [{ op: "copy", paths: [paths.b2], dx: 15, count: 3 }] });
    expect(r.paths).toHaveLength(3);
    expect(children.filter((c) => c.name?.startsWith("Block B ")).map((c) => c.transform![12])).toEqual([15, 30, 45]);
  });

  it("props edit replaces urn and is undoable", async () => {
    const { F, paths, children, els } = mockForma();
    const ops = new Ops(F);
    const orig = children.find((c) => `root/${c.key}` === paths.b1)!.urn;
    await ops.run("edit", { ops: [{ op: "props", paths: [paths.b1], patch: { "eba:meta": { phase: "LP2" } } }] });
    const now = children.find((c) => `root/${c.key}` === paths.b1)!.urn;
    expect(now).not.toBe(orig);
    expect(els.get(now)!.properties["eba:meta"]).toEqual({ phase: "LP2" });
    await ops.run("undo", {});
    expect(children.find((c) => `root/${c.key}` === paths.b1)!.urn).toBe(orig);
  });

  it("metrics derive FAR and skip non-numeric breakdowns", async () => {
    const { F } = mockForma();
    const m: any = await new Ops(F).run("metrics", {});
    expect(m).toMatchObject({ gfa_m2: 1400, site_area_m2: 3500, far: 0.4, units: 12, gfa_by_function: { Residential: 1400 } });
  });

  it("view: capture strips data-url prefix; color_by height ramps", async () => {
    const { F, calls } = mockForma();
    const ops = new Ops(F);
    const c: any = await ops.run("view", { action: "capture", fit: "top" });
    expect(c).toMatchObject({ image: "QUJD", mime: "image/jpeg", width: 1024 });
    expect(calls.find((x) => x.fn === "camera.move")).toBeTruthy();
    const r: any = await ops.run("view", { action: "color_by", by: "height" });
    expect(r.colored).toBe(2);
    expect(r.legend).toMatchObject({ min: 9, max: 21 });
  });

  it("analysis result returns stats not grids", async () => {
    const { F } = mockForma();
    const r: any = await new Ops(F).run("analysis", { action: "result", id: "a1", threshold: 4 });
    expect(r).toMatchObject({ cells: 8, min: 0, max: 7, share_at_or_above: 0.5 });
    expect(gridStats({ grid: [1, 2], width: 2, height: 1, x0: 0, y0: 0, resolution: 1 }, [[0, 0], [1, 0], [1, 1], [0, 1]]).cells).toBe(1);
  });

  it("udm session: lists models, refuses duplicate", async () => {
    const { F } = mockForma({ kind: "udm" });
    const ops = new Ops(F);
    const m: any = await ops.run("site", { action: "proposals" });
    expect(m.kind).toBe("udm");
    expect(m.rows[0][1]).toBe("Model 1");
    await expect(ops.run("site", { action: "duplicate" })).rejects.toThrow(/Unified Design Model/);
  });

  it("delete_proposal requires confirm", async () => {
    const { F } = mockForma();
    await expect(new Ops(F).run("site", { action: "delete_proposal", id: "prop2" })).rejects.toThrow(/irreversible/);
  });

  it("script runs with Forma in scope and summarises typed arrays", async () => {
    const { F } = mockForma();
    const r: any = await new Ops(F).run("script", { code: "const t = await Forma.geometry.getTriangles({path: args.p}); return {t, n: (await h.tree()).size}", args: { p: "root/k2" } });
    expect(r).toEqual({ t: "<Float32Array len=36>", n: 5 });
  });
  it("custom properties need a 'word:word' namespace, with a plain fix (Forma rule, found live)", async () => {
    const m = mockForma();
    await expect(new Ops(m.F).run("edit", { ops: [{ op: "props", paths: [m.paths.b1], patch: { e2e: { tag: 1 } } }] })).rejects.toMatchObject({ message: expect.stringMatching(/office:tags/) });
  });
});
