import { describe, expect, it, vi } from "vitest";
import { Ops } from "../src/bridge/ops.js";
import { calculateCapacity } from "../src/shared/capacity.js";
import { rect, ringsOverlap, signedArea, type P2 } from "../src/shared/geom.js";
import { addedOrWorsenedFindings, checkRules } from "../src/shared/rules.js";
import { toCsv, toFiguresCsv, toHtml } from "../src/server/report.js";
import { mockForma } from "./mockForma.js";

const setup = (options?: Parameters<typeof mockForma>[0]) => {
  const mock = mockForma(options);
  const ops = new Ops(mock.F);
  return { ...mock, ops, capacity: (args: Record<string, unknown>) => ops.run("check", { action: "capacity", ...args }) };
};

describe("capacity through the Forma bridge", () => {
  it.each([
    { rules: { maxFullStoreys: 5, maxGrz: 0.2 }, constraint: "GRZ", floors: 5, footprint: 700, gfa: 3500 },
    { rules: { maxFullStoreys: 5, maxGfz: 1 }, constraint: "GFZ", floors: 1, footprint: 3500, gfa: 3500 },
    { rules: { maxFullStoreys: 5, maxGrz2: 0.2 }, constraint: "GRZ II", floors: 5, footprint: 700, gfa: 3500 },
    { rules: { maxFullStoreys: 8, maxHeight: 10 }, constraint: "height", floors: 3, footprint: 3500, gfa: 10500 },
  ])("finds the maximum with $constraint", async ({ rules, constraint, floors, footprint, gfa }) => {
    const { capacity, calls } = setup();
    const r = await capacity({ rules });
    expect(r).toMatchObject({ best: { storeys: floors, maxFootprint_m2: footprint, maxGfa_m2: gfa, constraints: expect.arrayContaining([constraint]) } });
    expect(calls.some((c) => c.fn === "batch")).toBe(false);
  });

  it("reduces the envelope at higher storey counts and chooses the best GFA", async () => {
    const { capacity } = setup();
    const r = await capacity({ rules: { maxFullStoreys: 20, abstand: { state: "MBO" } } });
    expect(r).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ storeys: 1, depth_m: 3, buildable_m2: 2816 }),
        expect.objectContaining({ storeys: 5, depth_m: 6, buildable_m2: 2204 }),
        expect.objectContaining({ storeys: 20, depth_m: 24, buildable_m2: 44 }),
      ]),
      best: { storeys: 8, constraints: expect.arrayContaining(["Abstandsflächen"]) },
    });
  });

  it("credits an adjoining road to its centre, and preserves a fixed minimum setback", async () => {
    const { capacity } = setup({ roads: [{ coordinates: [[-10, -14], [60, -14]], width: 8 }] });
    const rules = { maxFullStoreys: 5, minSetback: 3, abstand: { state: "MBO" } };
    await expect(capacity({ rules })).resolves.toMatchObject({ best: { buildable_m2: 2378 } });
    await expect(capacity({ rules: { ...rules, abstand: { state: "MBO", allowRoadHalf: false } } }))
      .resolves.toMatchObject({ best: { buildable_m2: 2204 } });
  });

  it("credits a street segment only along the section of plot it adjoins", async () => {
    const { capacity } = setup({ roads: [{ coordinates: [[0, -14], [40, -14]], width: 8 }] });
    await expect(capacity({ rules: { maxFullStoreys: 5, minSetback: 3, abstand: {} } }))
      .resolves.toMatchObject({ best: { buildable_m2: 2288 } });
  });

  it("counts overlapping zones once and uses only whole storeys below the height cap", async () => {
    const { capacity } = setup({ zones: [
      { name: "West", ring: rect(0, 15, 20, 10) },
      { name: "East", ring: rect(10, 15, 20, 10) },
    ] });
    await expect(capacity({ rules: { maxHeight: 10, insideZone: true }, floorHeight: 3.5 })).resolves.toMatchObject({
      best: { storeys: 2, height_m: 7, buildable_m2: 300, maxGfa_m2: 600 },
      block: { footprint_m2: 200, gfa_m2: 400 },
    });
  });

  it("intersects a named zone with the plot and insets the zone", async () => {
    const zoneRing = rect(45, 0, 20, 10);
    const { capacity } = setup({ zones: [{ name: "East", ring: zoneRing }] });
    const rules = { maxFullStoreys: 2, zone: "east", minSetback: 1 };
    await expect(capacity({ rules })).resolves.toMatchObject({
      zone: "East", best: { buildable_m2: 104, maxGfa_m2: 208, constraints: expect.arrayContaining(["zone"]) },
    });
    await expect(capacity({ rules: { ...rules, zoneRing } })).resolves.toMatchObject({ best: { buildable_m2: 104 } });
  });

  it("deducts existing footprints, full-storey area and setback strips in add mode", async () => {
    const { capacity } = setup();
    const rules = { maxFullStoreys: 2, maxGrz: 0.2, maxGfz: 0.6, abstand: {} };
    await expect(capacity({ rules })).resolves.toMatchObject({ best: { maxFootprint_m2: 700, maxGfa_m2: 1400 } });
    const r = await capacity({ rules, mode: "add" });
    expect(r).toMatchObject({
      existing: { footprint_m2: 300, floorArea_m2: 1700 },
      rows: expect.arrayContaining([expect.objectContaining({ maxFootprint_m2: 400, maxGfa_m2: 400, buildable_m2: expect.any(Number) })]),
    });
    const withStrips = await capacity({ mode: "add", rules: { maxFullStoreys: 1, abstand: {} } });
    const withoutStrips = await capacity({ mode: "add", rules: { maxFullStoreys: 1, minSetback: 3 } });
    expect(withStrips).toMatchObject({ best: { buildable_m2: expect.any(Number) } });
    expect(withoutStrips).toMatchObject({ best: { buildable_m2: 2516 } });
    if (!withStrips || typeof withStrips !== "object" || !("best" in withStrips)) throw new Error("missing capacity");
    expect(withStrips.best).toMatchObject({ buildable_m2: expect.toSatisfy((value: number) => value < 2516) });
  });

  it("previews, places exactly one block with the chosen use, and undoes it", async () => {
    const { capacity, ops, calls, children } = setup();
    children.splice(1, 2);
    const before = children.length;
    const args = { rules: { maxFullStoreys: 2, maxGrz: 0.1, zoneRing: rect(0, 17, 30, 20) }, targetUse: "Office" };
    await expect(capacity({ ...args, create: true, preview: true })).resolves.toMatchObject({
      placement: { preview: true, items: [{ floors: 2, footprint: 350, gfa: 700 }] },
    });
    expect(calls.filter((c) => c.fn === "batch")).toHaveLength(0);
    expect(calls.filter((c) => c.fn === "render.addMesh")).toHaveLength(1);
    const result = await capacity({ ...args, create: true });
    expect(result).toMatchObject({ placement: { created: 1, pathsVerified: true } });
    expect(calls.filter((c) => c.fn === "batch")).toHaveLength(1);
    expect(calls.find((c) => c.fn === "createFromFloorsBatch")?.arg).toMatchObject([{ plans: [{ units: [{ functionId: "off" }] }] }]);
    expect(children).toHaveLength(before + 1);
    await expect(ops.undo({ steps: 1 })).resolves.toMatchObject({ undone: ["create 1"] });
    expect(children).toHaveLength(before);
  });

  it.each([undefined, "Office"])("submits the same floor stack and batch as ordinary create (use %s)", async (targetUse) => {
    const { capacity, calls } = setup();
    const ordinary = setup();
    const args = { mode: "add", rules: { maxFullStoreys: 2, maxGrz: 0.2 }, targetUse };
    const preview = await capacity({ ...args, preview: true });
    if (!preview || typeof preview !== "object" || !("block" in preview)) throw new Error("missing capacity preview");
    const block = preview.block;
    if (!block || typeof block !== "object" || !("ring" in block) || !("storeys" in block)) throw new Error("missing block");
    const created = await capacity({ ...args, create: true });
    await ordinary.ops.run("create", { items: [{
      type: "building", name: "Bebaubarkeit", polygon: block.ring, floors: block.storeys, floorHeight: 3, func: targetUse,
    }] });
    const payloads = (entries: typeof calls) => entries.filter(({ fn }) => fn === "createFromFloorsBatch" || fn === "batch");
    expect(payloads(calls)).toHaveLength(2);
    expect(payloads(calls)).toEqual(payloads(ordinary.calls));
    expect(created).toMatchObject({ block, placement: { pathsVerified: true } });
  });

  it("removes the preview and defers other SDK operations until persistence settles", async () => {
    const { F, ops, capacity, calls } = setup();
    const args = { mode: "add", rules: { maxFullStoreys: 2, maxGrz: 0.2 } };
    await capacity({ ...args, preview: true });
    const metrics = vi.spyOn(F.areaMetrics, "calculate");
    const tree = vi.spyOn(F.elements, "get");
    const root = vi.spyOn(F.udm, "getRootUrn");
    const render = vi.spyOn(F.render, "cleanup");
    const batch = F.elements.batch;
    let markWaiting = () => {};
    let finishWait = () => {};
    const waitStarted = new Promise<void>((resolve) => { markWaiting = resolve; });
    const persisted = new Promise<void>((resolve) => { finishWait = resolve; });
    F.elements.batch = async (input: unknown) => {
      expect(calls.at(-1)?.fn).toBe("createFromFloorsBatch");
      expect(calls.some(({ fn }) => fn === "render.remove")).toBe(true);
      const result = await batch(input);
      metrics.mockClear();
      tree.mockClear();
      root.mockClear();
      return result;
    };
    F.udm.awaitPersisted = () => { markWaiting(); return persisted; };
    const create = capacity({ ...args, create: true });
    await waitStarted;
    const reads = [ops.run("metrics"), ops.run("find"), ops.run("view", { action: "clear_overlays" })];
    try {
      await Promise.resolve();
      expect(calls.at(-1)?.fn).toBe("batch");
      expect(metrics).not.toHaveBeenCalled();
      expect(tree).not.toHaveBeenCalled();
      expect(root).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    } finally {
      finishWait();
    }
    await expect(create).resolves.toMatchObject({ placement: { pathsVerified: true } });
    await Promise.all(reads);
    expect(metrics).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });

  it.each(["revision", "rules", "inventory"] as const)("revalidates a preview when the %s changes", async (change) => {
    const { F, paths, capacity } = setup();
    const args = { mode: "add", rules: { maxFullStoreys: 2, maxGrz: 0.2 } };
    await expect(capacity({ ...args, preview: true })).resolves.toMatchObject({ validated: true });
    if (change === "revision") await F.elements.batch({ operations: [{ type: "remove", path: paths.b2 }] });
    const metrics = vi.spyOn(F.areaMetrics, "calculate");
    const result = await capacity({
      ...args, create: true, includeContext: change === "inventory",
      rules: change === "rules" ? { ...args.rules, maxFullStoreys: 1 } : args.rules,
    });
    expect(result).toMatchObject({ placement: { pathsVerified: true } });
    expect(metrics).toHaveBeenCalled();
  });

  it("correlates the unconfirmed save with the observed revisions and SDK error", async () => {
    const { F, calls, children } = setup({ kind: "udm" });
    const log = vi.fn();
    const ops = new Ops(F, log);
    children.splice(1, 2);
    const batch = F.elements.batch;
    F.elements.batch = async (input: unknown) => {
      const result = await batch(input);
      ops.observeRevision("urn:adsk-forma-elements:proposal:proj:prop1:2");
      return result;
    };
    F.udm.awaitPersisted = async () => { throw new Error("not persisted"); };
    const result = await ops.run("check", { action: "capacity", rules: { maxFullStoreys: 1, maxGrz: 0.2 }, create: true });
    expect(result).toMatchObject({
      placement: { created: 1, pathsVerified: true, saved: expect.stringMatching(/Saved state unconfirmed.*Diagnostic ID: [a-z0-9]+/) },
    });
    const id = String(log.mock.calls[0]?.[0]).split(" ")[1];
    expect(log.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      `save ${id} before batch: revision=1`,
      `save ${id} after batch: revision=2`,
      `save ${id} after persistence failure: revision=2`,
      `save ${id} awaitPersisted SDK error: Error: not persisted`,
    ]));
    expect(result).toMatchObject({ placement: { saved: expect.stringContaining(`Diagnostic ID: ${id}.`) } });
    expect(calls.filter((c) => c.fn === "batch")).toHaveLength(1);
  });

  it("labels the vacant preview and refuses a save on an occupied plot", async () => {
    const { capacity, calls } = setup();
    const args = { rules: { maxFullStoreys: 2 }, create: true };
    await expect(capacity({ ...args, preview: true })).resolves.toMatchObject({
      assumptions: expect.arrayContaining(["hypothetical: assumes existing buildings removed"]),
      placement: { preview: true },
    });
    await expect(capacity(args)).resolves.toMatchObject({ fix: expect.stringContaining('mode:"add"') });
    expect(calls.filter(({ fn }) => fn === "batch" || fn === "createFromFloorsBatch")).toHaveLength(0);
  });

  it("allows an addition with unchanged setbacks and spacing violations between existing buildings", async () => {
    const { capacity, ops, calls } = setup();
    const rules = { maxHeight: 12, minSetback: 12, minSpacing: 12 };
    const baseline = await ops.check({ rules });
    const result = await capacity({ mode: "add", create: true, rules });
    expect(result).toMatchObject({
      existingProblems: baseline.violations,
      validated: true,
      placement: { created: 1, items: [{ height: 12 }] },
    });
    expect(baseline.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "minSetback", id: expect.any(String) }),
      expect.objectContaining({ rule: "minSpacing", id: expect.any(String) }),
    ]));
    expect((await ops.check({ rules })).violations).toEqual(baseline.violations);
    expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(1);
  });

  it("checks available rectangles and rejects candidates that add a new site ratio finding", async () => {
    const { capacity, calls } = setup();
    const result = await capacity({ mode: "add", create: true, rules: {
      maxFullStoreys: 1, maxFar: 0.49, zoneRing: rect(0, 17, 20, 22),
    } });
    expect(result).toMatchObject({
      validated: false,
      best: { maxFootprint_m2: 440 },
      checks: { violations: [expect.objectContaining({ rule: "maxFar", id: expect.stringContaining("site") })] },
    });
    expect(result).not.toHaveProperty("placement");
    expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(0);
  });

  it("rejects a worsened shortfall with an unchanged facade and boundary identity", () => {
    const site = rect(0, 0, 50, 50);
    const rules = { abstand: { state: "BW" as const, area: "WA" as const } };
    const inspect = (height: number) => checkRules({ site, buildings: [
      { path: "root/existing", ring: rect(2, 20, 10, 10), height },
    ] }, rules).violations;
    const baseline = inspect(10);
    const worsened = inspect(11);
    expect(baseline).toHaveLength(1);
    expect(worsened.map((v) => v.id)).toEqual(baseline.map((v) => v.id));
    expect(addedOrWorsenedFindings(baseline, baseline)).toEqual([]);
    expect(addedOrWorsenedFindings(baseline, worsened)).toEqual([
      expect.objectContaining({ rule: "abstand", shortfall_m: 2.4, boundary_source: "plot_boundary" }),
    ]);
  });

  it.each([
    { maxGrz: 0.08, label: "GRZ" }, { maxGrz2: 0.09, label: "GRZ II" }, { maxGfz: 0.48, label: "GFZ" },
  ])("refuses a save when the site is already over $label", async ({ label, ...ratios }) => {
    const { capacity, calls } = setup();
    const result = await capacity({ mode: "add", create: true, rules: { maxFullStoreys: 1, ...ratios } });
    expect(result).toMatchObject({ summary: expect.stringContaining(`The site already exceeds the limit: ${label} is`), validated: false });
    expect(result).not.toHaveProperty("placement");
    expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(0);
  });

  it("clips footprints and measured floor polygons identically for check and capacity", async () => {
    const { capacity, F, ops, footprints, children, paths } = setup();
    const building = children[1];
    footprints.set(building.urn, rect(-20, 0, 20, 10));
    const floors = F.elements.representations.grossFloorAreaPolygons;
    F.elements.representations.grossFloorAreaPolygons = async (args: { urn: string }) => args.urn === building.urn
      ? { data: [{ elevation: 0, grossFloorPolygon: [rect(-20, 0, 20, 10)] },
          { elevation: 3, grossFloorPolygon: [rect(-8, 0, 8, 10)] }] }
      : floors(args);
    const calculate = F.areaMetrics.calculate;
    F.areaMetrics.calculate = async (args: { paths?: string[] }) => {
      const metrics = await calculate(args);
      if (args.paths?.length === 1 && args.paths[0] === paths.b1) {
        metrics.builtInMetrics.buildingCoverage.value = 180;
        metrics.builtInMetrics.grossFloorArea.functionBreakdown[0].value = 560;
      }
      return metrics;
    };
    const rules = { maxGrz: 0.2, maxGfz: 1 };
    const checked = await ops.check({ rules });
    const result = await capacity({ mode: "add", rules: { ...rules, maxFullStoreys: 2 } });
    expect(checked.summary).toMatchObject({ grz: 190 / 3500, gfz: 660 / 3500 });
    expect(result).toMatchObject({
      baselineRatios: { grz: checked.summary.grz, gfz: checked.summary.gfz },
      existing: { inventory: expect.arrayContaining([{ path: paths.b1, name: "Block A", floors: 2, footprint_m2: 90,
        totalFloorArea: { m2: 360, source: "measured" }, fullFloorArea: { m2: 360, source: "measured" } }]) },
    });
  });

  it("uses the clipped footprint share when only an aggregate floor area is available", async () => {
    const { capacity, F, ops, footprints, children, paths } = setup();
    const building = children[1];
    footprints.set(building.urn, rect(-20, 0, 20, 10));
    const measure = F.elements.representations.grossFloorAreaPolygons;
    F.elements.representations.grossFloorAreaPolygons = async (args: { urn: string }) =>
      args.urn === building.urn ? undefined : measure(args);
    const calculate = F.areaMetrics.calculate;
    F.areaMetrics.calculate = async (args: { paths?: string[] }) => {
      const metrics = await calculate(args);
      if (args.paths?.length === 1 && args.paths[0] === paths.b1)
        metrics.builtInMetrics.grossFloorArea.functionBreakdown[0].value = 1400;
      return metrics;
    };
    const rules = { maxGfz: 1, maxHeight: 12 };
    const checked = await ops.check({ rules });
    const result = await capacity({ mode: "add", rules });
    expect(checked.summary.gfz).toBe(1000 / 3500);
    expect(result).toMatchObject({
      baselineRatios: { gfz: checked.summary.gfz },
      existing: { inventory: expect.arrayContaining([expect.objectContaining({
        path: paths.b1, footprint_m2: 100, totalFloorArea: { m2: 700, source: "estimated" },
      })]) },
      summary: expect.stringContaining("Based on estimated floor area for: Block A."),
      validated: true,
    });
  });

  it("uses the default maximum when no storey or height cap was supplied", async () => {
    const { capacity } = setup();
    const result = await capacity({ rules: { maxGrz: 0.1 } });
    expect(result).toMatchObject({
      best: { storeys: 250 },
      assumptions: expect.arrayContaining([expect.stringMatching(/No height or storey limit given/)]),
    });
  });

  it.each([0, "UNABLE_TO_CALCULATE"])("matches the four-building live baseline when mesh coverage is %s", async (meshCoverage) => {
    const { F, ops, capacity, children, footprints, addBuilding } = setup();
    const plotArea = 4335.48985;
    const countedFootprint = 1648.81;
    const countedGfa = 10955;
    const meshFootprint = 394.79545;
    children.splice(1, 2);
    footprints.set(children[1].urn, rect(0, 0, plotArea / 50, 50));
    const a = 209.24379, b = 360, d = 615.95559, c = countedFootprint - a - b - d;
    const add = (x: number, y: number, footprint: number, height: number, floors: number, gfa = footprint * floors) =>
      addBuilding("Building 1", rect(x, y, footprint / 20, 20), height, {
        levels: Array.from({ length: floors }, () => rect(x, y, gfa / floors / 20, 20)),
      });
    add(1, 1, a, 21, 7);
    add(14, 1, b, 15.9, 11);
    add(34, 1, c, 9, 3);
    add(1, 26, d, 21, 7, countedGfa - a * 7 - b * 11 - c * 3);
    const meshRing = rect(36, 26, meshFootprint / 20, 20);
    const mesh = addBuilding("White building", meshRing, 18.8, { grouped: true, levels: [] });
    const calculate = F.areaMetrics.calculate;
    F.areaMetrics.calculate = async (args: { paths?: string[] }) => {
      const metrics = await calculate(args);
      if (args.paths?.length === 1 && args.paths[0] === mesh) metrics.builtInMetrics.buildingCoverage.value = meshCoverage;
      return metrics;
    };
    const rules = { maxGrz: 0.5, maxGfz: 2.8, maxFullStoreys: 5, abstand: { state: "BW", area: "WA" } };
    const check = await ops.check({ rules });
    const report = await ops.report({ rules });
    const result = await capacity({ mode: "add", rules });
    expect(check.summary.grz).toBeCloseTo(countedFootprint / plotArea, 10);
    expect(check.summary.gfz).toBeCloseTo(countedGfa / plotArea, 10);
    expect(check.summary).toMatchObject({ grz: expect.closeTo(0.3803, 4), gfz: expect.closeTo(2.5268, 4) });
    expect(check.plotInventory).toHaveLength(4);
    expect(check.plotInventory!.map((row) => row.path)).not.toContain(mesh);
    expect(report).toMatchObject({ check: { summary: check.summary } });
    expect(toHtml(report)).toContain("On the plot but not counted");
    expect(toCsv(report)).toContain("Not counted (no floor data in Forma)");
    expect(toFiguresCsv(report)).toContain("Site ratio contributor count;4");
    expect(toFiguresCsv(report)).not.toContain(mesh);
    expect(check.excludedContext).toEqual([expect.objectContaining({
      path: mesh, reason: "no floor data in Forma", footprint_m2: expect.closeTo(meshFootprint, 5),
      totalFloorArea: { m2: expect.closeTo(2368.77, 2), source: "estimated" },
    })]);
    expect(result).toMatchObject({
      baselineRatios: { grz: check.summary.grz, gfz: check.summary.gfz },
      existing: { inventory: expect.arrayContaining([expect.objectContaining({ name: "Building B (15.9 m)" })]),
        excludedContext: check.excludedContext },
      existingProblems: check.violations.filter((v) => v.path),
      baselineNotes: [expect.stringContaining("Full storeys (floor count unavailable for: White building)")],
      validated: true,
      block: { ring: expect.toSatisfy((ring: P2[]) => !ringsOverlap(meshRing, ring)) },
    });

    const included = await ops.check({ rules, includeContext: true });
    const includedReport = await ops.report({ rules, includeContext: true });
    const includedCapacity = await capacity({ mode: "add", rules, includeContext: true });
    expect(included.summary.grz).toBeCloseTo((countedFootprint + meshFootprint) / plotArea, 10);
    expect(included.summary.gfz).toBeCloseTo((countedGfa + meshFootprint * 6) / plotArea, 10);
    expect(included.summary.grz).toBeGreaterThan(Number(check.summary.grz));
    expect(included.summary.gfz).toBeGreaterThan(Number(check.summary.gfz));
    expect(includedReport).toMatchObject({ check: { summary: included.summary } });
    expect(toFiguresCsv(includedReport)).toContain(`Site ratio contributor;White building (${mesh})`);
    expect(includedCapacity).toMatchObject({
      summary: expect.stringContaining("No headroom"),
      baselineRatios: { grz: included.summary.grz, gfz: included.summary.gfz },
      existing: { excludedContext: [], inventory: expect.arrayContaining([expect.objectContaining({ path: mesh })]) },
    });
  });

  it("labels the geometry fallback across check, report and capacity when area metrics are unavailable", async () => {
    const { F, addBuilding, ops, capacity } = setup();
    const mesh = addBuilding("Mesh", rect(10, 20, 10, 10), 9, { levels: [] });
    const context = addBuilding("Context", rect(30, 20, 10, 10), 9, { context: true, levels: [] });
    F.areaMetrics.calculate = async () => { throw new Error("area metrics unavailable"); };
    const rules = { maxGrz: 0.01, maxGfz: 1, ancillaryArea_m2: 0 };
    const check = await ops.check({ rules });
    const report = await ops.report({ rules });
    const result = await capacity({ mode: "add", rules });
    expect(check).toMatchObject({
      inventoryNote: "Inventory not confirmed by Forma metrics.",
      summary: { grz: 400 / 3500, gfz: 2000 / 3500 },
      plotInventory: expect.arrayContaining([expect.objectContaining({ path: mesh })]),
      excludedContext: [expect.objectContaining({ path: context, reason: "context layer" })],
    });
    expect(report).toMatchObject({ check: { summary: check.summary, inventoryNote: check.inventoryNote } });
    expect(toFiguresCsv(report)).toContain("Inventory note;Inventory not confirmed by Forma metrics.");
    expect(result).toMatchObject({ inventoryNote: check.inventoryNote, baselineRatios: { grz: check.summary.grz, gfz: check.summary.gfz } });
  });

  it("saves with unknown existing full-storey counts and keeps context clear in both inventory modes", async () => {
    const { addBuilding, capacity, calls, ops } = setup();
    const ring = rect(2, 16, 10, 10);
    const path = addBuilding("Context building", ring, 18.8, { context: true, levels: [] });
    const rules = { maxFullStoreys: 2, maxGrz: 0.5, maxGfz: 2.8, abstand: { state: "BW", area: "WA" } };
    for (const includeContext of [false, true]) {
      const result: any = await capacity({ mode: "add", create: true, rules, includeContext });
      expect(result).toMatchObject({
        baselineNotes: [expect.stringContaining("floor count unavailable for: Context building")],
        existingProblems: expect.arrayContaining([expect.objectContaining({ rule: "abstand", other: path })]),
        validated: true, missingData: [], placement: { created: 1 },
      });
      expect(result.block.storeys).toBeLessThanOrEqual(2);
      expect(ringsOverlap(ring, result.block.footprintXY_m)).toBe(false);
      expect(result.block.footprintXY_m).toEqual(result.block.ring.map(([x, y]: P2) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]));
      await ops.undo({ steps: 1 });
    }
    expect(calls.filter(({ fn }) => fn === "createFromFloorsBatch")).toHaveLength(2);
  });

  it("bounds the no-cap search on a site with 100 context buildings and rejects exhausted ratios before the geometry search", async () => {
    const { addBuilding, capacity, F } = setup();
    for (let i = 0; i < 100; i++) {
      const column = i % 10, row = Math.floor(i / 10);
      addBuilding("Context", rect(-57 + column * 16, (row < 5 ? row - 5 : row + 1) * 14, 9, 9, i % 2 ? 10 : 0),
        9 + i % 9 * 1.5, { context: true, levels: [] });
    }
    const triangles = vi.spyOn(F.geometry, "getTriangles");
    const rules = { maxGrz: 0.5, maxGfz: 2.8, abstand: { state: "BW", area: "WA" } };
    let started = performance.now();
    const result = await capacity({ mode: "add", rules });
    const searchMs = performance.now() - started;
    expect(result).toMatchObject({ validated: true, block: { footprintXY_m: expect.any(Array) } });
    expect(result).toHaveProperty("rows");
    expect((result as { rows: unknown[] }).rows.length).toBeLessThan(250);
    expect(searchMs).toBeLessThan(3000);

    triangles.mockClear();
    started = performance.now();
    const refusal = await capacity({ mode: "add", rules: { ...rules, maxGrz: 300 / 3500 } });
    const refusalMs = performance.now() - started;
    expect(refusal).toMatchObject({ rows: [], summary: expect.stringContaining("No headroom"), validated: false,
      existing: { inventory: expect.arrayContaining([expect.objectContaining({ footprint_m2: 200 })]) } });
    expect(triangles.mock.calls.length).toBeLessThan(20);
    expect(refusalMs).toBeLessThan(200);
    console.log(`Capacity on 100 context buildings: ${searchMs.toFixed(1)} ms without a storey cap, ${refusalMs.toFixed(1)} ms without ratio headroom`);
  });

  it("returns the validated rectangle found before the candidate deadline", () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const result = calculateCapacity({
        plot: rect(0, 0, 30, 20), zones: [], rules: { maxFullStoreys: 3, maxGrz: 0.5 }, floorHeight: 3,
        existing: [], inventory: [],
        accepts: () => { now = 8001; return true; },
      });
      expect(result).toMatchObject({ block: { storeys: 3, gfa_m2: expect.closeTo(900), footprintXY_m: expect.any(Array) },
        searchNote: expect.stringContaining("time budget") });
    } finally {
      clock.mockRestore();
    }
  });

  it("places along a rotated zone and checks the saved addition", async () => {
    const { capacity, ops, children } = setup({ zones: [
      { name: "Existing", ring: rect(0, 0, 20, 10) },
      { name: "New", ring: rect(20, 18, 20, 4, 30) },
    ] });
    children.splice(2, 1);
    const rules = { maxHeight: 24, insideZone: true };
    const result = await capacity({ mode: "add", create: true, rules });
    expect(result).toMatchObject({ block: { footprint_m2: expect.closeTo(80, 4) }, placement: { created: 1 } });
    await expect(ops.check({ rules })).resolves.toMatchObject({ ok: true });
  });

  it("counts actual parking against GRZ II before saving on an empty plot", async () => {
    const { capacity, children, calls } = setup();
    children.splice(1, 2);
    const result = await capacity({ create: true, rules: { maxHeight: 6, maxGrz2: 0.01 } });
    expect(result).toMatchObject({
      checks: { violations: [expect.objectContaining({ rule: "maxGrz2", excess_m2: 15 })] },
    });
    expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(0);
  });

  it("rejects a second vacant save checked against the same proposal revision", async () => {
    const { capacity, children, calls } = setup();
    children.splice(1, 2);
    const args = { create: true, rules: { maxHeight: 6, maxGrz: 0.2 } };
    const results = await Promise.allSettled([capacity(args), capacity(args)]);
    expect(results).toContainEqual(expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ placement: expect.objectContaining({ created: 1 }) }) }));
    expect(results).toContainEqual(expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ fix: expect.any(String) }) }));
    expect(calls.filter(({ fn }) => fn === "batch")).toHaveLength(1);
  });

  it("shrinks an addition when even the largest open rectangle exceeds FAR", async () => {
    const { capacity } = setup();
    const result = await capacity({ mode: "add", create: true, rules: { maxHeight: 24, maxFar: 0.6 } });
    expect(result).toMatchObject({
      block: { gfa_m2: expect.toSatisfy((value: number) => value > 200 && value < 420) },
      placement: { created: 1 },
    });
  });

  it("uses Forma GFA without floor polygons and preserves a verified zero", async () => {
    const { F, capacity, ops, paths, children, els } = setup({ nativeFloors: true });
    delete els.get(children[1].urn)!.children;
    const metrics = F.areaMetrics.calculate;
    F.areaMetrics.calculate = async (args: { paths?: string[] }) => {
      const result = await metrics(args);
      if (args.paths?.length === 1 && args.paths[0] === paths.b2)
        result.builtInMetrics.grossFloorArea.functionBreakdown[0].value = 0;
      return result;
    };
    F.elements.representations.grossFloorAreaPolygons = async () => undefined;
    const rules = { maxGfz: 0.45, maxHeight: 25 };
    const checked = await ops.check({ rules });
    expect(checked.checked).toContain("maxGfz");
    expect(checked.skipped).toEqual([]);
    expect(checked.summary.gfz).toBe(1400 / 3500);
    const result = await capacity({ mode: "add", create: true, rules });
    expect(result).toMatchObject({
      estimated: false,
      validated: true,
      missingData: [],
      placement: { created: 1 },
      existing: { floorArea_m2: 1400, estimatedBuildings: [],
        inventory: expect.arrayContaining([expect.objectContaining({ path: paths.b2, totalFloorArea: { m2: 0, source: "measured" } })]) },
      best: { maxGfa_m2: 175 },
    });
  });

  it("renders both outward triangles of each quad and clears both overlay types", async () => {
    const { capacity, ops, calls } = setup();
    await ops.check({ rules: { abstand: {} }, show: true });
    const result = await capacity({ preview: true, rules: { maxHeight: 6, zoneRing: rect(0, 20, 12, 8) } });
    expect(result).toMatchObject({ block: { footprint_m2: 96 } });
    const mesh = calls.find(({ fn }) => fn === "render.addMesh")?.arg.geometryData;
    expect(mesh?.index).toBeUndefined();
    expect(mesh?.position).toHaveLength(108);
    expect(mesh?.normal).toHaveLength(108);
    const top: P2[][] = [];
    for (let i = 0; i < mesh.position.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = mesh.position.slice(i, i + 9);
      const [nx, ny, nz] = mesh.normal.slice(i, i + 3);
      const u = [bx - ax, by - ay, bz - az], v = [cx - ax, cy - ay, cz - az];
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      expect(cross[0] * nx + cross[1] * ny + cross[2] * nz).toBeCloseTo(Math.hypot(...cross));
      expect(nx * (ax - 6) + ny * (ay - 24) + nz * (az - 103)).toBeGreaterThan(0);
      if (nz === 1) top.push([[ax, ay], [bx, by], [cx, cy]]);
    }
    expect(top.map(signedArea)).toEqual([48, 48]);
    expect(new Set(top.flat().map((point) => point.join(",")))).toEqual(new Set(["0,20", "12,20", "12,28", "0,28"]));
    await ops.view({ action: "clear_overlays" });
    expect(calls.map(({ fn }) => fn)).toEqual(expect.arrayContaining(["geojson.add", "geojson.cleanup", "render.cleanup"]));
  });

  it("handles a concave site and a collapsed inset", async () => {
    const { capacity, footprints, children, paths } = setup();
    const site = children.find((c) => `root/${c.key}` === paths.site);
    if (!site) throw new Error("missing mock site");
    footprints.set(site.urn, [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]);
    const result = await capacity({ rules: { maxFullStoreys: 6, abstand: {} } });
    expect(result).toMatchObject({ plotArea_m2: 500, rows: expect.arrayContaining([
      expect.objectContaining({ storeys: 1, buildable_m2: expect.toSatisfy((value: number) => value > 150 && value < 220) }),
      expect.objectContaining({ storeys: 6, maxGfa_m2: 0 }),
    ]) });
  });
});
