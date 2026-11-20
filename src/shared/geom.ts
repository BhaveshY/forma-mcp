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

/** Expand the outward triangles so each face has its own normals for the render SDK. */
export function prismTriangles(ring: P2[], z: number, height: number) {
  const { verts, faces } = extrude(ring, z, height);
  const position = new Float32Array(faces.length * 3);
  const normal = new Float32Array(position.length);
  faces.forEach((vertex, i) => position.set(verts.slice(vertex * 3, vertex * 3 + 3), i * 3));
  for (let i = 0; i < position.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = position.subarray(i, i + 9);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    const direction = [nx / length, ny / length, nz / length];
    for (let vertex = 0; vertex < 3; vertex++) normal.set(direction, i + vertex * 3);
  }
  return { position, normal };
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

export type Facade = { from: P2; to: P2; width: number; outward: P2; direction: string };
export type SetbackStrip = Facade & { depth: number; ring: [P2, P2, P2, P2] };

export function facadeEdges(footprint: P2[]): Facade[] {
  const outline = cleanRing(footprint);
  // Intermediate points on a straight wall do not create new, narrower façades.
  const ring = outline.filter(([x, y], i) => {
    const before = outline[(i + outline.length - 1) % outline.length], after = outline[(i + 1) % outline.length];
    return !onEdge([x, y], before, after);
  });
  const compass = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"];
  return polygonEdges(ring).map(([from, to]) => {
    const [x, y] = inwardNormal(from, to);
    const outward: P2 = [-x, -y];
    const octant = (Math.round(Math.atan2(-y, -x) * 4 / Math.PI) + 8) % 8;
    return { from, to, outward, direction: compass[octant], width: Math.hypot(to[0] - from[0], to[1] - from[1]) };
  });
}

export function setbackStrip(facade: Facade, depth: number): SetbackStrip {
  const { from, to, outward: [x, y] } = facade;
  const extend = ([u, v]: P2): P2 => [u + x * depth, v + y * depth];
  return { ...facade, depth, ring: [to, from, extend(from), extend(to)] };
}

/** The smaller angle between the undirected wall lines. */
export function facadeAngle(a: Facade, b: Facade): number {
  const dot = Math.abs(a.outward[0] * b.outward[0] + a.outward[1] * b.outward[1]);
  return Math.acos(Math.min(1, dot)) * 180 / Math.PI;
}

export type RoadSurface = { ring: P2[]; halves?: [P2[], P2[]] };

export function roadSurfaces(line: P2[], width: number): RoadSurface[] {
  return line.slice(1).flatMap((to, i) => {
    const from = line[i];
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) <= EDGE_EPS) return [];
    const [x, y] = inwardNormal(from, to);
    const shift = ([u, v]: P2, side: number): P2 => [u + x * side * width / 2, v + y * side * width / 2];
    const a = shift(from, -1), b = shift(to, -1), c = shift(to, 1), d = shift(from, 1);
    return [{ ring: [a, b, c, d], halves: [[a, b, to, from], [from, to, c, d]] }];
  });
}

type DepthInterval = [near: number, far: number];
type SliceEdge = { left: number; right: number; y: number; slope: number };
const edgeDepth = (edge: SliceEdge, x: number) => edge.y + (x - edge.left) * edge.slope;

/** Visit the limits of every positive-width interval across the façade.
 * In this coordinate system depth is Y. Between edge events the cross-sections vary linearly.
 */
