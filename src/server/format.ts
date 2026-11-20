// Token-lean rendering of op results.
type AnyObj = Record<string, any>;

export function table(cols: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/[\t\n]/g, " "));
  // drop columns that are empty in every row
  const keep = cols.map((_, i) => rows.some((r) => cell(r[i]) !== ""));
  const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
  return [pick(cols).join("\t"), ...rows.map((r) => pick(r.map(cell)).join("\t"))].join("\n");
}

/** One `key: value` line per top-level key; nested values as compact JSON. */
export function kv(o: AnyObj): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
}

export function render(v: unknown): string {
  if (v === null || v === undefined) return "ok";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("\n");
  const o = v as AnyObj;
  if (Array.isArray(o.cols) && Array.isArray(o.rows)) {
    const { cols, rows, ...rest } = o;
    const head = Object.keys(rest).length ? kv(rest) + "\n" : "";
    return head + (rows.length ? table(cols, rows) : "(none)");
  }
  return kv(o);
}
