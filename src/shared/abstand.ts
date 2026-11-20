import { ABSTAND_DATA, type AbstandLaw, type AbstandState } from "./abstand-data.js";
import { area, facadeAngle, facadeEdges, plotStripBoundary, r2, ringBounds, ringBoundsOverlap, selfIntersects, setbackStrip, stripOverlap,
  type P2, type RoadSurface, type SetbackStrip } from "./geom.js";
import type { RuleBuilding, RuleReport, Violation } from "./rules.js";

export type AbstandOptions = { state?: AbstandState; area?: string; allowRoadHalf?: boolean; bayern16m?: boolean };
export type AbstandRoads = { surfaces: RoadSurface[]; missingWidth: number; unreadable: number; estimatedCentre: boolean; publicUnconfirmed: boolean };
type Building = Omit<RuleBuilding, "ring"> & { ring?: P2[] };
type Strip = SetbackStrip & { path: string; name: string; facade: number; factor: number; bad: boolean };
type BuildingResult = { path: string; name: string } & (
  { status: "ok" | "shortfall"; minShortfall_m: number; maxShortfall_m: number }
  | { status: "manual"; reason: string }
);
export type AbstandResult = {
  state: AbstandState;
  area: string;
  factor: number | string | null;
  citation: string;
  url: string;
  assumptions: string[];
  incomplete?: true;
  buildings: BuildingResult[];
  strips: Strip[];
  fix?: string;
};

const AREA_NAMES: Record<string, string> = {
  WA: "Allgemeines Wohngebiet", WR: "Reines Wohngebiet", MI: "Mischgebiet", MU: "Urbanes Gebiet",
  MK: "Kerngebiet", MD: "Dorfgebiet", GE: "Gewerbegebiet", GI: "Industriegebiet",
  MDW: "Dörfliches Wohngebiet", WB: "Besonderes Wohngebiet",
};
const getArea = (name?: string) => {
  const value = name?.trim();
  return value && (Object.hasOwn(AREA_NAMES, value.toUpperCase()) ? AREA_NAMES[value.toUpperCase()] : value);
};
const nameOf = (b: Building) => b.name || b.path;
const labelStrip = (s: Strip) => `${s.name}, ${s.direction} façade ${s.facade}`;
const EPS = 1e-8;
const rounded = (v: number) => v > EPS && r2(v) === 0 ? Number(v.toPrecision(2)) : r2(v);
export const validAbstandRing = (r: P2[] | undefined): r is P2[] =>
  !!r && r.length >= 3 && r.every((p) => p.every(Number.isFinite)) && area(r) > EPS && !selfIntersects(r);
export const statutoryDepth = (state: AbstandState, height: number, factor: number, minimum: number) =>
  Math.max(minimum, state === "HE" || state === "NI" ? Math.floor(height * factor * 10 + EPS) / 10 : height * factor);

function manualReason(law: AbstandLaw, factor: AbstandLaw["base_factor"]) {
  if (law.code === "MV") return "Gebäudeklasse und Vorrang der Gebietsregel müssen geprüft werden";
  if (factor === null) return "die Vorschrift nennt keinen festen Faktor für diese Einzelfallzulassung";
  if (factor === "uncertain") return "der Faktor ist in der Quelle als unklar vermerkt";
}

export function resolveAbstand(options: AbstandOptions) {
  const state = options.state ?? "MBO";
  const law: AbstandLaw = ABSTAND_DATA.find((entry) => entry.code === state) ?? ABSTAND_DATA[0];
  const areaName = getArea(options.area);
  const reduced = law.reduced.find((r) => r.area_type.toLowerCase() === areaName?.toLowerCase());
  const areaKey = areaName?.toLowerCase();
  const bayern = state === "BY" && options.bayern16m && !["gewerbegebiet", "industriegebiet", "kerngebiet", "urbanes gebiet"].includes(areaKey ?? "");
  const factor = bayern ? 1 : reduced ? reduced.factor : law.base_factor;
  return { state, law, areaName, reduced, areaKey, bayern, factor, reason: manualReason(law, factor) };
}

