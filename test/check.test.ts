// Planning-rule check and report ops through the real Ops code against the mock Forma scene:
// site 70×50 m; Block A 20×10 m, 21 m tall at (0,0); Block B 10×10 m, 9 m tall at (30,0).
import { describe, expect, it } from "vitest";
import { Ops } from "../src/bridge/ops.js";
import { rect } from "../src/shared/geom.js";
import { toCsv, toFiguresCsv, toHtml } from "../src/server/report.js";
import { mockForma } from "./mockForma.js";

describe("check op", () => {
  it("measures the real buildings and reports each broken limit", async () => {
    const { F } = mockForma();
    const r: any = await new Ops(F).run("check", { rules: { maxHeight: 15, minSetback: 12, minSpacing: 12 } });
    expect(r.ok).toBe(false);
    expect(r.violations.filter((v: any) => v.rule === "maxHeight").map((v: any) => v.name)).toEqual(["Block A"]);
    expect(r.violations.find((v: any) => v.rule === "minSpacing").actual).toBeCloseTo(10);
    expect(r.violations.filter((v: any) => v.rule === "minSetback")).toHaveLength(2); // both 10 m from the boundary
    expect(r.summary.tallest_m).toBeCloseTo(21);
  });

  it("show:true colours problem buildings red and the rest green, without changing the design", async () => {
    const { F, calls } = mockForma();
    const before = calls.filter((c: any) => c.fn === "batch").length;
    const r: any = await new Ops(F).run("check", { rules: { maxHeight: 15 }, show: true });
    expect(r.note).toMatch(/red/);
    expect(calls.filter((c: any) => c.fn === "batch").length).toBe(before);
  });

  it("asks for rules instead of guessing", async () => {
    const { F } = mockForma();
    await expect(new Ops(F).run("check", {})).rejects.toThrow(/no rules/);
  });

  it("report lists every building on the site with its figures", async () => {
    const { F } = mockForma();
    const r: any = await new Ops(F).run("report", { rules: { maxHeight: 30 } });
    expect(r.buildings.map((b: any) => b.name).sort()).toEqual(["Block A", "Block B"]);
    expect(r.buildings.find((b: any) => b.name === "Block A").footprint_m2).toBe(200);
    expect(r.buildings.every((b: any) => b.use === "Residential")).toBe(true); // from Forma's per-building breakdown
    expect(r.check.ok).toBe(true);
  });

  it("reads a named zone from the element tree and checks GRZ, GRZ II, GFZ and storeys", async () => {
    const { F } = mockForma({ zones: [{ name: "Baufenster", ring: rect(0, 0, 37, 10) }, { name: "East", ring: rect(30, 0, 10, 10) }] });
    const ops = new Ops(F);
    const rules = { maxGrz: 0.1, maxGfz: 0.4, maxFullStoreys: 6, nonFullTopFloors: 1, insideZone: true };
    const all = await ops.check({ rules });
    expect(all.ok).toBe(true);
    expect(all.summary).toMatchObject({ grz: 300 / 3500, grz2: 0.1, gfz: 0.4, max_full_storeys: 6, zone: "Baufenster, East" });
    const named = await ops.check({ rules: { ...rules, zone: "baufenster" } });
    expect(named.summary.zone).toBe("Baufenster");
    expect(named.violations).toEqual([expect.objectContaining({ rule: "insideZone", name: "Block B", actual: 3 })]);
  });

  it("keeps ratios site-wide with a building selected and lets entered ancillary area override parking", async () => {
    const { F, paths } = mockForma();
    const result = await new Ops(F).check({ paths: [paths.b2], rules: { maxGrz: 0.1, ancillaryArea_m2: 100, maxGfz: 1, maxFullStoreys: 3 } });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ buildings: 1, grz: 300 / 3500, grz2: 400 / 3500, gfz: 1700 / 3500, max_full_storeys: 3 });
  });

  it("gives the missing zone fix and accepts an explicit zone polygon", async () => {
    const { F } = mockForma();
    const ops = new Ops(F);
    await expect(ops.check({ rules: { insideZone: true } })).rejects.toMatchObject({
      message: "no building zone drawn", fix: "Draw it in Forma with Limits > Zone, then run the check again.",
    });
    const r = await ops.check({ rules: { insideZone: true, zoneRing: rect(0, 0, 40, 10) } });
    expect(r.ok).toBe(true);
    expect(r.summary.zone).toBe("Supplied polygon");
  });

  it("exports the German planning figures and the storey assumption to HTML and CSV", async () => {
    const { F } = mockForma();
    const r = await new Ops(F).report({ rules: { maxGrz: 0.4, maxGfz: 1, nonFullTopFloors: 1 } });
    expect(r.buildings.map((b) => [b.name, b.full_storeys])).toEqual([["Block A", 6], ["Block B", 2]]);
    const html = toHtml(r);
    const buildingCsv = toCsv(r);
    const figuresCsv = toFiguresCsv(r);
    for (const text of [html, figuresCsv]) {
      for (const label of ["Site coverage (GRZ)", "Floor area ratio (GFZ)", "The top floor is excluded"]) {
        expect(text).toContain(label);
      }
    }
    expect(buildingCsv).toContain("Full storeys (Vollgeschosse)");
    expect(figuresCsv).toContain("Floor area ratio (GFZ);0.4");
  });
});
