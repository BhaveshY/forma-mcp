import { describe, expect, it } from "vitest";
import { stackFromInternal } from "../src/shared/floors.js";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "./mockForma.js";

// Shape of Forma's internal basic-building record (verified live on a Site Design building).
const sq = (id: string, cw = false) => {
  const v = { a: { id: "a", x: 0, y: 0 }, b: { id: "b", x: 10, y: 0 }, c: { id: "c", x: 10, y: 10 }, d: { id: "d", x: 0, y: 10 } };
  return { id, height: id === "f0" ? 5.16 : 3, graph: { vertices: v, edges: {} }, spaces: { s1: { id: "s1", polygon: cw ? ["a", "d", "c", "b"] : ["a", "b", "c", "d"], holes: [] } } };
};
const record = (n: number) => ({
  floors: Array.from({ length: n }, (_, i) => sq(`f${i}`, i === 2)),
  units: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, functionId: i === 0 ? "commercial" : "residential", spaces: [{ floorId: `f${i}`, spaceId: "s1" }] })),
});

describe("rebuild floors", () => {
  it("drops the top floors, keeps heights, uses and CCW outlines", () => {
    const r = stackFromInternal(record(11), 8);
    expect(r.floors).toHaveLength(8);
    expect(r.floors[0]).toEqual({ planId: "f0", height: 5.16 });
    expect(r.floors[7].planId).toBe("f7");
    expect(r.plans.map((p) => p.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"]);
    expect(r.plans[0].units[0].functionId).toBe("commercial");
    const p = r.plans[2], at = new Map(p.vertices.map((v) => [v.id, v]));
    const ids = p.units[0].polygon;
    let a = 0;
    for (let i = 0; i < ids.length; i++) { const u = at.get(ids[i])!, w = at.get(ids[(i + 1) % ids.length])!; a += u.x * w.y - w.x * u.y; }
    expect(a).toBeGreaterThan(0); // clockwise input was turned counter-clockwise
  });
  it("vertex ids are unique across all floors (Forma rejects duplicates — found live)", () => {
    const r = stackFromInternal(record(4), 6);
    const ids = r.plans.flatMap((p) => p.vertices.map((v) => v.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9-]{2,20}$/); // Forma's id rule (found live)
    for (const p of r.plans) for (const u of p.units) for (const id of u.polygon) expect(p.vertices.some((v) => v.id === id)).toBe(true);
  });
  it("adds floors by repeating the top floor", () => {
    const r = stackFromInternal(record(3), 5);
    expect(r.floors.map((f) => f.planId)).toEqual(["f0", "f1", "f2", "f2", "f2"]);
  });
  it("refuses zero floors", () => {
    expect(() => stackFromInternal(record(3), 0)).toThrow(/1 to 200/);
  });
});

describe("ops: forma_edit op:floors", () => {
  it("replaces a basic building in place (one undo step) instead of deleting floor children", async () => {
    const m = mockForma();
    const urn = m.children.find((c) => `root/${c.key}` === m.paths.b1)!.urn;
    (m.els.get(urn) as any).representations = { __INTERNAL__: { type: "embedded-json", data: record(7) } };
    const ops = new Ops(m.F);
    const r: any = await ops.run("edit", { ops: [{ op: "floors", paths: [m.paths.b1], add: -3 }] });
    expect(r.applied[0]).toMatchObject({ op: "floors", from: 7, to: 4 });
    const call = m.calls.find((c) => c.fn === "createFromFloors")!;
    expect(call.arg.floors).toHaveLength(4);
    const batch = m.calls.filter((c) => c.fn === "batch").at(-1)!.arg;
    expect(batch).toEqual([expect.objectContaining({ type: "replace", path: m.paths.b1 })]);
    await ops.run("undo", {});
    expect(m.children.find((c) => `root/${c.key}` === m.paths.b1)!.urn).toBe(urn);
  });

  it("Building Design buildings are refused with a plain explanation (Forma regenerates them)", async () => {
    const m = mockForma();
    const c = m.children.find((x) => `root/${x.key}` === m.paths.b2)!;
    const urn = "urn:adsk-forma-elements:building-design:proj:abc_b_1:1";
    m.els.set(urn, { urn, properties: { category: "building" } });
    c.urn = urn;
    await expect(new Ops(m.F).run("edit", { ops: [{ op: "floors", paths: [m.paths.b2], add: 10 }] })).rejects.toMatchObject({ message: expect.stringMatching(/Building Design/) });
    expect(m.calls.some((x) => x.fn === "createFromFloors")).toBe(false);
  });
  it("if Forma ignores the change, it is rolled back and reported, never 'done'", async () => {
    const m = mockForma();
    const urn = m.children.find((c) => `root/${c.key}` === m.paths.b1)!.urn;
    (m.els.get(urn) as any).representations = { __INTERNAL__: { type: "embedded-json", data: record(7) } };
    const real = m.F.elements.floorStack.createFromFloors;
    m.F.elements.floorStack.createFromFloors = async (r: any) => { const out = await real(r); m.boxes.set(out.urn, m.boxes.get(urn) ?? [0, 0, 0, 20, 10, 21]); return out; };
    m.boxes.set(urn, [0, 0, 0, 20, 10, 21]);
    await expect(new Ops(m.F).run("edit", { ops: [{ op: "floors", paths: [m.paths.b1], add: 3 }] })).rejects.toMatchObject({ message: expect.stringMatching(/did not apply.*rolled back/) });
    expect(m.children.find((c) => `root/${c.key}` === m.paths.b1)!.urn).toBe(urn);
  });

  it("Building Design buildings are refused even when asked to replace them (shared across design options)", async () => {
    const m = mockForma();
    const c = m.children.find((x) => `root/${x.key}` === m.paths.b2)!;
    const old = "urn:adsk-forma-elements:building-design:proj:abc:1";
    m.els.set(old, { urn: old, properties: { category: "building" } });
    c.urn = old;
    await expect(new Ops(m.F).run("edit", { ops: [{ op: "floors", paths: [m.paths.b2], add: 6, replace_building_design: true }] })).rejects.toMatchObject({ message: expect.stringMatching(/Building Design/) });
    expect(m.children.some((x) => x.urn === old)).toBe(true);
  });
});
