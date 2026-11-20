// Rebuild a Forma building with a different number of floors.
// Native "basic buildings" (Site Design) keep their real definition in an internal record:
//   floors[]: { id, height, graph: { vertices: {id:{id,x,y}} }, spaces: {id:{polygon:[vid], holes:[[vid]]}} }
//   units[]:  { functionId, spaces: [{ floorId, spaceId }] }
// Removing their "floor" child elements changes nothing (verified live), so we re-create the building
// through the floor-stack API with the same outlines, heights and uses.

type V = { id: string; x: number; y: number };
export type PlanOut = { id: string; vertices: V[]; units: { polygon: string[]; holes: string[][]; functionId?: string }[] };
export type StackOut = { floors: { planId: string; height: number }[]; plans: PlanOut[] };

const ringArea = (ids: string[], at: Map<string, V>) => {
  let a = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = at.get(ids[i])!, q = at.get(ids[(i + 1) % ids.length])!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};
const ccw = (ids: string[], at: Map<string, V>) => {
  const open = ids.length > 1 && ids[0] === ids[ids.length - 1] ? ids.slice(0, -1) : ids;
  return ringArea(open, at) < 0 ? [...open].reverse() : open;
};

/** Floors of a basic building as floor-stack input, resized to `target` floors (top floors dropped or the top floor repeated). */
export function stackFromInternal(data: any, target: number): StackOut {
  const src: any[] = data?.floors ?? [];
  if (!src.length) throw new Error("no floors in the building record");
  if (!Number.isInteger(target) || target < 1 || target > 200) throw new Error("floor count must be a whole number from 1 to 200");
  const funcOf = new Map<string, string>(); // `${floorId}/${spaceId}` -> functionId
  for (const u of data?.units ?? []) for (const s of u.spaces ?? []) if (u.functionId) funcOf.set(`${s.floorId}/${s.spaceId}`, u.functionId);
  const plans: PlanOut[] = src.map((f, pi) => {
    // Forma requires vertex ids unique across ALL plans and matching [a-zA-Z0-9-]{2,20} (both verified live).
    const ids = new Map<string, string>();
    const vid = (id: string) => ids.get(id) ?? (ids.set(id, `p${pi}-v${ids.size}`), ids.get(id)!);
    const at = new Map<string, V>();
    for (const v of Object.values<any>(f.graph?.vertices ?? {})) at.set(vid(v.id), { id: vid(v.id), x: +v.x, y: +v.y });
    const units = Object.entries<any>(f.spaces ?? {}).map(([sid, s]) => ({
      polygon: ccw(s.polygon.map(vid), at),
      holes: (s.holes ?? []).map((h: string[]) => ccw(h.map(vid), at)),
      ...(funcOf.get(`${f.id}/${sid}`) ? { functionId: funcOf.get(`${f.id}/${sid}`) } : {}),
    })).filter((u) => u.polygon.length >= 3);
    const used = new Set(units.flatMap((u) => [...u.polygon, ...u.holes.flat()]));
    return { id: String(f.id), vertices: [...at.values()].filter((v) => used.has(v.id)), units };
  });
  const floors = Array.from({ length: target }, (_, i) => {
    const f = src[Math.min(i, src.length - 1)];
    return { planId: String(f.id), height: +f.height };
  });
  const need = new Set(floors.map((f) => f.planId));
  return { floors, plans: plans.filter((p) => need.has(p.id) && p.units.length) };
}
