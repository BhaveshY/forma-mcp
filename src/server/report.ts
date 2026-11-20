// Saves a design report (HTML to read/print + CSV for Excel) on the user's computer.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type AnyObj = Record<string, any>;

export const reportDir = () => process.env.FORMA_MCP_REPORT_DIR ?? join(homedir(), "Documents", "Forma MCP reports");

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const csvCell = (s: unknown) => {
  const v = String(s ?? "");
  // Neutralise spreadsheet formulas in names (=, +, -, @) and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const slug = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "design";

const COLS: [string, string][] = [["name", "Building"], ["use", "Use"], ["uses", "Uses"], ["floors", "Floors"], ["height_m", "Height (m)"], ["footprint_m2", "Footprint (m²)"], ["gfa_m2", "Floor area (m²)"]];
const RULE_NAMES: Record<string, string> = { maxHeight: "Maximum height (m)", maxFloors: "Maximum floors", maxFar: "Maximum FAR", maxCoverage: "Maximum site coverage (%)", minSetback: "Minimum distance to site boundary (m)", minSpacing: "Minimum distance between buildings (m)" };

export function toCsv(r: AnyObj): string {
  const lines = [COLS.map(([, h]) => h).join(";")];
  for (const b of r.buildings ?? []) lines.push(COLS.map(([k]) => csvCell(b[k])).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM so Excel reads ü/² correctly
}

export function toHtml(r: AnyObj, when = new Date()): string {
  const t = r.totals ?? {};
  const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-GB", { maximumFractionDigits: 2 }) : esc(v));
  const kpi = [["Floor area (GFA)", t.gfa_m2 !== undefined ? `${fmt(t.gfa_m2)} m²` : "n/a"], ["Site area", typeof t.site_area_m2 === "number" ? `${fmt(t.site_area_m2)} m²` : "n/a"], ["FAR", fmt(t.far)], ["Site coverage", esc(t.coverage)], ["Buildings on site", String((r.buildings ?? []).length)]];
  const rows = (r.buildings ?? []).map((b: AnyObj) => `<tr>${COLS.map(([k]) => `<td${k === "name" || k === "use" || k === "uses" ? "" : ' class="n"'}>${fmt(b[k])}</td>`).join("")}</tr>`).join("");
  let check = "";
  if (r.check) {
    const lim = Object.entries(r.rules ?? {}).map(([k, v]) => `<li>${esc(RULE_NAMES[k] ?? k)}: ${fmt(v)}</li>`).join("");
    const vs = (r.check.violations ?? []).map((v: AnyObj) => `<li>${esc(v.text)}</li>`).join("");
    check = `<h2>Planning rules</h2><ul>${lim}</ul>${r.check.ok ? '<p class="ok">All checked rules are met.</p>' : `<p class="bad">${r.check.violations.length} problem(s):</p><ul class="bad">${vs}</ul>`}${r.check.skipped?.length ? `<p class="mut">Not checked: ${esc(r.check.skipped.join(", "))}</p>` : ""}`;
  }
  const byUse = Object.entries(t.gfa_by_function ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.project ?? "Forma")} – design report</title>
<style>body{font:14px/1.5 system-ui,"Segoe UI",sans-serif;color:#1d1d1f;max-width:960px;margin:32px auto;padding:0 16px}h1{margin:0}h2{margin-top:28px;font-size:16px}
.mut{color:#6e6e73}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.kpis div{border:1px solid #e5e5ea;border-radius:10px;padding:10px}
.kpis b{display:block;font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e5ea;padding:5px 6px;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#1e7a44}.bad{color:#c0392b}@media print{body{margin:0}}</style></head><body>
<h1>${esc(r.project ?? "Forma project")}</h1><div class="mut">Design option: ${esc(r.design_option ?? "–")} · ${esc(when.toLocaleString("en-GB"))} · figures count buildings inside the site boundary, as Forma does</div>
<div class="kpis">${kpi.map(([k, v]) => `<div><span class="mut">${k}</span><b>${v}</b></div>`).join("")}</div>
${check}
${byUse ? `<h2>Floor area by use</h2><table><tr><th>Use</th><th class="n">m²</th></tr>${byUse}</table>` : ""}
<h2>Buildings</h2><table><tr>${COLS.map(([k, h]) => `<th${k === "name" || k === "use" || k === "uses" ? "" : ' class="n"'}>${h}</th>`).join("")}</tr>${rows}</table>
<p class="mut">Made with Forma MCP. Heights are measured from the 3D model; check final figures in Forma.</p></body></html>`;
}

export function saveReport(r: AnyObj, dir = reportDir(), when = new Date()): { html: string; csv: string } {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const base = join(dir, `${slug(r.project)}-${slug(r.design_option)}-${stamp}`);
    const htmlText = toHtml(r, when), csvText = toCsv(r);
    const options = { encoding: "utf8", flag: "wx" } as const;
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const html = `${name}.html`, csv = `${name}.csv`;
      let wroteHtml = false;
      try {
        writeFileSync(html, htmlText, options);
        wroteHtml = true;
        writeFileSync(csv, csvText, options);
        return { html, csv };
      } catch (err) {
        if (wroteHtml) unlinkSync(html);
        if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
      }
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && typeof err.code === "string"
      && ["EPERM", "EACCES", "ENOENT", "EROFS"].includes(err.code)) {
      throw new Error(
        `Forma MCP could not save the report in "${resolve(dir)}" (${err.code}).\n` +
        'fix: Choose another folder by setting the FORMA_MCP_REPORT_DIR environment variable, or check that this folder is writable and that Windows "Controlled folder access" allows Forma MCP to write there.',
        { cause: err },
      );
    }
    throw err;
  }
}
