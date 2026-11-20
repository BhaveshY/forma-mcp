// Sun hours on the ground, computed locally from a height map. Used when Forma does not
// share its own result grid (sites on the new live sun hours). Local coords: +x east, +y north.

const RAD = Math.PI / 180;

/** Sun direction for a UTC time (ms) at lat/lon (degrees). NOAA approximation, ~0.5° accurate. */
export function sunPosition(utcMs: number, lat: number, lon: number): { alt: number; az: number } {
  const jd = utcMs / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + lon) * RAD - ra);
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  // azimuth from north, clockwise
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { alt, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

export type HeightGrid = {
  width: number; height: number; x0: number; y0: number; res: number;
  ground: Float32Array; // ground z per cell
  top: Float32Array; // highest obstacle z per cell (>= ground)
};

/** Rasterise triangles into a max-z map (cell centre inside the triangle's xy footprint). */
export function rasterMax(tris: ArrayLike<number>, g: Pick<HeightGrid, "width" | "height" | "x0" | "y0" | "res">, out: Float32Array, mode: "max" | "interp" = "max") {
  const { width, height, x0, y0, res } = g;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2], bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5], cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue; // vertical face: covered by the roof/top faces
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / res)), c1 = Math.min(width - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / res));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / res)), r1 = Math.min(height - 1, Math.ceil((Math.max(ay, by, cy) - y0) / res));
    const zmax = Math.max(az, bz, cz);
    for (let r = r0; r <= r1; r++) {
      const py = y0 + (r + 0.5) * res;
      for (let c = c0; c <= c1; c++) {
        const px = x0 + (c + 0.5) * res;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const z = mode === "max" ? zmax : l1 * az + l2 * bz + l3 * cz;
        const k = r * width + c;
        if (!(out[k] >= z)) out[k] = z;
      }
    }
  }
}

/**
 * Hours of direct sun per ground cell for one day. Cells covered by an obstacle
 * (roof more than 0.5 m above ground) are masked out. stepMin: sampling interval.
 */
export function sunHours(g: HeightGrid, lat: number, lon: number, year: number, month: number, day: number, stepMin = 15) {
  const { width, height, res, ground, top } = g;
  const n = width * height;
  const hours = new Float32Array(n);
  const mask = new Uint8Array(n);
  let zMax = -Infinity;
  for (let k = 0; k < n; k++) {
    if (top[k] > zMax) zMax = top[k];
    mask[k] = top[k] - ground[k] > 0.5 ? 0 : 1;
  }
  // Scan 24 h centred on local solar noon of that calendar day.
  const noon = Date.UTC(year, month - 1, day, 12) - (lon / 15) * 3600000;
  const suns: { dx: number; dy: number; tan: number }[] = [];
  for (let t = noon - 12 * 3600000; t < noon + 12 * 3600000; t += stepMin * 60000) {
    const s = sunPosition(t + (stepMin * 60000) / 2, lat, lon);
    if (s.alt <= 0.5 * RAD) continue;
    suns.push({ dx: Math.sin(s.az), dy: Math.cos(s.az), tan: Math.tan(s.alt) });
  }
  const stepH = stepMin / 60;
  const stepLen = res * 0.75;
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const k = r * width + c;
      if (!mask[k]) continue;
      const z0 = ground[k] + 0.1;
      let h = 0;
      for (const s of suns) {
        const reach = (zMax - z0) / s.tan; // beyond this nothing can block
        let lit = true;
        for (let d = stepLen; d <= reach; d += stepLen) {
          const cc = Math.floor(c + 0.5 + (s.dx * d) / res), rr = Math.floor(r + 0.5 + (s.dy * d) / res);
          if (cc < 0 || rr < 0 || cc >= width || rr >= height) break;
          if (top[rr * width + cc] > z0 + d * s.tan) { lit = false; break; }
        }
        if (lit) h += stepH;
      }
      hours[k] = h;
    }
  return { grid: hours, mask, daylight_h: suns.length * stepH };
}
