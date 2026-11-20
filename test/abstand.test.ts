import { describe, expect, it } from "vitest";
import { checkRules, type RuleBuilding } from "../src/shared/rules.js";
import { ABSTAND_DATA } from "../src/shared/abstand-data.js";
import { facadeAngle, facadeEdges, plotStripDepth, rect, roadSurfaces, setbackStrip, stripOverlap, type P2 } from "../src/shared/geom.js";
import { Ops } from "../src/bridge/ops.js";
import { toCsv, toHtml } from "../src/server/report.js";
import { mockForma } from "./mockForma.js";

const building = (path: string, ring: P2[], height = 10): RuleBuilding => ({ path, name: path, ring, height });
const site = rect(-25, -25, 100, 100);
const south = setbackStrip(facadeEdges(rect(0, 0, 10, 10))[0], 6);

describe("setback geometry", () => {
  it("draws an outward strip on a rectangle in either winding", () => {
    for (const footprint of [rect(0, 0, 10, 10), rect(0, 0, 10, 10).reverse()]) {
      const facade = facadeEdges(footprint).find((f) => f.direction === "south")!;
      expect(setbackStrip(facade, 6).ring).toEqual([[10, 0], [0, 0], [0, -6], [10, -6]]);
    }
  });

  it("points outward at the inside corner of an L-shaped footprint", () => {
    const edges = facadeEdges([[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]]);
    expect(edges).toHaveLength(6);
    expect(setbackStrip(edges[2], 4).ring).toEqual([[3, 3], [8, 3], [8, 7], [3, 7]]);
    expect(setbackStrip(edges[3], 4).ring).toEqual([[3, 8], [3, 3], [7, 3], [7, 8]]);
  });

  it("finds the first plot exit including a narrow notch between strip corners", () => {
    expect(plotStripDepth(south, rect(-2, -3, 20, 20))).toBe(3);
    const notched: P2[] = [[-2, -7], [4, -7], [4, -2], [5, -2], [5, -7], [15, -7], [15, 10], [-2, 10]];
    expect(plotStripDepth(south, notched)).toBe(2);
  });

  it("credits an adjacent road only up to its centre and rejects gaps or narrow coverage", () => {
    const plot = rect(-2, -2, 20, 20);
    expect(plotStripDepth(south, plot, [{ ring: rect(-10, -8, 30, 6) }])).toBe(5);
    expect(plotStripDepth(south, plot, roadSurfaces([[-10, -5], [20, -5]], 6))).toBe(5);
    expect(plotStripDepth(south, plot, [{ ring: rect(-10, -8, 30, 5) }])).toBe(2);
    expect(plotStripDepth(south, plot, [{ ring: rect(-10, -8, 17, 6) }])).toBe(2);
    expect(plotStripDepth(south, rect(-2, -5, 20, 20), roadSurfaces([[-10, -5], [20, -5]], 6))).toBe(5);
  });

  it("measures positive-area footprint overlap with a building and ignores touching", () => {
    expect(stripOverlap(south, rect(2, -8, 5, 4))).toEqual({ available: 4, overlap: 2 });
    expect(stripOverlap(south, rect(2, -4, 5, 2))).toEqual({ available: 2, overlap: 2 });
    expect(stripOverlap(south, rect(10, -6, 4, 6))).toEqual({ available: 6, overlap: 0 });
  });

  it("finds strip-to-strip overlap without requiring footprint intrusion", () => {
    const a = building("A", rect(0, 0, 10, 10));
    const b = building("B", rect(0, -16, 10, 10));
    const report = checkRules({ site, buildings: [a, b] }, { abstand: {} });
    expect(report.violations).toHaveLength(2);
    expect(report.violations[0]).toMatchObject({ path: "A", other: "B", facade: "south", actual: 2, limit: 4, shortfall_m: 2, overlap_m: 2 });
  });

  it("exempts strip overlaps above 75 degrees where the law supports it", () => {
    const a = building("A", rect(0, 0, 10, 10));
    const b = building("B", rect(12, -12, 10, 10));
    expect(facadeAngle(facadeEdges(a.ring)[0], facadeEdges(b.ring)[3])).toBe(90);
    expect(checkRules({ site, buildings: [a, b] }, { abstand: {} }).violations).toEqual([]);
    expect(checkRules({ site, buildings: [a, b] }, { abstand: { state: "NI" } }).violations).toHaveLength(4);
    const tilted = facadeEdges(rect(0, 0, 10, 5, 75))[0];
    expect(facadeAngle(facadeEdges(a.ring)[0], tilted)).toBeCloseTo(75);
  });
});

