import { checkAbstand, resolveAbstand, statutoryDepth, type AbstandRoads } from "./abstand.js";
import { area, bufferedObstacle, buildableEnvelope, edgeBuffers, r2, roadAllowance, type P2 } from "./geom.js";
import { FormaError } from "./protocol.js";
import { grz2LimitFor, type BuildingZone, type ExcludedPlotBuilding, type PlotBuilding, type RuleBuilding, type RuleReport, type Rules } from "./rules.js";

type CapacityConstraint = "GRZ" | "GRZ II" | "GFZ" | "Abstandsflächen" | "Grenzabstand" | "height" | "zone" | "Vollgeschosse" | "Bestand" | "Grundstück";
export type CapacityRow = {
  storeys: number;
  height_m: number;
  depth_m: number;
  buildable_m2: number;
  maxFootprint_m2: number;
  maxGfa_m2: number;
  constraints: CapacityConstraint[];
};
type CapacityInput = {
  plot: P2[];
  zones: BuildingZone[];
  rules: Rules;
  floorHeight: number;
  existing: RuleBuilding[];
  inventory: PlotBuilding[];
  ancillary?: number;
  roads?: AbstandRoads;
  neighbours?: RuleBuilding[];
  alignToEdges?: boolean;
  excludedContext?: ExcludedPlotBuilding[];
  inventoryNote?: string;
  refusal?: string;
  accepts?: (ring: P2[], row: CapacityRow) => boolean;
};
const EPS = 1e-7;
const SEARCH_BUDGET_MS = 8000;
const metric = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

export function capacityStoreyLimit(rules: Rules, floorHeight: number) {
  if (!Number.isFinite(floorHeight) || floorHeight <= 0 || floorHeight >= 50)
    throw new FormaError("Die Geschosshöhe muss größer als 0 und kleiner als 50 m sein.", "Geben Sie z. B. floorHeight: 3 an.");
  const heightLimit = rules.maxHeight === undefined ? Infinity : Math.floor(rules.maxHeight / floorHeight + 1e-9);
  const floorLimit = Math.min(rules.maxFullStoreys ?? Infinity, rules.maxFloors ?? Infinity);
  const defaulted = heightLimit === Infinity && floorLimit === Infinity;
  const limit = Math.min(heightLimit, floorLimit);
  if (!defaulted && (!Number.isFinite(limit) || limit > 250 || limit < 0))
    throw new FormaError("Die Berechnung braucht eine Obergrenze zwischen 0 und 250 Vollgeschossen.", "Geben Sie maxFullStoreys oder eine passende maxHeight an.");
  return { limit, heightLimit, floorLimit, defaulted };
}

function insetBoundaries(plot: P2[], zones: BuildingZone[], fixed: number, depth: number, street: AbstandRoads["surfaces"]) {
  const buffers = (ring: P2[]) => edgeBuffers(ring,
    (facade) => Math.max(fixed, depth - roadAllowance(facade, plot, street, depth)), true, depth > fixed ? street : []);
  return { plotBuffers: buffers(plot), zoneBuffers: zones.map(({ ring }) => ({ ring, exclusions: buffers(ring) })) };
}

