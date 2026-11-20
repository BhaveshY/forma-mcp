// Small, dependency-free geometry helpers. Units: metres, local project coords.
export type P2 = [number, number];
export type M4 = number[]; // 4x4 column-major, length 16

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export const area = (poly: P2[]) => Math.abs(signedArea(poly));

/** Drop closing duplicate and repeated points, force counter-clockwise. */
export function cleanRing(poly: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push([+p[0], +p[1]]);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  }
  if (out.length < 3) throw new Error("polygon needs at least 3 distinct points");
  return signedArea(out) < 0 ? out.reverse() : out;
}

const polygonEdges = (ring: P2[]) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as const);
const cross = (x: number, y: number, u: number, v: number) => x * v - y * u;
const EDGE_EPS = 1e-8;

function onEdge([x, y]: P2, [ax, ay]: P2, [bx, by]: P2): boolean {
  const dx = bx - ax, dy = by - ay;
  return Math.abs(cross(dx, dy, x - ax, y - ay)) <= EDGE_EPS * Math.hypot(dx, dy)
    && x >= Math.min(ax, bx) - EDGE_EPS && x <= Math.max(ax, bx) + EDGE_EPS
    && y >= Math.min(ay, by) - EDGE_EPS && y <= Math.max(ay, by) + EDGE_EPS;
}

/** Position along a–b where it intersects c–d. Parallel edges are handled separately. */
function intersection(a: P2, b: P2, c: P2, d: P2): number | undefined {
  const dx = b[0] - a[0], dy = b[1] - a[1], ex = d[0] - c[0], ey = d[1] - c[1];
  const den = cross(dx, dy, ex, ey);
  if (Math.abs(den) <= EDGE_EPS) return undefined;
  const x = c[0] - a[0], y = c[1] - a[1];
  const t = cross(x, y, ex, ey) / den, u = cross(x, y, dx, dy) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : undefined;
}

export function selfIntersects(ring: P2[]): boolean {
  const edges = polygonEdges(ring);
  return edges.some(([a, b], i) => edges.some(([c, d], j) =>
    j > i + 1 && !(i === 0 && j === edges.length - 1)
    && (intersection(a, b, c, d) !== undefined
      || onEdge(a, c, d) || onEdge(b, c, d) || onEdge(c, a, b) || onEdge(d, a, b))));
}

/** Locate the boundary of one polygon relative to another, treating shared edges as neutral. */
export function ringLocation(ring: P2[], other: P2[]): { inside: boolean; outside: boolean } {
  const edges = polygonEdges(other);
  let inside = false, outside = false;
  for (const [a, b] of polygonEdges(ring)) {
    const cuts = [0, 1];
    for (const [c, d] of edges) {
      const t = intersection(a, b, c, d);
      if (t !== undefined && t > 0 && t < 1) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 1; i < cuts.length; i++) {
      const mid = (cuts[i - 1] + cuts[i]) / 2;
      const point: P2 = [a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1])];
      if (edges.some(([c, d]) => onEdge(point, c, d))) continue;
      if (pointInPoly(point, other)) inside = true;
      else outside = true;
      if (inside && outside) return { inside, outside };
    }
  }
  return { inside, outside };
}

export function ringsOverlap(a: P2[], b: P2[]): boolean {
  const ab = ringLocation(a, b);
  if (ab.inside || !ab.outside) return true;
  const ba = ringLocation(b, a);
  return ba.inside || !ba.outside;
}

export function centroid(poly: P2[]): P2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Axis-aligned rectangle helper: origin corner, width (x), depth (y), rotation deg about origin. */
export function rect(x: number, y: number, w: number, d: number, rotDeg = 0): P2[] {
  const r = (rotDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return ([[0, 0], [w, 0], [w, d], [0, d]] as P2[]).map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

/** Inward (negative = outward) polygon offset for convex-ish rings (miter join). */
export function offset(poly: P2[], dist: number): P2[] {
  const ring = cleanRing(poly);
  const n = ring.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i - 1 + n) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    const n1 = inwardNormal(p0, p1), n2 = inwardNormal(p1, p2);
    const bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by) || 1;
    const cos = (n1[0] * bx + n1[1] * by) / bl;
    const k = dist / Math.max(cos, 0.2);
    out.push([p1[0] + (bx / bl) * k, p1[1] + (by / bl) * k]);
  }
  return out;
}

function inwardNormal(a: P2, b: P2): P2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l]; // left normal = inward for CCW
}

