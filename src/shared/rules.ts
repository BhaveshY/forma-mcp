// Planning-rule check (height, floors, FAR, coverage, boundary setback, spacing) — pure, testable.
// Forma has no built-in check of a design against the user's own limits; this is that check.
import { checkAbstand, type AbstandOptions, type AbstandResult, type AbstandRoads, type prepareAbstandGeometry } from "./abstand.js";
import { type P2, area, cleanRing, pointInPoly, ringLocation, r1, r2 } from "./geom.js";

export type Rules = {
  maxHeight?: number; // m
  maxFloors?: number;
  maxFar?: number;
  maxCoverage?: number; // percent of site area
  minSetback?: number; // m from the site boundary
  minSpacing?: number; // m between buildings
  maxGrz?: number;
  maxGrz2?: number;
  ancillaryArea_m2?: number;
  maxGfz?: number;
  nonFullTopFloors?: number;
  maxFullStoreys?: number;
  insideZone?: boolean;
  zone?: string;
  zoneRing?: P2[];
  abstand?: AbstandOptions;
};

export type RuleBuilding = { path: string; name?: string; ring: P2[]; height?: number; floors?: number };
export type Storeys = Pick<RuleBuilding, "path" | "name" | "floors"> & { floorAreas?: number[]; floorArea?: number };
export type FloorArea = { m2: number; source: "measured" | "estimated" };
export type PlotBuilding = Pick<Storeys, "path" | "name" | "floors"> & {
  footprint_m2: number;
  totalFloorArea?: FloorArea;
  fullFloorArea?: FloorArea;
};
export type ExcludedPlotBuilding = PlotBuilding & { reason: "no floor data in Forma" | "context layer" };
export const unconfirmedInventoryNote = "Inventory not confirmed by Forma metrics.";
export type BuildingZone = { name: string; ring: P2[] };
export type RuleInput = {
  site?: P2[]; siteArea?: number; gfa?: number; footprint?: number; buildings: RuleBuilding[];
  plotInventory?: PlotBuilding[]; plotArea?: number; plotFootprint?: number | null; parkingArea?: number;
  storeys?: Storeys[]; plotStoreys?: Storeys[] | null; zones?: BuildingZone[];
  abstandTargets?: (Omit<RuleBuilding, "ring"> & { ring?: P2[] })[];
  abstandNeighbours?: RuleInput["abstandTargets"];
  abstandRoads?: AbstandRoads;
  abstandChangedPath?: string;
  abstandGeometry?: ReturnType<typeof prepareAbstandGeometry>;
  germanFigures?: boolean;
};
export type Violation = { id?: string; severity?: number; path?: string; name?: string; other?: string; actual: number; limit: number; text: string } & (
  { rule: Exclude<keyof Rules, "abstand"> | "overlap"; excess_m2?: number }
  | { rule: "abstand"; facade: string; facade_index: number; shortfall_m: number; overlap_m: number; citation: string; source_url: string;
      other_facade_index?: number; boundary_source?: "plot_boundary" | "road_centreline"; road_contributed?: boolean; road_allowance_m?: number }
);
export type RuleReport = { ok: boolean; checked: string[]; skipped: string[]; violations: Violation[]; summary: Record<string, number | string>; abstand?: AbstandResult };

function findingId(v: Violation): string {
  if (v.rule === "abstand")
    return JSON.stringify([v.rule, v.path, v.facade_index, v.other ?? v.boundary_source, v.other_facade_index]);
  if (v.rule === "minSpacing") return JSON.stringify([v.rule, ...[v.path, v.other].sort()]);
  return JSON.stringify([v.rule, v.path ?? "site", v.rule === "minSetback" ? "plot_boundary" : v.rule === "insideZone" ? "building_zone" : v.other]);
}

export function addedOrWorsenedFindings(baseline: Violation[], candidate: Violation[]): Violation[] {
  const severity = (v: Violation) => v.severity ?? (v.rule === "abstand" ? v.shortfall_m
    : v.excess_m2 ?? Math.abs(v.actual - v.limit));
  const previous = new Map(baseline.map((v) => [findingId(v), severity(v)]));
  return candidate.filter((v) => severity(v) > (previous.get(findingId(v)) ?? -Infinity) + 1e-7);
}

