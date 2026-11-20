// Saves a design report (HTML to read/print + CSV for Excel) on the user's computer.
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AbstandResult } from "../shared/abstand.js";
import type { ExcludedPlotBuilding, PlotBuilding, RuleReport } from "../shared/rules.js";

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

const COLS: [string, string][] = [
  ["name", "Building"], ["use", "Use"], ["uses", "Uses"], ["floors", "Floors"], ["full_storeys", "Full storeys (Vollgeschosse)"],
  ["height_m", "Height (m)"], ["footprint_m2", "Footprint (m²)"], ["gfa_m2", "Floor area (m²)"],
  ["ratio_status", "Site ratios"], ["abstand", "Abstandsflächen OK / shortfall m"],
];
const RULE_NAMES: Record<string, string> = {
  maxHeight: "Maximum height (m)", maxFloors: "Maximum floors", maxFar: "Maximum FAR", maxCoverage: "Maximum site coverage (%)",
  minSetback: "Minimum distance to site boundary (m)", minSpacing: "Minimum distance between buildings (m)",
  maxGrz: "Maximum site coverage (GRZ)", maxGrz2: "Maximum site coverage including ancillary areas (GRZ II)",
  ancillaryArea_m2: "Entered ancillary area (m²)", maxGfz: "Maximum floor area ratio (GFZ)",
  nonFullTopFloors: "Top floors excluded per building", maxFullStoreys: "Maximum permitted full storeys (Vollgeschosse)",
  insideZone: "Check building zone (Baufenster)", zone: "Requested building zone (Baufenster)",
};
const PLANNING_FIGURES = [
  ["grz", "Site coverage (GRZ)"], ["grz2", "Site coverage including ancillary areas (GRZ II)"],
  ["grz2_limit", "Limit used (GRZ II)"], ["grz2_limit_source", "Basis for the GRZ II limit"],
  ["grz2_area_source", "Ancillary area counted"], ["gfz", "Floor area ratio (GFZ)"],
  ["max_full_storeys", "Highest full-storey count (Vollgeschosse)"],
  ["full_storeys_assumption", "Full-storey counting assumption"], ["zone", "Building zone used (Baufenster)"],
];

export function planningFigures(r: AnyObj): [string, number | string][] {
  const summary = r.check?.summary ?? {};
  const figures: [string, number | string][] = PLANNING_FIGURES.filter(([key]) => summary[key] !== undefined).map(([key, name]) => [name, summary[key]]);
  const inventory: PlotBuilding[] | undefined = r.check?.plotInventory;
  if (inventory) figures.push(["Site ratio contributor count", inventory.length]);
  if (r.check?.inventoryNote) figures.push(["Inventory note", r.check.inventoryNote]);
  return figures;
}

function buildingColumns(r: AnyObj): [string, string][] {
  return COLS.filter(([key]) => (key !== "full_storeys" || r.check?.summary?.full_storeys_assumption)
    && (key !== "abstand" || r.check?.abstand) && (key !== "ratio_status" || r.check?.plotInventory));
}

function buildingRows(r: AnyObj): AnyObj[] {
  const rows: AnyObj[] = r.buildings ?? [];
  const values: AbstandResult["buildings"] | undefined = r.check?.abstand?.buildings;
  if (!values) return rows;
  const byPath = new Map(values.map((b) => [b.path, b]));
  return rows.map((b) => {
    const a = byPath.get(b.path);
    return { ...b, abstand: a?.status === "ok" ? "OK" : a?.status === "shortfall" ? a.maxShortfall_m : "Manuell prüfen" };
  });
}

function abstandSection(check?: RuleReport): string {
  const a = check?.abstand;
  if (!a) return "";
  const outcome = a.buildings.length && a.buildings.every((b) => b.status === "ok") ? '<p class="ok">Alle geprüften Fassaden haben ausreichend Platz.</p>' : "";
  const notes = a.assumptions.map((s) => `<li>${esc(s)}</li>`).join("");
  const findings = check.violations.filter((v) => v.rule === "abstand")
    .map((v) => `<li>${esc(v.text)}</li>`).join("");
  const manual = check.skipped.filter((s) => s.startsWith("Abstandsflächen")).map((s) => `<li>${esc(s)}</li>`).join("");
  return `<section lang="de"><h2>Abstandsflächen${a.incomplete ? " (unvollständig)" : ""}</h2><p>${esc(a.state)} · ${esc(a.area)} · Faktor ${esc(a.factor ?? "manuell prüfen")} · <a href="${esc(a.url)}">${esc(a.citation)}</a></p>
<ul>${notes}</ul>${outcome}${findings || manual ? `<ul class="bad">${findings}${manual}</ul>` : ""}${a.fix ? `<p>fix: ${esc(a.fix)}</p>` : ""}</section>`;
}