/** Full-depth geometry and neighbour bounds, shared by the baseline and its candidate checks. */
export function prepareAbstandGeometry(options: AbstandOptions, buildings: Building[]) {
  const { state, law, reduced, factor, reason } = resolveAbstand(options);
  const bounds = new WeakMap<P2[], ReturnType<typeof ringBounds>>();
  const boundsFor = (ring: P2[]) => {
    const cached = bounds.get(ring);
    if (cached) return cached;
    const result = ringBounds(ring);
    bounds.set(ring, result);
    return result;
  };
  const geometryFor = (b: Building) => {
    const ring = validAbstandRing(b.ring) ? b.ring : undefined;
    const manual = reason ?? (!ring ? "der Gebäudeumriss fehlt oder ist ungültig"
      : b.height === undefined || !Number.isFinite(b.height) || b.height <= 0 ? "die Gebäudehöhe fehlt oder ist ungültig" : undefined);
    const { height } = b;
    const strips: Strip[] = !manual && typeof factor === "number" && ring && height !== undefined
      ? facadeEdges(ring).map((facade, i) => {
        const minimum = state === "BW" && facade.width <= 5 + EPS ? 2 : reduced?.min_m ?? law.min_m;
        return { ...setbackStrip(facade, statutoryDepth(state, height, factor, minimum)), path: b.path,
          name: nameOf(b), facade: i + 1, factor, bad: false };
      }) : [];
    if (ring) boundsFor(ring);
    for (const strip of strips) boundsFor(strip.ring);
    return { ring, manual, strips };
  };
  const index = new Map(buildings.map((building) => [building, geometryFor(building)]));
  return {
    get: (building: Building) => index.get(building) ?? geometryFor(building),
    overlaps: (a: P2[], b: P2[]) => ringBoundsOverlap(boundsFor(a), boundsFor(b)),
  };
}