export function capacitySearchLimit(plot: P2[], zones: BuildingZone[], rules: Rules, floorHeight: number, roads?: AbstandRoads) {
  const { limit, defaulted } = capacityStoreyLimit(rules, floorHeight);
  if (!defaulted) return limit;
  const statute = rules.abstand && resolveAbstand(rules.abstand);
  const factor = statute && statute.factor;
  // With no height-dependent geometry there is no finite geometric height bound.
  if (!statute || typeof factor !== "number" || factor <= 0) return 250;
  const street = rules.abstand?.allowRoadHalf === false ? [] : roads?.surfaces ?? [];
  const fits = (storeys: number) => {
    const depth = statutoryDepth(statute.state, storeys * floorHeight, factor, statute.reduced?.min_m ?? statute.law.min_m);
    const { plotBuffers, zoneBuffers } = insetBoundaries(plot, zones, Math.max(0, rules.minSetback ?? 0), depth, street);
    return buildableEnvelope(plot, zoneBuffers, plotBuffers).area > EPS;
  };
  let low = 0, high = 1;
  while (Number.isSafeInteger(high) && fits(high)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

export function calculateCapacity({ plot, zones, rules, floorHeight, existing, inventory, ancillary, roads, neighbours = [], alignToEdges, excludedContext = [], inventoryNote, refusal, accepts }: CapacityInput, searchLimit?: number) {
  const { heightLimit, floorLimit, defaulted } = capacityStoreyLimit(rules, floorHeight);
  const plotArea_m2 = area(plot);
  const footprint_m2 = inventory.reduce((sum, building) => sum + building.footprint_m2, 0);
  const estimatedBuildings = inventory.filter((b) => b.fullFloorArea?.source === "estimated" || b.totalFloorArea?.source === "estimated")
    .map((b) => ({ path: b.path, name: b.name, floors: b.floors, gfa_m2: b.fullFloorArea?.m2, total_gfa_m2: b.totalFloorArea?.m2, source: "estimated" }));
  const floorArea_m2 = inventory.every((b) => b.fullFloorArea !== undefined)
    ? inventory.reduce((sum, b) => sum + (b.fullFloorArea?.m2 ?? 0), 0) : undefined;
  const grz2 = grz2LimitFor(rules);
  const ratioLimit = (ratio: number | undefined, used: number | undefined) =>
    ratio === undefined || used === undefined ? Infinity : Math.max(0, ratio * plotArea_m2 - used);
  const grzFoot = ratioLimit(rules.maxGrz, footprint_m2);
  const grz2Foot = ratioLimit(grz2, ancillary === undefined ? undefined : footprint_m2 + ancillary);
  const gfzArea = ratioLimit(rules.maxGfz, floorArea_m2);
  const fixed = Math.max(0, rules.minSetback ?? 0);
  const assumptions = [
    `Flachdach, ${metric.format(floorHeight)} m je Geschoss, alle neuen Geschosse sind Vollgeschosse.`,
    "Für einen einzelnen Baukörper wird ein Rechteck gesucht. Die Abstandsflächen desselben Baukörpers werden ohne gegenseitige Überdeckung angesetzt.",
    "Bei unregelmäßigen Grenzen und im Bestand werden Ecken und Abstandsflächen konservativ angesetzt.",
  ];
  if (defaulted) assumptions.push("No height or storey limit given: the search stops at a collapsed inset or after two storey counts without a GFA gain. Without height-dependent setbacks, the fallback search limit is 250 storeys.");
  const estimated = estimatedBuildings.length > 0;
  const estimateNote = estimated
    ? `Based on estimated floor area for: ${estimatedBuildings.map((b) => b.name ?? b.path).join(", ")}.` : undefined;
  const rows: CapacityRow[] = [];
  const result = {
    plotArea_m2, zone: zones.map(({ name }) => name).join(", ") || undefined, rows, assumptions, estimated, estimateNote,
    existing: { footprint_m2, floorArea_m2, ancillary_m2: ancillary, estimatedBuildings, inventory, excludedContext },
    inventoryNote,
  };
  if (refusal) return { ...result, best: undefined, block: undefined, searchNote: undefined, summary: [refusal, estimateNote].filter(Boolean).join(" ") };

  const limit = searchLimit ?? capacitySearchLimit(plot, zones, rules, floorHeight, roads);
  const started = performance.now();
  const expired = () => performance.now() - started >= SEARCH_BUDGET_MS;
  const rowsExpired = () => performance.now() - started >= SEARCH_BUDGET_MS / 2;
  let stoppedEarly = false;
  const statute = rules.abstand && resolveAbstand(rules.abstand);
  const street = rules.abstand?.allowRoadHalf === false ? [] : roads?.surfaces ?? [];
  const obstacles = new Map([...existing, ...neighbours].map((building) => [building.path, building]));
  let reserved: P2[][] = [...obstacles.values()].map((building) => building.ring);
  if (statute && rules.abstand) {
    if (statute.reason || typeof statute.factor !== "number")
      throw new FormaError(`Abstandsflächen manuell prüfen (${statute.law.section} ${statute.law.statute}).`, `Klären Sie den anzuwendenden Faktor. ${statute.law.url}`);
    const report: RuleReport = { ok: true, checked: [], skipped: [], violations: [], summary: {} };
    const checked = checkAbstand(rules.abstand, { site: plot, targets: [...obstacles.values()], neighbours: [], roads, stripsOnly: true }, report);
    reserved = [...reserved, ...checked.strips.map((strip) => strip.ring)];
    assumptions.push(...checked.assumptions.slice(1), `${checked.citation} · ${checked.url}`);
    if (statute.bayern || statute.state === "BW")
      assumptions.push("Die Rechteckberechnung setzt für neue Fassaden die volle Abstandstiefe ohne Schmalseiten-Ermäßigung an.");
  } else {
    assumptions.push("Abstandsflächen nach Landesrecht wurden ohne abstand-Eingabe nicht angesetzt.");
  }

  const zoneArea = zones.length ? buildableEnvelope(plot, zones, []).area : plotArea_m2;
  const insets = new Map<number, ReturnType<typeof buildInset>>();
  function buildInset(depth: number) {
    const { plotBuffers, zoneBuffers } = insetBoundaries(plot, zones, fixed, depth, street);
    const all = reserved.flatMap((ring, i) => {
      // Keep the new façade strips clear of existing outlines and, where required, existing strips.
      const spacing = i < obstacles.size ? Math.max(0, rules.minSpacing ?? 0) : 0;
      const gap = i < obstacles.size || !statute?.law.overlap_allowed.allowed ? depth : 0;
      return bufferedObstacle(ring, Math.max(gap, spacing));
    });
    return { plotBuffers, zoneBuffers, all };
  }
  const inset = (depth: number) => {
    const cached = insets.get(depth);
    if (cached) return cached;
    const geometry = buildInset(depth);
    if (insets.size < 8) insets.set(depth, geometry);
    return geometry;
  };

  let best: CapacityRow | undefined;
  let withoutGain = 0;
  const unrotatedEnvelopes = new Map<number, ReturnType<typeof buildableEnvelope>>();
  let cached: { depth: number; buildable: number; beforeExisting: number } | undefined;
  for (let storeys = 1; storeys <= limit; storeys++) {
    if (rowsExpired()) { stoppedEarly = true; break; }
    const height_m = storeys * floorHeight;
    const depth_m = statute && typeof statute.factor === "number"
      ? statutoryDepth(statute.state, height_m, statute.factor, statute.reduced?.min_m ?? statute.law.min_m) : 0;
    if (!cached || cached.depth !== depth_m) {
      const { plotBuffers, zoneBuffers, all } = inset(depth_m);
      const before = buildableEnvelope(plot, zoneBuffers, plotBuffers, rowsExpired);
      const envelope = all.length && before.area > EPS
        ? buildableEnvelope(plot, zoneBuffers, [...plotBuffers, ...all], rowsExpired) : before;
      if (zoneBuffers.length <= 1 && unrotatedEnvelopes.size < 8) unrotatedEnvelopes.set(depth_m, envelope);
      cached = { depth: depth_m, beforeExisting: before.area, buildable: envelope.area };
      if (rowsExpired()) { stoppedEarly = true; break; }
    }
    const { buildable: buildable_m2, beforeExisting } = cached;
    const maxFootprint_m2 = Math.min(buildable_m2, grzFoot, grz2Foot, gfzArea / storeys);
    const constraints: CapacityConstraint[] = [];
    if (gfzArea / storeys <= maxFootprint_m2 + EPS) constraints.push("GFZ");
    if (grzFoot <= maxFootprint_m2 + EPS) constraints.push("GRZ");
    if (grz2Foot <= maxFootprint_m2 + EPS) constraints.push("GRZ II");
    if (buildable_m2 <= maxFootprint_m2 + EPS) {
      if (buildable_m2 < beforeExisting - EPS) constraints.push("Bestand");
      if (beforeExisting < zoneArea - EPS) constraints.push(depth_m > fixed ? "Abstandsflächen" : "Grenzabstand");
      if (zones.length) constraints.push("zone");
    }
    if (storeys === heightLimit) constraints.push("height");
    if (storeys === floorLimit) constraints.push("Vollgeschosse");
    if (!constraints.length) constraints.push("Grundstück");
    const row = { storeys, height_m, depth_m, buildable_m2, maxFootprint_m2, maxGfa_m2: maxFootprint_m2 * storeys, constraints };
    rows.push(row);
    if (row.maxGfa_m2 > (best?.maxGfa_m2 ?? 0) + EPS) {
      best = row;
      withoutGain = 0;
    } else withoutGain++;
    if (defaulted && (buildable_m2 <= EPS || withoutGain >= 2)) break;
  }

  let block: { ring: P2[]; footprint_m2: number; gfa_m2: number; storeys: number; height_m: number } | undefined;
  if (best) {
    const candidates = alignToEdges || accepts
      ? [...rows].sort((a, b) => b.maxGfa_m2 - a.maxGfa_m2 || a.storeys - b.storeys) : [best];
    search: for (const row of candidates) {
      if (row.maxGfa_m2 <= (block?.gfa_m2 ?? 0) + EPS) break;
      const { plotBuffers, zoneBuffers, all } = inset(row.depth_m);
      // A single block must fit inside one zone even if the capacity figure covers several zones.
      for (const active of zoneBuffers.length ? zoneBuffers.map((zone) => [zone]) : [[]]) {
        const boundary = active[0]?.ring ?? plot;
        const turns = [0];
        if (alignToEdges) {
          const edges = boundary.map(([x, y], i) => {
            const [nx, ny] = boundary[(i + 1) % boundary.length];
            return { angle: Math.atan2(ny - y, nx - x), length: Math.hypot(nx - x, ny - y) };
          }).sort((a, b) => b.length - a.length);
          const quarter = Math.PI / 2;
          for (const { angle } of edges) {
            const turn = ((angle % quarter) + quarter) % quarter;
            if (!turns.some((other) => Math.min(Math.abs(turn - other), quarter - Math.abs(turn - other)) < EPS)) turns.push(turn);
            if (turns.length === 7) break;
          }
        }
        for (const turn of turns) {
          if (expired()) break search;
          const cos = Math.cos(turn), sin = Math.sin(turn);
          const local = (ring: P2[]) => turn ? ring.map(([x, y]): P2 => [cos * x + sin * y, cos * y - sin * x]) : ring;
          const world = (ring: P2[]) => turn ? ring.map(([x, y]): P2 => [cos * x - sin * y, cos * y + sin * x]) : ring;
          const envelope = (!turn ? unrotatedEnvelopes.get(row.depth_m) : undefined)
            ?? buildableEnvelope(local(plot), active.map(({ ring, exclusions }) =>
              ({ ring: local(ring), exclusions: exclusions?.map(local) })), [...plotBuffers, ...all].map(local), expired);
          if (expired()) break search;
          const minArea = (block?.gfa_m2 ?? 0) / row.storeys;
          const fits = accepts ? (ring: P2[]) => accepts(world(ring), row) : undefined;
          const ring = envelope.rectangle(row.maxFootprint_m2, fits, minArea, expired);
          if (!ring) continue;
          const footprint_m2 = area(ring), gfa_m2 = footprint_m2 * row.storeys;
          if (gfa_m2 > (block?.gfa_m2 ?? 0) + EPS)
            block = { ring: world(ring), footprint_m2, gfa_m2, storeys: row.storeys, height_m: row.height_m };
          if (gfa_m2 >= row.maxGfa_m2 - EPS) break;
        }
      }
    }
  }
  const labels = (constraint: CapacityConstraint) => {
    switch (constraint) {
      case "GRZ": return `GRZ ${metric.format(rules.maxGrz ?? 0)}`;
      case "GRZ II": return `GRZ II ${metric.format(grz2 ?? 0)}`;
      case "GFZ": return `GFZ ${metric.format(rules.maxGfz ?? 0)}`;
      case "height": return `Höhenlimit ${metric.format(rules.maxHeight ?? 0)} m`;
      case "zone": return "Baufenster";
      default: return constraint;
    }
  };
  stoppedEarly ||= expired();
  const summary = best
    ? `Geometrische Obergrenze${defaulted || stoppedEarly ? " (untersuchte Geschosse)" : ""}: etwa ${metric.format(best.maxGfa_m2)} m² Bruttogrundfläche bei ${best.storeys} Vollgeschoss${best.storeys === 1 ? "" : "en"} (${metric.format(best.height_m)} m). Maßgebend: ${best.constraints.map(labels).join(", ")}. Bis zu ${metric.format(best.maxFootprint_m2)} m² Gebäudegrundfläche bei ${metric.format(best.buildable_m2)} m² verfügbarer Fläche${best.depth_m ? ` nach Abstandsflächen von ${metric.format(best.depth_m)} m` : ""}.`
    : "Unter den angegebenen Grenzen ergibt sich keine zusätzliche Geschossfläche.";
  return {
    ...result, best, block: block && { ...block, footprintXY_m: block.ring.map(([x, y]): P2 => [r2(x), r2(y)]) },
    summary: [summary, estimateNote].filter(Boolean).join(" "),
    searchNote: stoppedEarly ? "The capacity search reached its time budget. The single-block result is the best candidate found so far." : undefined,
  };
}
