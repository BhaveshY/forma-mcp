import { describe, expect, it } from "vitest";
import { checkRules, ringDistance, setback, type RuleInput } from "../src/shared/rules.js";
import { rect } from "../src/shared/geom.js";
import { labelBuildings } from "../src/bridge/ops.js";

const site = rect(0, 0, 100, 60); // 6,000 m²
const A = { path: "root/a", name: "Block A", ring: rect(10, 10, 20, 10), height: 18, floors: 6 };
const B = { path: "root/b", name: "Block B", ring: rect(36, 10, 20, 10), height: 31, floors: 10 };

describe("rule geometry", () => {
  it("distance between outlines, 0 when overlapping", () => {
    expect(ringDistance(A.ring, B.ring)).toBeCloseTo(6);
    expect(ringDistance(A.ring, rect(25, 15, 10, 10))).toBe(0);
    expect(ringDistance(A.ring, rect(12, 12, 2, 2))).toBe(0); // contained
  });
  it("setback is the inward distance; negative when outside", () => {
    expect(setback(A.ring, site)).toBeCloseTo(10);
    expect(setback(rect(95, 10, 10, 10), site)).toBeCloseTo(-5); // sticks out 5 m
  });
  it("keeps duplicate or unnamed building letters stable when heights and row order change", () => {
    const buildings = [{ path: "root/b", name: "Building 1", height: 12 }, { path: "root/a", name: "Building 1", height: 35.24 }, { path: "root/t", name: "Tower", height: 50 }, { path: "root/c", height: 9 }];
    const rows = buildings.map((b) => ({ ...b }));
    labelBuildings(rows);
    expect(rows.map((r) => r.name)).toEqual(["Building B (12 m)", "Building A (35.2 m)", "Tower", "Building C (9 m)"]);
    const changed = buildings.map((b) => ({ ...b, height: b.path === "root/a" ? 8 : b.height })).reverse();
    labelBuildings(changed);
    expect(changed.map((r) => r.name)).toEqual(["Building C (9 m)", "Tower", "Building A (8 m)", "Building B (12 m)"]);
  });
});

describe("checkRules", () => {
  it("reports each broken limit with plain text and the actual value", () => {
    const r = checkRules({ site, siteArea: 6000, gfa: 4000 * 2, buildings: [A, B] }, { maxHeight: 30, maxFloors: 8, maxFar: 1.2, maxCoverage: 5, minSetback: 12, minSpacing: 8 });
    expect(r.ok).toBe(false);
    const by: Record<string, typeof r.violations> = {};
    for (const v of r.violations) (by[v.rule] ??= []).push(v);
    expect(by.maxHeight?.map((v) => v.name)).toEqual(["Block B"]);
    expect(by.maxFloors?.[0].actual).toBe(10);
    expect(by.maxFar?.[0].text).toMatch(/FAR is 1.33 \(limit 1.2\); 800 m² too much/);
    expect(by.maxCoverage?.[0].actual).toBeCloseTo(6.7, 1);
    expect(by.minSetback?.map((v) => v.name).sort()).toEqual(["Block A", "Block B"]);
    expect(by.minSpacing?.[0].actual).toBeCloseTo(6);
    expect(r.summary.tallest_m).toBe(31);
  });
  it("passes when every limit is met; skips site rules without a boundary", () => {
    expect(checkRules({ site, siteArea: 6000, gfa: 4000, buildings: [A, B] }, { maxHeight: 40, minSetback: 5, minSpacing: 5, maxFar: 1 }).ok).toBe(true);
    const r = checkRules({ buildings: [A] }, { maxFar: 1, minSetback: 3 });
    expect(r.checked).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });
});