export function checkAbstand(
  options: AbstandOptions, input: { site?: P2[]; targets: Building[]; neighbours: Building[]; roads?: AbstandRoads;
    stripsOnly?: boolean; changedPath?: string; geometry?: ReturnType<typeof prepareAbstandGeometry> },
  report: RuleReport,
): AbstandResult {
  const { state, law, areaName, reduced, areaKey, bayern, factor, reason } = resolveAbstand(options);
  const site = validAbstandRing(input.site) ? input.site : undefined;
  const roads = options.allowRoadHalf === false || !site ? [] : input.roads?.surfaces ?? [];
  const citation = `${law.section} ${law.statute}`;
  const assumptions = [
    "Flachdach angenommen. Forma liefert hier keine Dachneigung oder Dachhöhe. Die Modellhöhe gilt als Wandhöhe über dem Gelände.",
    "Örtliche Satzungen, Gebäudeklassen-Ausnahmen, Baulasten und andere Sonderzulassungen sind gesondert zu prüfen.",
  ];
  if (state === "MBO") assumptions.push(options.state === undefined
    ? "Kein Bundesland angegeben. Geprüft nach der Musterbauordnung (MBO)." : "Die MBO ist eine Musterregelung.");
  if (reduced && ["HH", "HE", "NI", "NW", "SH"].includes(state))
    assumptions.push("Für die Gebietsermäßigung ist die Nutzung angrenzender Gebiete gesondert zu prüfen.");
  if (state === "NW" && ["kerngebiet", "urbanes gebiet"].includes(areaKey ?? ""))
    assumptions.push("Der abweichende Faktor zu öffentlichen Verkehrs-, Grün- oder Wasserflächen ist fassadenbezogen gesondert zu prüfen.");
  if (state === "NI") assumptions.push("Überdeckungen werden als Hinweis für die Prüfung der gedachten Grenze ausgewiesen.");
  if (bayern) assumptions.push("Art. 6 Abs. 5a BayBO aktiviert. Gemeindegröße und Prägung durch Gebäudeklassen 1–3 gelten als bestätigt.");
  if (options.allowRoadHalf === false) assumptions.push("Straßenflächen bleiben auf Wunsch unberücksichtigt.");
  else {
    if (input.roads?.missingWidth) assumptions.push(`${input.roads.missingWidth} Straßenlinie(n) ohne Breite bleiben unberücksichtigt.`);
    if (input.roads?.unreadable) assumptions.push(`${input.roads.unreadable} Straße(n) mit nicht lesbarer Geometrie bleiben unberücksichtigt.`);
    if (roads.length && input.roads?.estimatedCentre) assumptions.push("Die Straßenmitte wird aus dem Querschnitt der angrenzenden Straßengeometrie geschätzt.");
    if (roads.length && input.roads?.publicUnconfirmed) assumptions.push("Forma-Straßen mit Geometrie gelten als öffentlich, soweit ihr Status unbekannt ist. Bitte den Status vor Ort prüfen.");
  }
  const result: AbstandResult = {
    state, area: reduced?.area_type ?? areaName ?? "Allgemeiner Regelwert", factor: reason || typeof factor !== "number" ? null : factor,
    citation, url: law.url, assumptions, buildings: [], strips: [],
  };
  const targets = new Set(input.targets.map((b) => b.path));
  const scene = new Map([...input.neighbours, ...input.targets].map((b) => [b.path, b]));
  const geometry = input.geometry ?? prepareAbstandGeometry(options, []);
  const manual = new Map<string, string>();
  const footprints: { building: Building; ring: P2[] }[] = [];
  const stripsByPath = new Map<string, Strip[]>();
  for (const b of scene.values()) {
    const { ring, manual: skipped, strips } = geometry.get(b);
    if (ring) footprints.push({ building: b, ring });
    if (skipped) manual.set(b.path, skipped);
    if (strips.length) stripsByPath.set(b.path, strips);
  }
  if (!targets.size && !reason) report.skipped.push("Abstandsflächen · Keine Gebäude für die Prüfung gefunden.");
  if (reason) report.skipped.push(`Abstandsflächen · ${citation} · Manuell prüfen (needs manual check): ${reason}.`);
  if (!reason && !site) {
    report.skipped.push("Abstandsflächen · Grundstücksgrenze fehlt (Grenzprüfung offen).");
    for (const path of targets) if (!manual.has(path)) manual.set(path, "die Grundstücksgrenze fehlt");
  }
  const incomplete = !reason && (!site || manual.size > 0);
  if (incomplete) {
    result.incomplete = true;
    for (const [path, why] of manual) if (!targets.has(path))
      report.skipped.push(`Abstandsflächen · Nachbar ${nameOf(scene.get(path)!)} [${path}] · Unvollständig: ${why}.`);
  }

  const angleException = law.overlap_allowed.note.includes(">75°");
  const changed = bayern ? undefined : input.changedPath;
  const changedFootprint = changed ? footprints.find(({ building }) => building.path === changed) : undefined;
  const reverseFootprints = changedFootprint ? [changedFootprint] : [];
  type Boundary = Pick<Extract<Violation, { rule: "abstand" }>, "boundary_source" | "road_contributed" | "road_allowance_m">;
  const conflicts = (s: Strip, others: Strip[], emit?: (why: string, available: number, overlap: number, other?: string, boundary?: Boundary, otherFacade?: number) => void) => {
    let available = s.depth;
    const record = (why: string, depth: number, overlap: number, other?: string, boundary?: Boundary, otherFacade?: number) => {
      if (s.depth - depth <= EPS) return;
      available = Math.min(available, depth);
      emit?.(why, depth, overlap, other, boundary, otherFacade);
    };
    if (site && (!changed || s.path === changed)) {
      const { available: depth, allowance } = plotStripBoundary(s, site, roads);
      if (depth < s.depth - EPS) {
        const road = allowance > EPS;
        record(road ? `Straßenmitte (+${rounded(allowance)} m ab Grundstücksgrenze)` : "Grundstücksgrenze", depth, s.depth - depth, undefined,
          { boundary_source: road ? "road_centreline" : "plot_boundary", road_contributed: road, road_allowance_m: road ? rounded(allowance) : 0 });
      }
    }
    const reverse = changed && s.path !== changed;
    for (const { building, ring } of reverse ? reverseFootprints : footprints) {
      if (building.path === s.path || !geometry.overlaps(s.ring, ring)) continue;
      const hit = stripOverlap(s, ring);
      record(`Gebäude ${nameOf(building)}`, hit.available, hit.overlap, building.path);
    }
    if (!law.overlap_allowed.allowed) for (const other of reverse ? stripsByPath.get(changed) ?? [] : others) {
      if (s.path === other.path || !geometry.overlaps(s.ring, other.ring) || (angleException && facadeAngle(s, other) > 75 + EPS)) continue;
      const hit = stripOverlap(s, other.ring);
      record(`Abstandsfläche von ${labelStrip(other)}`, hit.available, hit.overlap, other.path, undefined, other.facade);
    }
    return available;
  };

  let allStrips = [...stripsByPath.values()].flat();
  if (bayern && site) {
    // Apply the reduced depth only if two other façades already meet the full depth.
    // Use full-depth neighbouring strips for this eligibility check.
    for (const [path, strips] of stripsByPath) {
      const fullDepths = strips.map((s) => conflicts(s, allStrips));
      if (fullDepths.filter((d, i) => strips[i].depth - d <= EPS).length < 2) continue;
      const candidates = strips.filter((s, i) => s.width <= 16 + EPS && s.depth - fullDepths[i] > EPS)
        .sort((a, b) => (b.depth - fullDepths[b.facade - 1]) - (a.depth - fullDepths[a.facade - 1])).slice(0, 2);
      stripsByPath.set(path, strips.map((s) => candidates.includes(s)
        ? { ...s, ...setbackStrip(s, Math.max(law.min_m, s.depth / 2)), factor: 0.5 } : s));
    }
    allStrips = [...stripsByPath.values()].flat();
  }
  if (input.stripsOnly) {
    result.strips = allStrips;
    return result;
  }
  for (const building of input.targets) {
    const { path } = building, name = nameOf(building);
    const strips = stripsByPath.get(path) ?? [];
    const shortfalls: number[] = [];
    for (const s of strips) {
      const depth = conflicts(s, allStrips, (why, available, overlap, other, boundary, otherFacade) => {
        const shortfall = rounded(s.depth - available);
        const violation: Violation = {
          rule: "abstand", path, name, other, actual: rounded(available), limit: rounded(s.depth),
          facade: s.direction, facade_index: s.facade, other_facade_index: otherFacade, severity: s.depth - available, shortfall_m: shortfall, overlap_m: rounded(overlap),
          citation, source_url: law.url, ...boundary,
          text: `${labelStrip(s)} · ${why}. Erforderlich ${rounded(s.depth)} m, verfügbar ${rounded(available)} m, fehlen ${shortfall} m.${other ? ` Überdeckung ${rounded(overlap)} m.` : ""} ${citation}.`,
        };
        report.violations.push(violation);
      });
      const bad = s.depth - depth > EPS;
      if (bad) shortfalls.push(s.depth - depth);
      // Incomplete façades must never be shown green.
      if (bad || (!manual.has(path) && !incomplete)) result.strips.push(bad ? { ...s, bad } : s);
    }
    const why = manual.get(path);
    if (why && !reason && site) report.skipped.push(`Abstandsflächen · ${name} · Manuell prüfen: ${why}. ${citation}.`);
    result.buildings.push(shortfalls.length
      ? { path, name, status: "shortfall", minShortfall_m: rounded(Math.min(...shortfalls)), maxShortfall_m: rounded(Math.max(...shortfalls)) }
      : why || incomplete ? { path, name, status: "manual", reason: why ?? "Überdeckungsprüfung offen" }
      : { path, name, status: "ok", minShortfall_m: 0, maxShortfall_m: 0 });
  }
  if ([...targets].some((p) => (stripsByPath.get(p)?.length ?? 0) > 0)) report.checked.push("abstand");
  const factors = [...new Set(allStrips.filter((s) => targets.has(s.path)).map((s) => s.factor))].sort((a, b) => b - a);
  if (factors.length) result.factor = factors.length === 1 ? factors[0] : factors.join(" / ");
  if (report.violations.some((v) => v.rule === "abstand")) result.fix = "Vergrößern Sie die Abstände an den genannten Fassaden oder reduzieren Sie dort die Gebäudehöhe. Prüfen Sie danach erneut.";
  else if (!targets.size && !reason && site && !incomplete) result.fix = "Wählen Sie ein Gebäude im Grundstück aus und prüfen Sie erneut.";
  else if (reason || incomplete || !site) result.fix = reason ? "Klären Sie die anzuwendende Regel anhand der angegebenen Vorschrift." : "Ergänzen Sie die fehlende Grenze oder Gebäudegeometrie in Forma und prüfen Sie erneut.";
  return result;
}
