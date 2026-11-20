import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ops } from "../src/bridge/ops.js";
import { wrapPrompt } from "../src/server/codex.js";
import { saveReport, toCsv, toFiguresCsv, toHtml } from "../src/server/report.js";
import { rect, signedArea, roadSurfaces, type P2 } from "../src/shared/geom.js";
import { checkRules } from "../src/shared/rules.js";
import { mockForma } from "./mockForma.js";

describe("German live-test regressions", () => {
  it("checks exterior neighbours without including them in plot metrics", async () => {
    const { F, paths, children, footprints, boxes } = mockForma();
    const a = children.find((c) => `root/${c.key}` === paths.b1)!;
    const b = children.find((c) => `root/${c.key}` === paths.b2)!;
    footprints.set(a.urn, rect(0, 21, 20, 10));
    boxes.set(a.urn, [0, 21, 0, 20, 31, 21]);
    // The neighbour's strip overlaps Block A and extends beyond its reserved area.
    footprints.set(b.urn, rect(17, 42, 10, 10));
    boxes.set(b.urn, [17, 42, 0, 27, 52, 18.8]);
    const ops = new Ops(F);
    const result = await ops.check({ rules: { abstand: {}, maxGrz: 1 } });
    expect(result.violations).toContainEqual(expect.objectContaining({ path: paths.b1, other: paths.b2 }));
    expect(result.summary.grz).toBeCloseTo(200 / 3500);
    const args = { action: "capacity", mode: "add", rules: { maxFullStoreys: 1, abstand: {} } };
    const near: any = await ops.run("check", args);
    expect(near.existing.footprint_m2).toBe(200);
    footprints.set(b.urn, rect(17, 100, 10, 10));
    boxes.set(b.urn, [17, 100, 0, 27, 110, 18.8]);
    const far: any = await ops.run("check", args);
    expect(far.best.buildable_m2 - near.best.buildable_m2).toBeGreaterThan(1);
  });

  it("names a neighbour with unreadable geometry and marks the check incomplete", async () => {
    const { F, paths } = mockForma();
    const footprint = F.geometry.getFootprint;
    const triangles = F.geometry.getTriangles;
    F.geometry.getTriangles = async (a: { path: string }) => a.path === paths.b2 ? new Float32Array() : triangles(a);
    F.geometry.getFootprint = async (a: { path: string }) => a.path === paths.b2 ? undefined : footprint(a);
    const ops = new Ops(F);
    const r = await ops.check({ paths: [paths.b1], rules: { abstand: {} } });
    expect(r.abstand).toMatchObject({ incomplete: true });
    expect(r.skipped.join(" ")).toContain("Block B");
    const args = { action: "capacity", mode: "add", create: true, rules: { abstand: {}, maxFullStoreys: 1 } };
    const preview = await ops.run("check", { ...args, preview: true });
    expect(preview).toMatchObject({
      incomplete: true,
      validated: false,
      note: expect.stringContaining("Not validated"),
      missingData: expect.arrayContaining([expect.stringContaining("Building footprints unavailable for: Block B")]),
      placement: { preview: true },
    });
    const result = await ops.run("check", args);
    expect(result).toMatchObject({ incomplete: true, note: expect.stringContaining("Not validated") });
    expect(result).not.toHaveProperty("placement");
  });

  it("subtracts native top-level areas aggregated from floor children", async () => {
    const { F } = mockForma({ nativeFloors: true });
    const ops = new Ops(F);
    const report = await ops.check({ rules: { maxGfz: 0.3, nonFullTopFloors: 1 } });
    expect(report.summary.gfz).toBeCloseTo(0.4, 10);
    expect(report.violations).toContainEqual(expect.objectContaining({ rule: "maxGfz", excess_m2: 350 }));
    const all = await ops.check({ rules: { maxGfz: 1 } });
    expect(all.summary.gfz).toBeCloseTo(1550 / 3500, 10);
  });

  it.each([{ germanFigures: true }, { rules: { abstand: { state: "BY" } } }])("reports actual German figures without limits for %j", async (args) => {
    const r = await new Ops(mockForma().F).report(args);
    expect(r).toMatchObject({ check: { summary: { grz: expect.any(Number), grz2: expect.any(Number), gfz: expect.any(Number) } } });
    for (const label of ["(GRZ)", "(GRZ II)", "(GFZ)"]) {
      expect(toHtml(r)).toContain(label);
      expect(toFiguresCsv(r)).toContain(label);
    }
    expect(wrapPrompt("Report Bavaria")).toMatch(/before claiming.*figures.*tool result/i);
  });

  it("sends Forma a closed counterclockwise polygon for every full ground strip", async () => {
    const { F, calls, paths } = mockForma();
    const report = await new Ops(F).check({ paths: [paths.b1], rules: { abstand: {} }, show: true });
    const features = calls.find((c) => c.fn === "geojson.add")?.arg.geojson.features;
    expect(features).toHaveLength(report.abstand!.strips.length);
    for (const [i, feature] of features.entries()) {
      const [ring] = feature.geometry.coordinates;
      expect(ring).toHaveLength(5);
      expect(ring[4]).toEqual(ring[0]);
      expect(signedArea(ring)).toBeCloseTo(Math.abs(signedArea(report.abstand!.strips[i].ring)));
    }
  });

  it("distinguishes a close ratio breach and retains exact values", () => {
    const r = checkRules({ buildings: [], plotArea: 1000, plotFootprint: 403.25, parkingArea: 0 }, { maxGrz: 0.4 });
    expect(r.summary.grz).toBe(0.40325);
    expect(r.violations[0]).toMatchObject({ actual: 0.40325, limit: 0.4, excess_m2: 3.25, text: expect.stringContaining("GRZ is 0.403 (limit 0.4)") });
  });

  it("previews and saves a footprint replacement once, preserves the building, and undoes it", async () => {
    const { F, calls, paths, children } = mockForma();
    const ops = new Ops(F);
    const original = structuredClone(children);
    const polygon = rect(0, 0, 12, 8);
    const opsArg = { ops: [{ op: "footprint", path: paths.b1, polygon }] };
    await expect(ops.edit({ ...opsArg, preview: true })).resolves.toMatchObject({ preview: true, ops: [{ to_m2: 96 }] });
    expect(calls.filter((c) => /batch|createFromFloors/.test(c.fn))).toHaveLength(0);
    await expect(ops.edit(opsArg)).resolves.toMatchObject({ pathsVerified: true });
    expect(calls.filter((c) => c.fn === "batch").map((c) => c.arg)).toEqual([[expect.objectContaining({ type: "replace", path: paths.b1 })]]);
    await expect(ops.read({ paths: [paths.b1] })).resolves.toMatchObject([{ height: 21, floors: 7, name: "Block A", area: 96 }]);
    expect(calls.find((c) => c.fn === "createFromFloors")?.arg).toMatchObject({
      floors: Array.from({ length: 7 }, () => ({ height: 3, planId: "p0" })),
      plans: [{ units: [{ functionId: "res" }] }],
    });
    await ops.undo({ steps: 1 });
    expect(children).toEqual(original);
  });

  it.each([{ floorHeight: 4 }, { height: 8 }])("changes floors and footprint in one saved edit with %j", async (dimensions) => {
    const { F, calls, paths, children } = mockForma({ kind: "udm" });
    const ops = new Ops(F);
    const original = structuredClone(children);
    const args = { ops: [{ op: "footprint", path: paths.b1, polygon: rect(0, 0, 12, 8), floors: 2, ...dimensions }] };
    await expect(ops.edit({ ...args, preview: true })).resolves.toMatchObject({
      preview: true, sdkOps: 0, ops: [{ floors: 2, height_m: 8, to_m2: 96 }],
    });
    expect(calls.filter(({ fn }) => fn === "batch" || fn === "createFromFloors")).toHaveLength(0);
    await expect(ops.edit(args)).resolves.toMatchObject({ pathsVerified: true, applied: [{ floors: 2, height_m: 8 }] });
    expect(calls.filter(({ fn }) => fn === "batch").map(({ arg }) => arg)).toEqual([[expect.objectContaining({ type: "replace", path: paths.b1 })]]);
    expect(calls.find(({ fn }) => fn === "createFromFloors")?.arg).toMatchObject({
      floors: [{ height: 4 }, { height: 4 }], plans: [{ units: [{ functionId: "res" }] }],
    });
    await ops.undo({ steps: 1 });
    expect(children).toEqual(original);
  });

  it("identifies the boundary and the credited road width per finding", async () => {
    const { F, paths } = mockForma({ roads: [{ coordinates: [[-30, -12], [30, -12]], width: 4 }] });
    const ops = new Ops(F);
    for (const allowRoadHalf of [true, false]) {
      const r = await ops.check({ paths: [paths.b1], rules: { abstand: { state: "BY", bayern16m: true, allowRoadHalf } } });
      expect(r.violations.find((v) => v.rule === "abstand" && v.facade === "south")).toMatchObject({
        boundary_source: allowRoadHalf ? "road_centreline" : "plot_boundary",
        road_contributed: allowRoadHalf, road_allowance_m: allowRoadHalf ? 2 : 0,
        text: expect.stringContaining(allowRoadHalf ? "Straßenmitte" : "Grundstücksgrenze."),
      });
    }
  });

  it("names the uncovered parcel edge when it controls after road credit elsewhere", () => {
    const site: P2[] = [[-5, -2], [5, -2], [5, -4], [20, -4], [20, 20], [-5, 20]];
    const r = checkRules({
      site, buildings: [{ path: "A", ring: rect(0, 0, 10, 10), height: 15 }],
      abstandRoads: { surfaces: roadSurfaces([[-5, -5], [5, -5]], 6), missingWidth: 0, unreadable: 0, estimatedCentre: false, publicUnconfirmed: false },
    }, { abstand: {} });
    expect(r.violations).toContainEqual(expect.objectContaining({
      facade: "south", actual: 4, boundary_source: "plot_boundary", road_contributed: false, road_allowance_m: 0,
    }));
  });

  it("writes fixed-width building and figures CSVs with collision-safe paired names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forma-figures-"));
    try {
      const r = await new Ops(mockForma().F).report({ rules: { maxGrz: 0.5, maxGfz: 1 } });
      const when = new Date("2026-01-02T03:04:05Z");
      const first = saveReport(r, dir, when);
      const figures = first.csv.replace(/\.csv$/, "-figures.csv");
      const lines = readFileSync(first.csv, "utf8").trim().split(/\r?\n/);
      expect(lines.map((line) => line.split(";").length)).toEqual([10, 10, 10]);
      expect(lines[0]).toBe(toCsv({}).trim());
      expect(lines[0]).toContain(";Site ratios;");
      expect(readFileSync(figures, "utf8")).toContain("Floor area ratio (GFZ);");
      expect(readFileSync(first.html, "utf8")).toContain("Site coverage including ancillary areas (GRZ II)");
      expect(readFileSync(first.html, "utf8")).toContain("Floor area ratio (GFZ)");
      const collision = first.csv.replace(/\.csv$/, "-2-figures.csv");
      writeFileSync(collision, "keep");
      const next = saveReport(r, dir, when);
      expect(next.csv).toMatch(/-3\.csv$/);
      expect(readFileSync(collision, "utf8")).toBe("keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