function sweepStrip(strip: SetbackStrip, polygons: P2[][], visit: (sections: SampledInterval[][], x: number, activeIndices: number[]) => void, roadMidpoints: number[] = [], expired?: () => boolean) {
  const [nx, ny] = strip.outward;
  const local = ([x, y]: P2): P2 => {
    const dx = x - strip.from[0], dy = y - strip.from[1];
    return [-ny * dx + nx * dy, nx * dx + ny * dy];
  };
  const cuts = new Set([0, strip.width]);
  const slices = polygons.map((ring) => polygonEdges(ring.map(local)).flatMap(([a, b]) => {
    const [[left, y], [right, end]] = a[0] <= b[0] ? [a, b] : [b, a];
    if (right <= 0 || left >= strip.width) return [];
    if (left > 0) cuts.add(left);
    if (right < strip.width) cuts.add(right);
    if (right - left <= EDGE_EPS) return [];
    return [{ left, right, y, slope: (end - y) / (right - left) }];
  }));
  const edges = slices.flat();
  edges.push({ left: 0, right: strip.width, y: 0, slope: 0 },
    { left: 0, right: strip.width, y: strip.depth, slope: 0 });
  edges.sort((a, b) => a.left - b.left);
  for (let i = 0; i < edges.length; i++) {
    if (expired?.()) return;
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (b.left >= a.right) break;
      const lo = Math.max(0, a.left, b.left), hi = Math.min(strip.width, a.right, b.right);
      if (hi <= lo || a.slope === b.slope) continue;
      const x = lo + (edgeDepth(b, lo) - edgeDepth(a, lo)) / (a.slope - b.slope);
      if (x > lo && x < hi) cuts.add(x);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const starts = slices.flatMap((edges, index) => edges.map((edge) => ({ edge, index })))
    .sort((a, b) => a.edge.left - b.edge.left);
  const active = new Map<number, SliceEdge[]>();
  let nextEdge = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (expired?.()) return;
    const lo = sorted[i - 1], hi = sorted[i];
    if (hi - lo <= EDGE_EPS) continue;
    const mid = (lo + hi) / 2;
    while (nextEdge < starts.length && starts[nextEdge].edge.left < mid) {
      const { edge, index } = starts[nextEdge++];
      const ring = active.get(index);
      if (ring) ring.push(edge);
      else active.set(index, [edge]);
    }
    for (const [index, ring] of active) {
      let count = 0;
      for (const edge of ring) if (edge.right > mid) ring[count++] = edge;
      ring.length = count;
      if (count) ring.sort((a, b) => edgeDepth(a, mid) - edgeDepth(b, mid));
      else active.delete(index);
    }
    const activeIndices = [...active.keys()].sort((a, b) => a - b);
    // Carry an interior sample alongside each limit so zero-area touches don't count as overlaps.
    const sectionAt = (x: number) => {
      const sections: DepthInterval[][] = new Array(polygons.length);
      for (const [index, ring] of active) {
        const intervals: DepthInterval[] = [];
        for (let k = 1; k < ring.length; k += 2) intervals.push([edgeDepth(ring[k - 1], x), edgeDepth(ring[k], x)]);
        sections[index] = intervals;
      }
      return sections;
    };
    // Estimated centre lines are also linear here. Split at their crossings so
    // the worst road allowance includes the point where two limits trade places.
    const subCuts = [lo, hi];
    if (roadMidpoints.length) {
      const left = sectionAt(lo), right = sectionAt(hi);
      const centerLines: DepthInterval[] = roadMidpoints.flatMap((j) => (left[j] ?? []).map<DepthInterval>(([a, b], k) =>
        [(a + b) / 2, (right[j][k][0] + right[j][k][1]) / 2]));
      const plotEdges: DepthInterval[] = (left[0] ?? []).flatMap<DepthInterval>(([near, far], k) =>
        [[near, right[0][k][0]], [far, right[0][k][1]]]);
      for (const [i, [a, b]] of centerLines.entries()) {
        for (const [c, d] of [...plotEdges, ...centerLines.slice(i + 1)]) {
          const slope = (b - a) - (d - c);
          if (Math.abs(slope) <= EDGE_EPS) continue;
          const t = (c - a) / slope;
          if (t > 0 && t < 1) subCuts.push(lo + t * (hi - lo));
        }
      }
      subCuts.sort((a, b) => a - b);
    }
    for (let j = 1; j < subCuts.length; j++) {
      const a = subCuts[j - 1], b = subCuts[j];
      if (b - a <= EDGE_EPS) continue;
      const center = (a + b) / 2;
      const inner = sectionAt(center);
      for (const x of [a, b]) visit(sectionAt(x).map((intervals, n) =>
        intervals.map(([near, far], k) => [near, far, ...inner[n][k]] satisfies SampledInterval)), x, activeIndices);
    }
  }
}
type SampledInterval = [near: number, far: number, middleNear: number, middleFar: number];

/** Exclude strips on the inside of a boundary or buffers on the outside of an obstacle.
 * Extending strips at the ends covers corners conservatively, including concave turns.
 */
