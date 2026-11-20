import { describe, expect, it } from "vitest";
import { area, baseOutline, earcut, type P2 } from "../src/shared/geom.js";

function prismTris(ring: P2[], h: number): number[] {
  const out: number[] = [];
  for (const [a, b, c] of earcut(ring)) for (const z of [0, h]) for (const k of [a, b, c]) out.push(ring[k][0], ring[k][1], z);
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    out.push(x1, y1, 0, x2, y2, 0, x2, y2, h, x1, y1, 0, x2, y2, h, x1, y1, h);
  }
  return out;
}

describe("base outline of a mesh", () => {
  it("L-shaped building: exact area, not the convex hull", () => {
    const L: P2[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
    const ring = baseOutline(prismTris(L, 12))!;
    expect(area(ring)).toBeCloseTo(300, 3); // convex hull would be 350
    expect(ring.length).toBe(6);
  });
  it("box: 4 corners", () => {
    const ring = baseOutline(prismTris([[0, 0], [8, 0], [8, 5], [0, 5]], 3))!;
    expect(area(ring)).toBeCloseTo(40, 3);
    expect(ring.length).toBe(4);
  });
});