function segDist(a: P2, b: P2, c: P2, d: P2): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function ptSeg(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const orient = (a: P2, b: P2, c: P2) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
function segmentsCross(a: P2, b: P2, c: P2, d: P2) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
const edges = (r: P2[]) => r.map((p, i) => [p, r[(i + 1) % r.length]] as [P2, P2]);

/** Smallest distance between two polygon outlines; 0 when they touch, cross or one contains the other. */
export function ringDistance(a: P2[], b: P2[]): number {
  if (pointInPoly(a[0], b) || pointInPoly(b[0], a)) return 0;
  let m = Infinity;
  for (const [p, q] of edges(a)) for (const [r, s] of edges(b)) m = Math.min(m, segDist(p, q, r, s));
  return m;
}

/** Distance from a building to the site boundary, measured inwards; negative when it sticks out. */
export function setback(ring: P2[], site: P2[]): number {
  let m = Infinity;
  for (const p of ring) for (const [r, s] of edges(site)) m = Math.min(m, ptSeg(p, r, s));
  for (const [p, q] of edges(ring)) for (const [r, s] of edges(site)) m = Math.min(m, segDist(p, q, r, s));
  const out = ring.filter((p) => !pointInPoly(p, site));
  if (!out.length) return m;
  return -Math.max(outsideCornerDepth(out, site), 0.01);
}

function outsideCornerDepth(outside: P2[], boundary: P2[]): number {
  const outline = edges(boundary);
  return outside.reduce((depth, p) => Math.max(depth, Math.min(...outline.map(([a, b]) => ptSeg(p, a, b)))), 0);
}

const label = (b: Pick<RuleBuilding, "name" | "path">) => b.name || b.path;
export const hasStoreyRule = (rules: Rules) => rules.maxGfz !== undefined || rules.maxFullStoreys !== undefined;
export const hasGrz2Rule = (rules: Rules) => rules.maxGrz !== undefined || rules.maxGrz2 !== undefined;
export const hasGermanRules = (rules: Rules) => hasGrz2Rule(rules) || hasStoreyRule(rules) || Object.keys(rules).some((key) =>
  ["ancillaryArea_m2", "nonFullTopFloors", "insideZone", "zone", "zoneRing", "abstand"].includes(key));
export const fullStoreys = (floors: number | undefined, excluded: number) =>
  floors === undefined ? undefined : Math.max(0, floors - excluded);

export function fullFloorArea(b: Storeys, excluded: number): number | undefined {
  if (excluded === 0 && b.floorArea !== undefined) return b.floorArea;
  if (fullStoreys(b.floors, excluded) === 0) return 0;
  if (excluded > 0 && (b.floors === undefined || b.floorAreas?.length !== b.floors)) return undefined;
  return b.floorAreas?.slice(0, Math.max(0, b.floorAreas.length - excluded)).reduce((sum, a) => sum + a, 0);
}

export const grz2LimitFor = (rules: Rules) =>
  rules.maxGrz2 ?? (rules.maxGrz === undefined ? undefined : Number(Math.min(rules.maxGrz * 1.5, 0.8).toPrecision(15)));

function germanRules(inp: RuleInput, rules: Rules, { checked, skipped, summary, violations }: RuleReport) {
  const plot = inp.plotArea ?? inp.siteArea;
  const grz2Limit = grz2LimitFor(rules);
  const ratios = [
    { rule: "maxGrz", key: "grz", label: "GRZ", limit: rules.maxGrz, units: "footprint" },
    { rule: "maxGrz2", key: "grz2", label: "GRZ II", limit: grz2Limit, units: "footprint and ancillary area" },
    { rule: "maxGfz", key: "gfz", label: "GFZ", limit: rules.maxGfz, units: "floor area" },
  ] as const;
  const storeys = inp.storeys ?? inp.buildings;
  const excluded = rules.nonFullTopFloors ?? 0;
  const footprint = inp.plotFootprint === undefined
    ? inp.buildings.reduce((s, b) => s + area(b.ring), 0) : inp.plotFootprint;
  if (grz2Limit !== undefined) {
    summary.grz2_limit = Number(grz2Limit.toPrecision(15));
    summary.grz2_limit_source = rules.maxGrz2 === undefined ? "1.5 × GRZ limit, capped at 0.8" : "Explicit GRZ II limit";
  }
  for (const { rule, key, label, limit, units } of ratios) {
    if (limit === undefined && !inp.germanFigures) continue;
    if (!plot) {
      skipped.push(`${label} (no site boundary)`);
      continue;
    }
    if (rule !== "maxGfz" && footprint === null) {
      skipped.push(`${label} (Forma could not read all building footprints)`);
      continue;
    }
    let total = footprint ?? 0;
    if (rule === "maxGrz2") {
      const ancillary = rules.ancillaryArea_m2 ?? inp.parkingArea;
      if (ancillary === undefined) {
        skipped.push("GRZ II (ancillary area is unavailable. Enter ancillaryArea_m2, or enter 0 if there is none.)");
        continue;
      }
      summary.grz2_area_source = rules.ancillaryArea_m2 !== undefined ? "Entered ancillary area" : "Forma parking spaces only. Enter ancillaryArea_m2 to include all ancillary surfaces.";
      total += ancillary;
    }
    if (rule === "maxGfz") {
      if (inp.plotInventory) {
        const missing = inp.plotInventory.filter((b) => !b.fullFloorArea);
        if (missing.length) {
          skipped.push(`GFZ (floor area unavailable for: ${missing.map((b) => b.name ?? b.path).join(", ")})`);
          continue;
        }
        total = inp.plotInventory.reduce((sum, b) => sum + (b.fullFloorArea?.m2 ?? 0), 0);
        const estimated = inp.plotInventory.filter((b) => b.fullFloorArea?.source === "estimated");
        if (estimated.length) summary.gfz_basis = `based on estimated floor area for: ${estimated.map((b) => b.name ?? b.path).join(", ")}`;
      } else {
        if (inp.plotStoreys === null) {
          skipped.push("GFZ (Forma could not read the buildings inside the site boundary)");
          continue;
        }
        const areas = (inp.plotStoreys ?? storeys).map((b) => fullFloorArea(b, excluded));
        if (excluded === 0 && inp.storeys === undefined && inp.plotStoreys === undefined && inp.gfa !== undefined) total = inp.gfa;
        else if (areas.some((a) => a === undefined)) {
          skipped.push("GFZ (Forma could not read the required floor areas)");
          continue;
        } else total = areas.reduce<number>((sum, a) => sum + (a ?? 0), 0);
      }
    }
    const actual = total / plot;
    summary[key] = actual;
    if (limit === undefined) continue;
    checked.push(rule);
    const displayLimit = Number(limit.toPrecision(15));
    const excess = total - limit * plot;
    if (excess > 1e-6) {
      let display = r2(actual);
      for (let digits = 3; display <= displayLimit && digits <= 15; digits++) display = Number(actual.toFixed(digits));
      if (display <= displayLimit) display = actual;
      violations.push({ rule, actual, limit, excess_m2: excess, text: `${label} is ${display} (limit ${displayLimit}); ${excess < 1 ? "less than 1" : Math.round(excess)} m² too much ${units}` });
    }
  }
  if (hasStoreyRule(rules)) {
    summary.full_storeys_assumption = excluded === 0
      ? "All modelled floors are counted as full storeys."
      : `The top ${excluded === 1 ? "floor is" : `${excluded} floors are`} excluded from each building. All remaining floors are counted as full storeys.`;
    const limit = rules.maxFullStoreys;
    const counts = storeys.flatMap((b) => {
      const actual = fullStoreys(b.floors, excluded);
      if (actual === undefined) return [];
      if (limit !== undefined && actual > limit)
        violations.push({ rule: "maxFullStoreys", path: b.path, name: b.name, actual, limit, text: `${label(b)} has ${actual} full storeys (limit ${limit})` });
      return [actual];
    });
    if (counts.length || !storeys.length) summary.max_full_storeys = Math.max(0, ...counts);
    if (limit !== undefined) {
      if (counts.length || !storeys.length) checked.push("maxFullStoreys");
      if (counts.length < storeys.length) skipped.push(`Full storeys (floor count unavailable for: ${storeys.filter((b) => b.floors === undefined).map((b) => label(b)).join(", ")})`);
    }
  }
  if (rules.insideZone) {
    const name = rules.zone?.trim().toLowerCase();
    const zones = rules.zoneRing ? [{ name: rules.zone ?? "Supplied polygon", ring: cleanRing(rules.zoneRing) }]
      : (inp.zones ?? []).filter((z) => !name || z.name.toLowerCase() === name);
    if (!zones.length) {
      skipped.push("insideZone (no building zone drawn)");
      return;
    }
    checked.push("insideZone");
    summary.zone = [...new Set(zones.map((z) => z.name))].join(", ");
    for (const b of inp.buildings) {
      if (zones.some(({ ring }) => !ringLocation(b.ring, ring).outside)) continue;
      const severity = Math.min(...zones.map(({ ring }) => outsideCornerDepth(b.ring.filter((p) => !pointInPoly(p, ring)), ring)));
      const depth = r2(severity);
      const text = depth > 0 ? `${label(b)} extends ${depth} m beyond the building zone` : `${label(b)} crosses the building zone boundary`;
      violations.push({ rule: "insideZone", severity, path: b.path, name: b.name, actual: depth, limit: 0, text });
    }
  }
}

export function checkRules(inp: RuleInput, rules: Rules): RuleReport {
  const v: Violation[] = [];
  const checked: string[] = [];
  const skipped: string[] = [];
  const summary: Record<string, number | string> = { buildings: inp.buildings.length };
  const has = (k: keyof Rules) => typeof rules[k] === "number" && Number.isFinite(rules[k]);

  if (has("maxHeight")) {
    checked.push("maxHeight");
    const known = inp.buildings.filter((b) => b.height !== undefined);
    summary.tallest_m = known.length ? r1(Math.max(...known.map((b) => b.height!))) : "n/a";
    for (const b of known) if (b.height! > rules.maxHeight! + 0.01)
      v.push({ rule: "maxHeight", severity: b.height! - rules.maxHeight!, path: b.path, name: b.name, actual: r1(b.height!), limit: rules.maxHeight!, text: `${label(b)} is ${r1(b.height!)} m tall (limit ${rules.maxHeight} m)` });
  }
  if (has("maxFloors")) {
    checked.push("maxFloors");
    for (const b of inp.buildings) if (b.floors !== undefined && b.floors > rules.maxFloors!)
      v.push({ rule: "maxFloors", path: b.path, name: b.name, actual: b.floors, limit: rules.maxFloors!, text: `${label(b)} has ${b.floors} floors (limit ${rules.maxFloors})` });
  }
  if (has("maxFar")) {
    if (inp.siteArea && inp.gfa !== undefined) {
      checked.push("maxFar");
      const far = r2(inp.gfa / inp.siteArea);
      summary.far = far;
      if (far > rules.maxFar! + 0.005) v.push({ rule: "maxFar", actual: far, limit: rules.maxFar!, severity: inp.gfa / inp.siteArea - rules.maxFar!, text: `FAR is ${far} (limit ${rules.maxFar}); ${Math.round(inp.gfa - rules.maxFar! * inp.siteArea)} m² too much floor area` });
    } else skipped.push(inp.siteArea ? "maxFar (floor area unavailable)" : "maxFar (no site boundary)");
  }
  if (has("maxCoverage")) {
    const fp = inp.footprint ?? inp.buildings.reduce((s, b) => s + area(b.ring), 0);
    if (inp.siteArea) {
      checked.push("maxCoverage");
      const pct = r1((fp / inp.siteArea) * 100);
      summary.coverage_pct = pct;
      if (pct > rules.maxCoverage! + 0.05) v.push({ rule: "maxCoverage", actual: pct, limit: rules.maxCoverage!, severity: fp / inp.siteArea * 100 - rules.maxCoverage!, text: `Site coverage is ${pct}% (limit ${rules.maxCoverage}%)` });
    } else skipped.push("maxCoverage (no site boundary)");
  }
  if (has("minSetback")) {
    if (inp.site && inp.site.length > 2) {
      checked.push("minSetback");
      let worst = Infinity;
      for (const b of inp.buildings) {
        const distance = setback(b.ring, inp.site);
        const d = r2(distance);
        worst = Math.min(worst, d);
        if (d < rules.minSetback! - 0.01)
          v.push({ rule: "minSetback", severity: rules.minSetback! - distance, path: b.path, name: b.name, actual: d, limit: rules.minSetback!, text: d < 0 ? `${label(b)} extends ${-d} m beyond the site boundary` : `${label(b)} is ${d} m from the site boundary (minimum ${rules.minSetback} m)` });
      }
      if (Number.isFinite(worst)) summary.closest_to_boundary_m = worst;
    } else skipped.push("minSetback (no site boundary)");
  }
  if (has("minSpacing")) {
    checked.push("minSpacing");
    const bs = inp.buildings;
    let worst = Infinity;
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const distance = ringDistance(bs[i].ring, bs[j].ring);
        const d = r2(distance);
        worst = Math.min(worst, d);
        if (d < rules.minSpacing! - 0.01)
          v.push({ rule: "minSpacing", severity: rules.minSpacing! - distance, path: bs[i].path, name: bs[i].name, other: bs[j].path, actual: d, limit: rules.minSpacing!, text: d === 0 ? `${label(bs[i])} touches or overlaps ${label(bs[j])}` : `${label(bs[i])} and ${label(bs[j])} are ${d} m apart (minimum ${rules.minSpacing} m)` });
      }
    if (Number.isFinite(worst)) summary.closest_buildings_m = worst;
  }
  const report: RuleReport = { ok: true, checked, skipped, violations: v, summary };
  if (inp.germanFigures || hasGermanRules(rules)) germanRules(inp, rules, report);
  if (rules.abstand) report.abstand = checkAbstand(rules.abstand, {
    site: inp.site, targets: inp.abstandTargets ?? inp.buildings, neighbours: inp.abstandNeighbours ?? [],
    roads: inp.abstandRoads, changedPath: inp.abstandChangedPath, geometry: inp.abstandGeometry,
  }, report);
  for (const finding of v) finding.id = findingId(finding);
  report.ok = v.length === 0;
  return report;
}