export function pointInPoly([x, y]: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

export const translation = (dx: number, dy: number, dz: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, dy, dz, 1];

export function rotationZ(deg: number, cx = 0, cy = 0): M4 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const rot: M4 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return mul(translation(cx, cy, 0), mul(rot, translation(-cx, -cy, 0)));
}

export type Box = { min: [number, number, number]; max: [number, number, number] };

export function bboxOfTriangles(t: ArrayLike<number>): Box | undefined {
  if (!t || t.length < 3) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = t[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function mergeBoxes(boxes: (Box | undefined)[]): Box | undefined {
  const bs = boxes.filter(Boolean) as Box[];
  if (!bs.length) return undefined;
  return {
    min: [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.min[k]))) as Box["min"],
    max: [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.max[k]))) as Box["max"],
  };
}

/** Closed prism mesh (verts/faces) from a CCW ring, base z0, height h. */
export function extrude(ring: P2[], z0: number, h: number): { verts: number[]; faces: number[] } {
  const r = cleanRing(ring);
  const n = r.length;
  const verts: number[] = [];
  for (const [x, y] of r) verts.push(x, y, z0);
  for (const [x, y] of r) verts.push(x, y, z0 + h);
  const faces: number[] = [];
  const tris = earcut(r);
  for (const [a, b, c] of tris) {
    faces.push(a, c, b); // bottom faces down
    faces.push(a + n, b + n, c + n); // top faces up
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(i, j, j + n, i, j + n, i + n);
  }
  return { verts, faces };
}

/** Ear-clipping triangulation of a simple CCW ring (no holes). */
export function earcut(ring: P2[]): [number, number, number][] {
  const idx = ring.map((_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const [pa, pb, pc] = [ring[a], ring[b], ring[c]];
      const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (cross <= 1e-12) continue;
      const tri: P2[] = [pa, pb, pc];
      if (idx.some((k) => k !== a && k !== b && k !== c && pointInPoly(ring[k], tri))) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate; fall through to fan
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  else for (let i = 1; i + 1 < idx.length; i++) out.push([idx[0], idx[i], idx[i + 1]]);
  return out;
}

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r1 = (v: number) => Math.round(v * 10) / 10;

/** Convex hull (Andrew's monotone chain), CCW, no repeated closing point. */
export function convexHull(points: P2[]): P2[] {
  const p = [...new Map(points.map((q) => [`${q[0].toFixed(3)},${q[1].toFixed(3)}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], up: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * Exact outline of a mesh's base: the boundary of all flat triangles at the lowest level.
 * Returns the largest closed ring (CCW), or undefined if the base is not a clean surface.
 */
export function baseOutline(t: ArrayLike<number>, tol = 0.05): P2[] | undefined {
  let zmin = Infinity;
  for (let i = 2; i < t.length; i += 3) if (t[i] < zmin) zmin = t[i];
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const pts = new Map<string, P2>();
  const edges = new Map<string, [string, string, number]>(); // undirected key -> [a, b, count]
  for (let i = 0; i + 8 < t.length; i += 9) {
    if (Math.abs(t[i + 2] - zmin) > tol || Math.abs(t[i + 5] - zmin) > tol || Math.abs(t[i + 8] - zmin) > tol) continue;
    const ks = [0, 3, 6].map((o) => { const k = key(t[i + o], t[i + o + 1]); pts.set(k, [t[i + o], t[i + o + 1]]); return k; });
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (const [a, b] of [[ks[0], ks[1]], [ks[1], ks[2]], [ks[2], ks[0]]]) {
      const u = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(u);
      if (e) e[2]++; else edges.set(u, [a, b, 1]);
    }
  }
  const next = new Map<string, string[]>();
  for (const [a, b, n] of edges.values()) {
    if (n !== 1) continue; // interior edge (shared by two base triangles)
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  const used = new Set<string>();
  let best: P2[] | undefined;
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const ring: string[] = [start];
    used.add(start);
    let prev = "", cur = start;
    for (let guard = 0; guard < 100000; guard++) {
      const nb = (next.get(cur) ?? []).find((k) => k !== prev && (!used.has(k) || (k === start && ring.length > 2)));
      if (!nb || nb === start) break;
      ring.push(nb); used.add(nb); prev = cur; cur = nb;
    }
    if (ring.length < 3) continue;
    const poly = ring.map((k) => pts.get(k)!);
    if (!best || area(poly) > area(best)) best = poly;
  }
  if (!best) return undefined;
  // drop collinear points
  const out = best.filter((p, i) => {
    const a = best![(i - 1 + best!.length) % best!.length], b = best![(i + 1) % best!.length];
    return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-3;
  });
  return out.length >= 3 ? cleanRing(out) : undefined;
}