describe("German planning rules", () => {
  const plot: RuleInput = { siteArea: 1000, buildings: [A, B], parkingArea: 50 };
  const withStoreys: RuleInput = {
    ...plot, storeys: [
      { ...A, floors: 3, floorAreas: [200, 200, 100] },
      { ...B, floors: 2, floorAreas: [200, 50] },
    ],
  };

  it("checks GRZ from the sum of the building footprints", () => {
    expect(checkRules({ ...plot, footprint: 1 }, { maxGrz: 0.4 }).summary.grz).toBe(0.4);
    expect(checkRules(plot, { maxGrz: 0.4 }).ok).toBe(true);
    expect(checkRules(plot, { maxGrz: 0.3 }).violations).toEqual([
      expect.objectContaining({ rule: "maxGrz", actual: 0.4, text: "GRZ is 0.4 (limit 0.3); 100 m² too much footprint" }),
    ]);
  });

  it("uses the 50% allowance for GRZ II and accepts parking or a manual ancillary area", () => {
    expect(checkRules(plot, { maxGrz: 0.4 }).summary).toMatchObject({ grz2: 0.45, grz2_limit: 0.6 });
    expect(checkRules(plot, { maxGrz: 0.4, ancillaryArea_m2: 0 }).summary.grz2).toBe(0.4);
    expect(checkRules(plot, { maxGrz: 0.4, ancillaryArea_m2: 210 }).violations[0]).toMatchObject({ rule: "maxGrz2", actual: 0.61, limit: 0.6 });
  });

  it("caps automatic GRZ II at 0.8 and honours an explicit override", () => {
    const rules = { maxGrz: 0.6, ancillaryArea_m2: 425 };
    expect(checkRules(plot, rules).violations[0]).toMatchObject({ rule: "maxGrz2", limit: 0.8 });
    expect(checkRules(plot, { ...rules, ancillaryArea_m2: 400 }).ok).toBe(true);
    const explicit = checkRules(plot, { ...rules, maxGrz2: 0.9 });
    expect(explicit.ok).toBe(true);
    expect(explicit.summary).toMatchObject({ grz2_limit: 0.9, grz2_limit_source: "Explicit GRZ II limit" });
  });

  it("skips GRZ II if it cannot read parking and no ancillary area was entered", () => {
    const result = checkRules({ ...plot, parkingArea: undefined }, { maxGrz: 0.4 });
    expect(result.checked).toEqual(["maxGrz"]);
    expect(result.skipped[0]).toContain("ancillary area is unavailable");
  });

  it("checks GFZ with all modelled floors by default and excludes the actual top floor areas", () => {
    const all = checkRules(withStoreys, { maxGfz: 0.6 });
    expect(all.summary).toMatchObject({ gfz: 0.75, full_storeys_assumption: "All modelled floors are counted as full storeys." });
    expect(all.violations[0]).toMatchObject({ rule: "maxGfz", text: "GFZ is 0.75 (limit 0.6); 150 m² too much floor area" });
    const lower = checkRules(withStoreys, { maxGfz: 0.6, nonFullTopFloors: 1 });
    expect(lower.ok).toBe(true);
    expect(lower.summary.gfz).toBe(0.6);
    expect(lower.summary.full_storeys_assumption).toContain("The top floor is excluded from each building.");
  });

  it("checks full storeys per building and floors cannot drop below zero", () => {
    const result = checkRules(withStoreys, { maxFullStoreys: 2 });
    expect(result.violations).toEqual([expect.objectContaining({ rule: "maxFullStoreys", name: "Block A", actual: 3, limit: 2 })]);
    expect(result.summary.max_full_storeys).toBe(3);
    expect(checkRules(withStoreys, { maxFullStoreys: 2, nonFullTopFloors: 1 }).ok).toBe(true);
    expect(checkRules(withStoreys, { maxFullStoreys: 0, nonFullTopFloors: 4 }).summary.max_full_storeys).toBe(0);
  });

  it("requires each footprint to fit a building zone and measures the furthest outside corner", () => {
    const zones = [{ name: "West", ring: A.ring }, { name: "East", ring: rect(36, 10, 16, 10) }];
    const result = checkRules({ ...plot, zones }, { insideZone: true });
    expect(result.summary.zone).toBe("West, East");
    expect(result.violations).toEqual([expect.objectContaining({ rule: "insideZone", path: B.path, name: B.name, actual: 4 })]);
    expect(checkRules(plot, { insideZone: true, zoneRing: site }).ok).toBe(true);
  });

  it("flags an edge spanning a concave cut-out even when every corner is inside", () => {
    const zoneRing: [number, number][] = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 3], [4, 3], [4, 10], [0, 10]];
    const r = checkRules({ buildings: [{ ...A, ring: rect(2, 2, 6, 3) }] }, { insideZone: true, zoneRing });
    expect(r.violations[0].text).toBe("Block A crosses the building zone boundary");
  });
});
