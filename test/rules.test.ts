import { describe, expect, it } from "vitest";
import { checkRules, ringDistance, setback } from "../src/shared/rules.js";
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