export function toCsv(r: AnyObj): string {
  const lines = [COLS.map(([, h]) => h).join(";")];
  for (const b of buildingRows(r)) lines.push(COLS.map(([k]) => csvCell(b[k])).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM so Excel reads ü/² correctly
}

export function toFiguresCsv(r: AnyObj): string | undefined {
  const figures = planningFigures(r);
  const inventory: PlotBuilding[] = r.check?.plotInventory ?? [];
  for (const b of inventory) figures.push(["Site ratio contributor", b.name && b.name !== b.path ? `${b.name} (${b.path})` : b.path]);
  if (figures.length) return "\ufeff" + ["Planning figure;Value", ...figures.map((row) => row.map(csvCell).join(";"))].join("\r\n") + "\r\n";
}

export function toHtml(r: AnyObj, when = new Date()): string {
  const t = r.totals ?? {};
  const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-GB", { maximumFractionDigits: 2 }) : esc(v));
  const cols = buildingColumns(r);
  const kpi = [["Floor area (GFA)", t.gfa_m2 !== undefined ? `${fmt(t.gfa_m2)} m²` : "n/a"], ["Site area", typeof t.site_area_m2 === "number" ? `${fmt(t.site_area_m2)} m²` : "n/a"], ["FAR", fmt(t.far)], ["Site coverage", esc(t.coverage)], ["Buildings listed", String((r.buildings ?? []).length)]];
  const rows = buildingRows(r).map((b) => `<tr>${cols.map(([k]) => `<td${k === "name" || k === "use" || k === "uses" ? "" : ' class="n"'}>${fmt(b[k])}</td>`).join("")}</tr>`).join("");
  let check = "";
  if (r.check) {
    const lim = Object.entries(r.rules ?? {}).filter(([k]) => k !== "zoneRing" && k !== "abstand").map(([k, v]) => `<li>${esc(RULE_NAMES[k] ?? k)}: ${fmt(v)}</li>`).join("");
    const figures = planningFigures(r).map(([name, value]) => `<li>${esc(name)}: ${esc(value)}</li>`).join("");
    const violations = (r.check.violations ?? []).filter((v: AnyObj) => v.rule !== "abstand");
    const vs = violations.map((v: AnyObj) => `<li>${esc(v.text)}</li>`).join("");
    const skipped = (r.check.skipped ?? []).filter((s: string) => !s.startsWith("Abstandsflächen"));
    const checked = (r.check.checked ?? []).filter((s: string) => s !== "abstand");
    if (lim || figures || violations.length || checked.length || skipped.length) check = `<h2>Planning rules</h2><ul>${lim}</ul>${figures ? `<h2>Planning figures</h2><ul>${figures}</ul>` : ""}${!violations.length ? (checked.length ? '<p class="ok">All checked rules are met.</p>' : '<p>No rules were checked.</p>') : `<p class="bad">${violations.length} problem(s):</p><ul class="bad">${vs}</ul>`}${skipped.length ? `<p class="mut">Not checked: ${esc(skipped.join(", "))}</p>` : ""}`;
  }
  const byUse = Object.entries(t.gfa_by_function ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v)}</td></tr>`).join("");
  const excluded: ExcludedPlotBuilding[] = r.check?.excludedContext ?? [];
  const excludedRows = excluded.map((b) => `<tr><td>${esc(b.name ?? b.path)}</td><td>${esc(b.path)}</td><td class="n">${fmt(b.footprint_m2)}</td><td class="n">${b.totalFloorArea ? `${fmt(b.totalFloorArea.m2)} (${esc(b.totalFloorArea.source)})` : "unavailable"}</td><td>${esc(b.reason)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.project ?? "Forma")} – design report</title>
<style>body{font:14px/1.5 system-ui,"Segoe UI",sans-serif;color:#1d1d1f;max-width:960px;margin:32px auto;padding:0 16px}h1{margin:0}h2{margin-top:28px;font-size:16px}
.mut{color:#6e6e73}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.kpis div{border:1px solid #e5e5ea;border-radius:10px;padding:10px}
.kpis b{display:block;font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e5ea;padding:5px 6px;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#1e7a44}.bad{color:#c0392b}@media print{body{margin:0}}</style></head><body>
<h1>${esc(r.project ?? "Forma project")}</h1><div class="mut">Design option: ${esc(r.design_option ?? "–")} · ${esc(when.toLocaleString("en-GB"))}</div>
<h2>Forma area metrics</h2>
<div class="kpis">${kpi.map(([k, v]) => `<div><span class="mut">${k}</span><b>${v}</b></div>`).join("")}</div>
${check}
${abstandSection(r.check)}
${excludedRows ? `<h2>On the plot but not counted</h2><table><tr><th>Building</th><th>Path</th><th>Estimated footprint (m²)</th><th>GFA (m²)</th><th>Reason</th></tr>${excludedRows}</table>` : ""}
${byUse ? `<h2>Floor area by use</h2><table><tr><th>Use</th><th class="n">m²</th></tr>${byUse}</table>` : ""}
<h2>Buildings</h2><table><tr>${cols.map(([k, h]) => `<th${k === "name" || k === "use" || k === "uses" ? "" : ' class="n"'}>${h}</th>`).join("")}</tr>${rows}</table>
<p class="mut">Made with Forma MCP. Heights are measured from the 3D model; check final figures in Forma.</p></body></html>`;
}

export function saveReport(r: AnyObj, dir = reportDir(), when = new Date()): { html: string; csv: string; figuresCsv?: string } {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const base = join(dir, `${slug(r.project)}-${slug(r.design_option)}-${stamp}`);
    const htmlText = toHtml(r, when), csvText = toCsv(r), figuresText = toFiguresCsv(r);
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const html = `${name}.html`, csv = `${name}.csv`;
      const figuresCsv = `${name}-figures.csv`;
      const files: [string, string][] = [[html, htmlText], [csv, csvText]];
      if (figuresText) files.push([figuresCsv, figuresText]);
      const written: string[] = [];
      try {
        for (const [file, contents] of files) {
          const fd = openSync(file, "wx");
          written.push(file);
          try { writeFileSync(fd, contents, "utf8"); } finally { closeSync(fd); }
        }
        return { html, csv, ...(figuresText ? { figuresCsv } : {}) };
      } catch (err) {
        for (const file of written) unlinkSync(file);
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
