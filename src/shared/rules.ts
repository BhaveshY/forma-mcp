// Planning-rule check (height, floors, FAR, coverage, boundary setback, spacing) — pure, testable.
// Forma has no built-in check of a design against the user's own limits; this is that check.
import { type P2, area, pointInPoly, r1, r2 } from "./geom.js";

export type Rules = {
  maxHeight?: number; // m
  maxFloors?: number;
  maxFar?: number;
  maxCoverage?: number; // percent of site area
  minSetback?: number; // m from the site boundary
  minSpacing?: number; // m between buildings
};

export type RuleBuilding = { path: string; name?: string; ring: P2[]; height?: number; floors?: number };
export type RuleInput = { site?: P2[]; siteArea?: number; gfa?: number; footprint?: number; buildings: RuleBuilding[] };
export type Violation = { rule: keyof Rules; path?: string; name?: string; other?: string; actual: number; limit: number; text: string };
export type RuleReport = { ok: boolean; checked: string[]; skipped: string[]; violations: Violation[]; summary: Record<string, number | string> };

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
  // sticking out: how far the furthest corner is beyond the boundary
  let depth = 0;
  for (const p of out) depth = Math.max(depth, Math.min(...edges(site).map(([r, s]) => ptSeg(p, r, s))));
  return -Math.max(depth, 0.01);
}

const label = (b: RuleBuilding) => b.name || b.path;

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
      v.push({ rule: "maxHeight", path: b.path, name: b.name, actual: r1(b.height!), limit: rules.maxHeight!, text: `${label(b)} is ${r1(b.height!)} m tall (limit ${rules.maxHeight} m)` });
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
      if (far > rules.maxFar! + 0.005) v.push({ rule: "maxFar", actual: far, limit: rules.maxFar!, text: `FAR is ${far} (limit ${rules.maxFar}); ${Math.round(inp.gfa - rules.maxFar! * inp.siteArea)} m² too much floor area` });
    } else skipped.push("maxFar (no site boundary)");
  }
  if (has("maxCoverage")) {
    const fp = inp.footprint ?? inp.buildings.reduce((s, b) => s + area(b.ring), 0);
    if (inp.siteArea) {
      checked.push("maxCoverage");
      const pct = r1((fp / inp.siteArea) * 100);
      summary.coverage_pct = pct;
      if (pct > rules.maxCoverage! + 0.05) v.push({ rule: "maxCoverage", actual: pct, limit: rules.maxCoverage!, text: `Site coverage is ${pct}% (limit ${rules.maxCoverage}%)` });
    } else skipped.push("maxCoverage (no site boundary)");
  }
  if (has("minSetback")) {
    if (inp.site && inp.site.length > 2) {
      checked.push("minSetback");
      let worst = Infinity;
      for (const b of inp.buildings) {
        const d = r2(setback(b.ring, inp.site));
        worst = Math.min(worst, d);
        if (d < rules.minSetback! - 0.01)
          v.push({ rule: "minSetback", path: b.path, name: b.name, actual: d, limit: rules.minSetback!, text: d < 0 ? `${label(b)} extends ${-d} m beyond the site boundary` : `${label(b)} is ${d} m from the site boundary (minimum ${rules.minSetback} m)` });
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
        const d = r2(ringDistance(bs[i].ring, bs[j].ring));
        worst = Math.min(worst, d);
        if (d < rules.minSpacing! - 0.01)
          v.push({ rule: "minSpacing", path: bs[i].path, name: bs[i].name, other: bs[j].path, actual: d, limit: rules.minSpacing!, text: d === 0 ? `${label(bs[i])} touches or overlaps ${label(bs[j])}` : `${label(bs[i])} and ${label(bs[j])} are ${d} m apart (minimum ${rules.minSpacing} m)` });
      }
    if (Number.isFinite(worst)) summary.closest_buildings_m = worst;
  }
  return { ok: v.length === 0, checked, skipped, violations: v, summary };
}