export function edgeBuffers(ring: P2[], depthFor: (facade: Facade) => number, inward: boolean, roads: RoadSurface[] = []): P2[][] {
  return facadeEdges(ring).flatMap((facade) => {
    if (!roads.length) return [facade];
    const [nx, ny] = facade.outward;
    const [fx, fy] = facade.from;
    const cuts = new Set([0, facade.width]);
    for (const { ring } of roads) {
      const projections = ring.map(([x, y]) => [-ny * (x - fx) + nx * (y - fy), nx * (x - fx) + ny * (y - fy)]);
      if (projections.every(([, across]) => across > EDGE_EPS) || projections.every(([, across]) => across < -EDGE_EPS)) continue;
      for (const [along] of projections) if (along > EDGE_EPS && along < facade.width - EDGE_EPS) cuts.add(along);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const at = (s: number): P2 => [fx - ny * s, fy + nx * s];
    return sorted.slice(1).flatMap((right, i) => {
      const left = sorted[i];
      return right - left > EDGE_EPS ? [{ ...facade, from: at(left), to: at(right), width: right - left }] : [];
    });
  }).flatMap((facade) => {
    const depth = depthFor(facade);
    if (depth <= EDGE_EPS) return [];
    const [nx, ny] = facade.outward, [tx, ty] = [-ny, nx];
    const { from, to } = facade;
    return [setbackStrip({ ...facade, width: facade.width + 2 * depth,
      from: [from[0] - tx * depth, from[1] - ty * depth],
      to: [to[0] + tx * depth, to[1] + ty * depth],
      outward: inward ? [-nx, -ny] : [nx, ny],
    }, depth).ring];
  });
}

/** The union of a rectangle and its uniform outward edge buffers is one rectangle. */
export function bufferedObstacle(ring: P2[], depth: number): P2[][] {
  if (depth <= EDGE_EPS) return [ring];
  const facades = facadeEdges(ring);
  if (facades.length === 4 && facades.every(({ outward: [x, y] }, i) => {
    const [nx, ny] = facades[(i + 1) % 4].outward;
    return Math.abs(x * nx + y * ny) <= Number.EPSILON * 16;
  })) {
    return [facades.map(({ from: [x, y], outward }, i): P2 => {
      const previous = facades[(i + 3) % 4].outward;
      return [x + depth * (outward[0] + previous[0]), y + depth * (outward[1] + previous[1])];
    })];
  }
  return [ring, ...edgeBuffers(ring, () => depth, false)];
}

type EnvelopeSlab = { left: number; right: number; intervals: [SampledInterval, SampledInterval][] };
type EnvelopeZone = { ring: P2[]; exclusions?: P2[][] };

/** Sweep (plot ∩ union of zones) minus excluded polygons. A sweep slab has linear sides. */
export function buildableEnvelope(plot: P2[], zones: EnvelopeZone[], exclusions: P2[][], expired?: () => boolean) {
  const xs = plot.map(([x]) => x);
  const origin = Math.min(...xs);
  const width = Math.max(...xs) - origin;
  const axis = setbackStrip({ from: [origin, 0], to: [origin + width, 0], width, outward: [0, -1], direction: "south" }, 0);
  const slabs: EnvelopeSlab[] = [];
  const polygons = [{ ring: plot, zone: -1, sign: 1 }, ...exclusions.filter((ring) => boundsOverlap(plot, ring)).map((ring) => ({ ring, zone: -1, sign: -1 }))];
  zones.forEach(({ ring, exclusions }, zone) => {
    polygons.push({ ring, zone, sign: 1 }, ...(exclusions ?? []).map((ring) => ({ ring, zone, sign: -1 })));
  });
  let pending: { x: number; bounds: SampledInterval[] } | undefined;
  let squareMetres = 0;
  sweepStrip(axis, polygons.map(({ ring }) => ring), (sections, x, activeIndices) => {
    const order: { z: number; mid: number; ring: number; delta: number }[] = [];
    for (const ring of activeIndices) for (const [near, far, midNear, midFar] of sections[ring])
      order.push({ z: near, mid: midNear, ring, delta: 1 }, { z: far, mid: midFar, ring, delta: -1 });
    order.sort((a, b) => a.mid - b.mid);
    let parcel = 0, blocked = 0;
    const inside = zones.map(() => 0);
    const zoneBlocks = zones.map(() => 0);
    const bounds: SampledInterval[] = [];
    let start: { z: number; mid: number } | undefined;
    for (const edge of order) {
      const { zone, sign } = polygons[edge.ring];
      if (zone < 0) {
        if (sign > 0) parcel += edge.delta;
        else blocked += edge.delta;
      } else if (sign > 0) inside[zone] += edge.delta;
      else zoneBlocks[zone] += edge.delta;
      const available = parcel > 0 && blocked === 0 && (!zones.length || inside.some((count, i) => count > 0 && zoneBlocks[i] === 0));
      if (available) start ??= edge;
      else if (start) {
        if (edge.mid - start.mid > EDGE_EPS) bounds.push([start.z, edge.z, start.mid, edge.mid]);
        start = undefined;
      }
    }
    if (!pending) { pending = { x, bounds }; return; }
    const intervals = pending.bounds.map((left, i): [SampledInterval, SampledInterval] => [left, bounds[i]]);
    const slabWidth = x - pending.x;
    squareMetres += slabWidth * intervals.reduce((s, [[a, b], [c, d]]) => s + (b - a + d - c) / 2, 0);
    slabs.push({ left: origin + pending.x, right: origin + x, intervals });
    pending = undefined;
  }, [], expired);

  /** Largest rectangle found on the sweep grid, within the same available region. */
  const rectangle = (limit: number, accepts?: (ring: P2[]) => boolean, minimum = 0, expired?: () => boolean): P2[] | undefined => {
    if (limit <= minimum + EDGE_EPS) return undefined;
    const bands = slabs.flatMap(({ left, right, intervals }) => {
      const subdivisions = intervals.some(([[a, b], [c, d]]) => Math.abs(a - c) + Math.abs(b - d) > EDGE_EPS) ? 8 : 1;
      return Array.from({ length: subdivisions }, (_, i) => {
        const lo = i / subdivisions, hi = (i + 1) / subdivisions;
        const depths: number[] = [];
        for (const [[a, b], [c, d]] of intervals) {
          const near = Math.max(a + (c - a) * lo, a + (c - a) * hi);
          const far = Math.min(b + (d - b) * lo, b + (d - b) * hi);
          if (far - near > EDGE_EPS) depths.push(near, far);
        }
        return { left: left + (right - left) * lo, right: left + (right - left) * hi, depths };
      });
    });
    let largest = minimum;
    let best: P2[] | undefined;
    // Bound the placement search on very detailed survey geometry.
    const stride = Math.max(1, Math.ceil(bands.length / 250));
    // Use flat buffers for the interval lists in the inner sweep.
    const overlap: number[] = [], scratch: number[] = [];
    for (let i = 0; i < bands.length; i++) {
      let depths = bands[i].depths;
      const end = i % stride === 0 ? bands.length : i + 1;
      const maxWidth = bands[end - 1].right - bands[i].left;
      for (let j = i; j < end && depths.length; j++) {
        if (expired?.()) return best;
        if (j > i) {
          // Both interval lists are ordered and disjoint. Walk them once per span.
          const next = depths === overlap ? scratch : overlap;
          next.length = 0;
          const band = bands[j].depths;
          let k = 0, l = 0;
          while (k < depths.length && l < band.length) {
            const b = depths[k + 1], d = band[l + 1];
            const near = Math.max(depths[k], band[l]), far = Math.min(b, d);
            if (far - near > EDGE_EPS && (far - near) * maxWidth > largest + EDGE_EPS) next.push(near, far);
            if (b <= d) k += 2;
            if (d <= b) l += 2;
          }
          depths = next;
        }
        const w = bands[j].right - bands[i].left;
        for (let k = 0; k < depths.length; k += 2) {
          const near = depths[k], far = depths[k + 1];
          const d = far - near;
          const size = Math.min(limit, w * d);
          if (size <= largest + EDGE_EPS) continue;
          const x = bands[i].left, y = -far;
          const consider = (width: number, depth: number, u: number, v: number) => {
            const candidateArea = width * depth;
            if (candidateArea <= largest + EDGE_EPS) return false;
            const ring = rect(x + (w - width) * u, y + (d - depth) * v, width, depth);
            if (accepts && !accepts(ring)) return false;
            best = ring;
            largest = candidateArea;
            return true;
          };
          const scale = Math.sqrt(size / (w * d));
          if (!consider(w * scale, d * scale, 0.5, 0.5) && accepts) {
            // Sample the centre and edges of each open region at several sizes and proportions.
            for (const fraction of [1, 0.9, 0.75, 0.5, 0.25, 0.1]) {
              const target = size * fraction;
              if (target <= largest + EDGE_EPS) break;
              const scaled = Math.sqrt(target / (w * d));
              for (const width of [w * scaled, w, target / d]) {
                const depth = target / width;
                const xSamples = w - width > EDGE_EPS ? [0.5, 0, 1] : [0.5];
                const ySamples = d - depth > EDGE_EPS ? [0.5, 0, 1] : [0.5];
                for (const u of xSamples) {
                  for (const v of ySamples) {
                    if (expired?.()) return best;
                    consider(width, depth, u, v);
                  }
                }
              }
            }
          }
          if (largest >= limit - EDGE_EPS) return best;
        }
      }
    }
    return best;
  };
  return { area: Math.max(0, squareMetres), rectangle };
}

export function roadAllowance(facade: Facade, plot: P2[], roads: RoadSurface[], depth: number): number {
  if (!roads.length || depth <= EDGE_EPS ||
    !polygonEdges(plot).some(([from, to]) => onEdge(facade.from, from, to) && onEdge(facade.to, from, to))) return 0;
  return plotStripDepth(setbackStrip(facade, depth), plot, roads);
}

/** Least usable depth anywhere along the façade, including adjoining road halves.
 * A road must meet the plot at its near edge. With polygons the midpoint of the local
 * road cross-section estimates its centre line.
 */
export function plotStripDepth(strip: SetbackStrip, site: P2[], roads: RoadSurface[] = []): number {
  return plotStripBoundary(strip, site, roads).available;
}

/** The controlling depth and the road extension at that same cross-section. */
export function plotStripBoundary(strip: SetbackStrip, site: P2[], roads: RoadSurface[]) {
  let available = strip.depth;
  let allowance = 0;
  const nearby = roads.filter((road) => boundsOverlap(strip.ring, road.ring));
  const polygons = [site];
  const midpoints: number[] = [];
  for (const road of nearby) {
    if (road.halves) polygons.push(...road.halves);
    else { midpoints.push(polygons.length); polygons.push(road.ring); }
  }
  sweepStrip(strip, polygons, ([plot = [], ...streets]) => {
    const parcel = plot.find(([, , near, far]) => near <= EDGE_EPS && far >= -EDGE_EPS);
    if (!parcel) { available = 0; allowance = 0; return; }
    const [, boundary, , midBoundary] = parcel;
    let end = boundary;
    let offset = 0;
    for (const road of nearby) {
      if (road.halves) {
        const halves = [...(streets[offset] ?? []), ...(streets[offset + 1] ?? [])];
        offset += 2;
        // Credit only the adjacent half, even if the plot edge is already at the centre line.
        const adjacent = halves.filter(([, , near, far]) => near <= midBoundary + EDGE_EPS && far >= midBoundary - EDGE_EPS);
        if (adjacent.length === 1) end = Math.max(end, adjacent[0][1]);
      } else {
        for (const [near, far, midNear, midFar] of streets[offset++] ?? []) {
          if (midNear <= midBoundary + EDGE_EPS && midFar > midBoundary)
            end = Math.max(end, (near + far) / 2);
        }
      }
    }
    const depth = Math.max(0, end);
    const extra = depth - Math.max(0, boundary);
    if (depth < available || (depth === available && extra < allowance)) {
      available = depth;
      allowance = extra;
    }
  }, midpoints);
  return { available, allowance };
}

export function ringBounds(ring: P2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function ringBoundsOverlap(a: ReturnType<typeof ringBounds>, b: ReturnType<typeof ringBounds>) {
  return a.minX + EDGE_EPS < b.maxX && a.maxX - EDGE_EPS > b.minX
    && a.minY + EDGE_EPS < b.maxY && a.maxY - EDGE_EPS > b.minY;
}

function boundsOverlap(a: P2[], b: P2[]) {
  return ringBoundsOverlap(ringBounds(a), ringBounds(b));
}

/** Available depth before the obstacle and greatest depth of the overlap along a façade normal. */
export function stripOverlap(strip: SetbackStrip, polygon: P2[]): { available: number; overlap: number } {
  let available = strip.depth, overlap = 0;
  if (!boundsOverlap(strip.ring, polygon)) return { available, overlap };
  sweepStrip(strip, [polygon], ([sections = []]) => {
    for (const [near, far, midNear, midFar] of sections) {
      if (Math.min(strip.depth, midFar) - Math.max(0, midNear) <= EDGE_EPS) continue;
      available = Math.min(available, Math.max(0, near));
      overlap = Math.max(overlap, Math.min(strip.depth, far) - Math.max(0, near));
    }
  });
  return { available, overlap };
}