describe("bundled setback rules", () => {
  it("contains the model code and 16 states with citations", () => {
    expect(new Set(ABSTAND_DATA.map((law) => law.code)).size).toBe(17);
    for (const law of ABSTAND_DATA) {
      expect(law.section).toMatch(/§|Art\./);
      expect(law.url).toMatch(/^https:\/\//);
    }
  });

  it("uses BW 0.4 H and the correct minimum on each wall", () => {
    const results = checkRules({ site, buildings: [
      building("A", [[0, 0], [4, 0], [8, 0], [8, 5], [0, 5]], 4), building("B", rect(35, 35, 8, 6), 12),
    ] }, { abstand: { state: "BW" } }).abstand;
    expect(results?.factor).toBe(0.4);
    expect(results?.strips.slice(0, 4).map((s) => s.depth)).toEqual([2.5, 2, 2.5, 2]);
    expect(results?.strips.slice(4).map((s) => s.depth)).toEqual(Array(4).fill(expect.closeTo(4.8, 8)));
  });

  it.each([["BW", "Gewerbegebiet", 0.125], ["BY", "ge", 0.2]] as const)("maps %s %s to %s H", (state, area, factor) => {
    const checked = checkRules({ site, buildings: [building("Hall", rect(0, 0, 10, 10), 32)] }, { abstand: { state, area } });
    expect(checked.abstand).toMatchObject({ state, area: "Gewerbegebiet", factor });
    expect(checked.abstand?.strips[0].depth).toBe(32 * factor);
  });

  it("defaults to the MBO and states the flat-roof assumption", () => {
    const checked = checkRules({ site, buildings: [building("A", rect(0, 0, 10, 10), 4)] }, { abstand: {} });
    expect(checked.abstand).toMatchObject({ state: "MBO", factor: 0.4, citation: expect.stringContaining("§ 6") });
    expect(checked.abstand?.strips[0].depth).toBe(3);
    expect(checked.abstand?.assumptions.join(" ")).toMatch(/Flachdach.*Kein Bundesland/);
  });

  it.each([["RP", "MK"], ["MV", "GE"]] as const)("asks for a manual check of %s %s without inventing a depth", (state, area) => {
    const checked = checkRules({ site, buildings: [building("A", rect(0, 0, 10, 10))] }, { abstand: { state, area } });
    expect(checked.abstand).toMatchObject({ factor: null, fix: expect.any(String), strips: [], buildings: [{ status: "manual" }] });
    expect(checked.skipped[0]).toMatch(/§.*needs manual check/i);
    expect(checked.checked).toEqual([]);
  });

  it("applies the BY 16 m rule only on opt-in and with at least two full-depth façades", () => {
    const input = { site: rect(-6, -6, 30, 30), buildings: [building("A", rect(0, 0, 10, 10))] };
    const regular = checkRules(input, { abstand: { state: "BY" } });
    const special = checkRules(input, { abstand: { state: "BY", bayern16m: true } });
    expect(regular.abstand?.strips.map((s) => s.depth)).toEqual([4, 4, 4, 4]);
    expect(special.abstand?.strips.map((s) => s.depth)).toEqual([5, 10, 10, 5]);
    const tight = checkRules({ ...input, site: rect(-6, -6, 30, 22) }, { abstand: { state: "BY", bayern16m: true } });
    expect(tight.abstand?.strips.map((s) => s.depth)).toEqual([10, 10, 10, 10]);
  });
});

describe("Forma setback operations", () => {
  it("draws coloured temporary polygons with show:true, clears them, and leaves the design intact", async () => {
    const { F, calls, children, paths } = mockForma();
    const before = structuredClone(children);
    const ops = new Ops(F);
    const report = await ops.check({ paths: [paths.b1], rules: { abstand: {} }, show: true });
    expect(report.violations).toEqual([expect.objectContaining({ rule: "abstand", name: "Block A", other: paths.b2 })]);
    const overlay = calls.find((c) => c.fn === "geojson.add");
    expect(overlay?.arg.geojson.features).toHaveLength(4);
    expect(overlay?.arg.geojson.features.map(({ properties }: { properties: { fill: string } }) => properties.fill))
      .toEqual(["#2e9e5b", "#d93025", "#2e9e5b", "#2e9e5b"]);
    await ops.view({ action: "clear_colors" });
    expect(calls.find((c) => c.fn === "geojson.remove")?.arg).toEqual({ id: "g1" });
    expect(children).toEqual(before);
    expect(calls.some((c) => /^(batch|createElementHierarchy|createFromFloors|replace|remove)$/.test(c.fn))).toBe(false);
  });

  it("uses Forma road geometry and reports lines without width", async () => {
    const { F, paths } = mockForma({ roads: [
      { coordinates: [[-30, -12], [30, -12]], width: 4 },
      { coordinates: [[-30, 45], [30, 45]] },
    ] });
    const ops = new Ops(F);
    const a = { paths: [paths.b1], rules: { abstand: { state: "BY", bayern16m: true } } };
    // Block A is 10 m in from the south boundary. The available width grows by 2 m.
    const withRoad = await ops.check(a);
    const without = await ops.check({ ...a, rules: { abstand: { ...a.rules.abstand, allowRoadHalf: false } } });
    const south = (r: typeof withRoad) => r.violations.find((v) => v.rule === "abstand" && v.facade === "south");
    expect(south(withRoad)?.actual).toBe(12);
    expect(south(without)?.actual).toBe(10);
    expect(withRoad.abstand?.assumptions.join(" ")).toContain("1 Straßenlinie(n) ohne Breite");
  });

  it("includes source, façade findings and a per-building value in the saved report formats", async () => {
    const { F } = mockForma();
    const r = await new Ops(F).report({ rules: { abstand: {} } });
    const html = toHtml(r);
    expect(html).toContain("<h2>Abstandsflächen</h2>");
    expect(html).toContain("Block A, east façade");
    expect(html).toContain("§ 6 Musterbauordnung (MBO)");
    expect(html).toContain("fix:");
    const csv = toCsv(r);
    expect(csv).toContain("Abstandsflächen OK / shortfall m");
    expect(csv).toMatch(/Block A;[^\r\n]+;2\r?\n/);
  });
});
