import { describe, expect, it } from "vitest";
import { rasterMax, sunHours, sunPosition, type HeightGrid } from "../src/shared/sun.js";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "./mockForma.js";

const DEG = 180 / Math.PI;

describe("sun position", () => {
  it("summer solstice noon at 49.4°N: altitude ≈ 64°, due south", () => {
    const lon = 8.7;
    const solarNoon = Date.UTC(2026, 5, 21, 12) - (lon / 15) * 3600000;
    const s = sunPosition(solarNoon, 49.4, lon);
    expect(s.alt * DEG).toBeGreaterThan(63);
    expect(s.alt * DEG).toBeLessThan(65);
    expect(s.az * DEG).toBeGreaterThan(175);
    expect(s.az * DEG).toBeLessThan(185);
  });
  it("morning sun is in the east, evening sun in the west", () => {
    const am = sunPosition(Date.UTC(2026, 5, 21, 5), 49.4, 8.7), pm = sunPosition(Date.UTC(2026, 5, 21, 17), 49.4, 8.7);
    expect(am.az * DEG).toBeLessThan(120);
    expect(pm.az * DEG).toBeGreaterThan(240);
  });
});

function flat(width: number, height: number, res = 1): HeightGrid {
  const n = width * height;
  return { width, height, x0: 0, y0: 0, res, ground: new Float32Array(n), top: new Float32Array(n) };
}
/** Closed box mesh, top + bottom faces (sides are vertical and ignored by the raster). */
function box(x0: number, y0: number, x1: number, y1: number, h: number) {
  return [x0, y0, h, x1, y0, h, x1, y1, h, x0, y0, h, x1, y1, h, x0, y1, h];
}

describe("sun hours", () => {
  it("open ground gets the full day (~16 h in June at 49°N); winter much less", () => {
    const g = flat(10, 10);
    const june = sunHours(g, 49.4, 8.7, 2026, 6, 21);
    const dec = sunHours(g, 49.4, 8.7, 2026, 12, 21);
    expect(june.daylight_h).toBeGreaterThan(15.5);
    expect(june.daylight_h).toBeLessThan(16.6);
    expect(dec.daylight_h).toBeGreaterThan(7.5);
    expect(dec.daylight_h).toBeLessThan(8.6);
    expect(june.grid[55]).toBeCloseTo(june.daylight_h, 5);
  });

  it("a tall block shades the ground north of it, not the ground south of it; its roof is masked", () => {
    const g = flat(100, 100);
    rasterMax(box(40, 40, 60, 60, 30), g, g.top);
    const r = sunHours(g, 49.4, 8.7, 2026, 3, 21);
    const at = (x: number, y: number) => y * 100 + x;
    expect(r.mask[at(50, 50)]).toBe(0); // under the building
    expect(r.grid[at(50, 62)]).toBeLessThan(r.daylight_h - 4); // just north: shaded around noon
    expect(r.grid[at(50, 37)]).toBeCloseTo(r.daylight_h, 0); // just south: sunny
  });

  it("terrain is interpolated, building tops take the roof height", () => {
    const g = flat(4, 4);
    const ground = new Float32Array(16).fill(NaN);
    rasterMax([0, 0, 0, 4, 0, 4, 4, 4, 4, 0, 0, 0, 4, 4, 4, 0, 4, 0], g, ground, "interp");
    expect(ground[0]).toBeCloseTo(0.5, 5);
    expect(ground[3]).toBeCloseTo(3.5, 5);
  });
});

describe("ops: sun_hours", () => {
  it("returns stats for open ground in the site, says it was calculated locally", async () => {
    const m = mockForma();
    const r: any = await new Ops(m.F).run("analysis", { action: "sun_hours", month: 6, day: 21 });
    expect(r.cells).toBeGreaterThan(100);
    expect(r.max).toBeLessThanOrEqual(r.daylight_h);
    expect(r.min).toBeLessThan(r.max); // the blocks shade some ground
    expect(r.source).toMatch(/calculated by forma-mcp/);
  });
  it("reports an unavailable historical grid and offers an explicitly current-scene calculation", async () => {
    const m = mockForma();
    m.F.analysis.getGroundGrid = async () => { throw new Error("No texture metadata found"); };
    m.F.analysis.getSunAnalysis = async () => ({ parameters: { month: 3, date: 21 } });
    m.F.analysis.list = async () => [{ analysisId: "a1", analysisType: "sun", status: "SUCCEEDED", createdAt: 1 }];
    const r: any = await new Ops(m.F).run("analysis", { action: "result", id: "a1" });
    expect(r.status).toBe("SUCCEEDED");
    expect(r.grid).toBe("not shared by Forma");
    expect(r.date).toBeUndefined();
    expect(r.median).toBeUndefined();
    expect(r.next).toContain("action:sun_hours");
  });
});
