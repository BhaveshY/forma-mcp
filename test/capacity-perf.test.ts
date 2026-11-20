import { expect, it, vi } from "vitest";
import { Ops } from "../src/bridge/ops.js";
import { rect, type P2 } from "../src/shared/geom.js";
import { mockForma } from "./mockForma.js";

function capacityFixture() {
  const { F, footprints, children, paths, addBuilding } = mockForma();
  const turn = 0.21;
  const rotate = (ring: P2[], angle = turn): P2[] => ring.map(([x, y]) =>
    [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]);
  const setFootprint = (path: string, ring: P2[]) => {
    const child = children.find(({ key }) => path === `root/${key}`);
    if (!child) throw new Error(`Fixture is missing ${path}`);
    footprints.set(child.urn, ring);
  };
  setFootprint(paths.site, rotate([[-14, -13], [66, -13], [69, 12], [63, 49], [21, 43], [-14, 45]]));
  setFootprint(paths.b1, rotate(rect(-2, -1, 20, 10)));
  setFootprint(paths.b2, rotate(rect(29, 2, 12, 12)));
  for (const [x, y, w, d, h] of [[-2, 19, 17, 15, 21], [24, 21, 17, 17, 18], [49, 15, 13, 20, 18]]) {
    addBuilding(`Stock ${x}`, rotate(rect(x, y, w, d), turn - 0.09), h);
  }
  for (let i = 0; i < 110; i++) {
    const x = -82 + (i % 11) * 21, y = -79 + Math.floor(i / 11) * 22;
    const ring = y > -28 && y < 54 && x > -30 && x < 78 ? rect(x + 180, y, 12, 14) : rect(x, y, 12, 14);
    addBuilding(`Context ${i}`, rotate(ring, turn + (i % 5) * 0.08), 9 + (i % 7) * 3, { context: true });
  }
  return F;
}

it("previews a five-storey BW WA capacity search with 115 buildings in under 1.5 s", async () => {
  const F = capacityFixture();
  const geometry = vi.spyOn(F.geometry, "getTriangles");
  const ops = new Ops(F);
  const args = { action: "capacity", mode: "add", rules: { abstand: { state: "BW", area: "WA" }, maxGrz: 0.5, maxGfz: 2.8, maxFullStoreys: 5 } };
  const started = performance.now();
  const preview = await ops.run("check", { ...args, preview: true });
  const elapsed = performance.now() - started;
  console.info(`Capacity fixture cold preview: ${elapsed.toFixed(1)} ms`);
  expect(preview).toMatchObject({
    validated: true,
    existing: { inventory: expect.toSatisfy((stock: unknown[]) => stock.length === 5) },
    rows: expect.toSatisfy((rows: unknown[]) => rows.length === 5),
    block: { gfa_m2: expect.toSatisfy((gfa: number) => gfa > 0) },
  });
  expect(geometry.mock.calls.length).toBeGreaterThanOrEqual(115);
  expect(elapsed).toBeLessThan(1500);
  if (!preview || typeof preview !== "object" || !("block" in preview)) throw new Error("missing capacity block");
  geometry.mockClear();
  const areaMetrics = vi.spyOn(F.areaMetrics, "calculate");
  const createStart = performance.now();
  const created = await ops.run("check", { ...args, create: true });
  console.info(`Capacity fixture cached create with mock persistence: ${(performance.now() - createStart).toFixed(1)} ms`);
  expect(created).toMatchObject({ block: preview.block, placement: { created: 1, pathsVerified: true } });
  expect(geometry).not.toHaveBeenCalled();
  expect(areaMetrics).not.toHaveBeenCalled();
});
