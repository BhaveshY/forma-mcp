// Planning-rule check and report ops through the real Ops code against the mock Forma scene:
// site 70×50 m; Block A 20×10 m, 21 m tall at (0,0); Block B 10×10 m, 9 m tall at (30,0).
import { describe, expect, it } from "vitest";
import { Ops } from "../src/bridge/ops.js";
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
});
