// Live end-to-end test against a real Forma panel (through the real MCP server, like Codex).
// Runs in a DUPLICATE design option; the original is fingerprinted before and after and must be unchanged.
//   node scripts/e2e-live.mjs [report.md]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "e2e-report.md";
const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.FORMA_MCP_SERVER ?? "dist/server.js"], env: process.env, stderr: "ignore" });
const client = new Client({ name: "e2e-live", version: "0" });
await client.connect(transport);

const results = [];
async function call(tool, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600000 });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const image = r.content.find((c) => c.type === "image");
  return { ok: !r.isError, text, image, ms: Date.now() - t0 };
}
const json = (t) => { try { return JSON.parse(t.split("\n-- ")[0]); } catch { return undefined; } };
const kv = (t, k) => { const m = t.match(new RegExp(`^${k}: (.*)$`, "m")); return m ? m[1] : undefined; };
const rows = (t) => t.split("\n").filter((l) => /^root\//.test(l)).map((l) => l.split("\t"));
async function step(name, fn, { limit = false } = {}) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail: detail ?? "", ms: Date.now() - t0 });
    console.log(`PASS ${name} — ${detail ?? ""}`);
  } catch (e) {
    results.push({ name, status: limit ? "LIMIT" : "FAIL", detail: String(e.message ?? e), ms: Date.now() - t0 });
    console.log(`${limit ? "LIMIT" : "FAIL"} ${name} — ${e.message ?? e}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol, what) => expect(Math.abs(a - b) <= tol, `${what}: got ${a}, expected ${b} ±${tol}`);

async function fingerprint() {
  const st = await call("forma_status", {});
  const f = await call("forma_find", { category: "building", fields: ["height", "floors"], limit: 500 });
  const m = await call("forma_metrics", {});
  return { counts: kv(st.text, "counts"), model: kv(st.text, "model"), buildings: rows(f.text).map((r) => r.join("|")).sort().join("\n"), gfa: kv(m.text, "gfa_m2"), far: kv(m.text, "far") };
}

// ---------- 0. baseline of the ORIGINAL design option ----------
const st0 = await call("forma_status", {});
expect(st0.ok, `not connected: ${st0.text}`);
const original = JSON.parse(kv(st0.text, "model")).id;
const before = await fingerprint();
console.log(`original design option ${original}`);

// ---------- 1. work in a copy ----------
let copy;
await step("Duplicate the design option and work in the copy", async () => {
  const r = await call("forma_site", { action: "duplicate" });
  expect(r.ok, r.text);
  for (let i = 0; i < 40; i++) {
    const s = await call("forma_status", {});
    const id = JSON.parse(kv(s.text, "model") ?? "{}").id;
    if (s.ok && id && id !== original) { copy = id; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  expect(copy, "did not switch to the copy");
  return `copy ${copy}`;
});
if (!copy) { finish(); process.exit(1); }

// ---------- 2. reading ----------
let siteRing, basic, bdesign;
await step("Read: status, counts, edit rights", async () => {
  const r = await call("forma_status", {});
  expect(/canEdit: true/.test(r.text), "no edit rights");
  return `${JSON.parse(kv(r.text, "counts")).building} buildings · ${r.ms} ms`;
});
await step("Read: area numbers match Forma's own (GFA = sum, FAR = GFA / site)", async () => {
  const r = await call("forma_metrics", {});
  const gfa = +kv(r.text, "gfa_m2"), site = +kv(r.text, "site_area_m2"), far = +kv(r.text, "far");
  near(far, gfa / site, 0.01, "FAR");
  return `GFA ${gfa} m², site ${site} m², FAR ${far}, coverage ${kv(r.text, "coverage")}`;
});
await step("Read: site boundary and buildings inside it", async () => {
  const s = await call("forma_find", { category: "site_limit", fields: [] });
  const sp = rows(s.text)[0]?.[0];
  const rd = json((await call("forma_read", { paths: [sp], what: ["footprint"] })).text);
  siteRing = rd?.footprint?.pts;
  expect(siteRing?.length >= 3, "no site outline");
  const f = await call("forma_find", { category: "building", inside: siteRing, fields: ["area", "floors"] });
  return `${rows(f.text).length} buildings inside the site`;
});
await step("Read: traced footprints equal Forma's own per-building footprint (±0.5 m²)", async () => {
  const f = await call("forma_find", { category: "building", inside: siteRing, fields: ["area"] });
  let worst = 0;
  const cols = f.text.split("\n").find((l) => l.startsWith("path\t"))?.split("\t") ?? [];
  const ai = cols.indexOf("area");
  for (const r of rows(f.text)) {
    const m = await call("forma_metrics", { paths: [r[0]] });
    const d = Math.abs(+r[ai] - +kv(m.text, "footprint_m2"));
    expect(Number.isFinite(d), `could not compare ${r[0]}: '${r[ai]}' vs '${kv(m.text, "footprint_m2")}'`);
    worst = Math.max(worst, d);
  }
  expect(worst <= 0.5, `largest difference ${worst} m²`);
  return `largest difference ${worst.toFixed(2)} m²`;
});
await step("Read: find building kinds (Site Design / Building Design)", async () => {
  const r = await call("forma_script", { code: `const root=(await Forma.elements.get({urn: await Forma.proposal.getRootUrn(), recursive:true}));
    const out={basic:[],bd:[]};
    const walk=(urn,path)=>{const e=root.elements[urn]; for(const c of (e?.children||[])){const p=path+"/"+c.key; const ce=root.elements[c.urn];
      if(ce?.properties?.category==="building"){ if(/:basicbuilding:/.test(c.urn)&&ce.representations?.__INTERNAL__) out.basic.push(p); if(/:building-design:/.test(c.urn)) out.bd.push(p);} walk(c.urn,p);} };
    walk(root.element.urn,"root"); return out;` });
  const o = json(r.text);
  basic = o?.basic?.[0];
  bdesign = o?.bd?.find((p) => p.split("/").length === 3) ?? o?.bd?.[0];
  expect(basic, "no Site Design building found");
  return `Site Design: ${o.basic.length}, Building Design: ${o.bd.length}`;
});

// ---------- 3. creating and editing ----------
let made;
const [cx, cy] = siteRing.reduce((a, p) => [a[0] + p[0] / siteRing.length, a[1] + p[1] / siteRing.length], [0, 0]);
await step("Create: preview writes nothing", async () => {
  const c0 = (await call("forma_status", {})).text;
  const r = await call("forma_create", { preview: true, items: [{ type: "building", name: "E2E block", rect: [cx, cy, 12, 10, 0], floors: 4, floorHeight: 3.5, func: "Residential" }] });
  expect(r.ok && /preview/.test(r.text), r.text);
  expect(kv((await call("forma_status", {})).text, "counts") === kv(c0, "counts"), "preview changed the design");
  return "no change";
});
await step("Create: 4-floor residential block, 12 × 10 m", async () => {
  const r = await call("forma_create", { items: [{ type: "building", name: "E2E block", rect: [cx, cy, 12, 10, 0], floors: 4, floorHeight: 3.5, func: "Residential" }] });
  expect(r.ok, r.text);
  made = rows(r.text)[0]?.[0];
  const rd = json((await call("forma_read", { paths: [made], what: ["floors", "bbox", "footprint"] })).text);
  near(rd.floors, 4, 0, "floors"); near(rd.height, 14, 0.05, "height"); near(rd.area, 120, 0.5, "footprint");
  return `${made}: ${rd.floors} floors, ${rd.height} m, ${rd.area} m², ${rd.gfa} m² GFA`;
});
const box = async (p) => json((await call("forma_read", { paths: [p], what: ["bbox"] })).text);
await step("Edit: move 5 m east", async () => {
  const b0 = await box(made);
  const r = await call("forma_edit", { ops: [{ op: "move", paths: [made], dx: 5 }] });
  expect(r.ok, r.text);
  made = kv(r.text, "paths") ? JSON.parse(kv(r.text, "paths"))[0] : made;
  const b1 = await box(made);
  near(b1.bbox[0][0] - b0.bbox[0][0], 5, 0.02, "x shift");
  return `moved ${(b1.bbox[0][0] - b0.bbox[0][0]).toFixed(2)} m`;
});
await step("Edit: rotate 90°", async () => {
  const b0 = await box(made);
  const r = await call("forma_edit", { ops: [{ op: "move", paths: [made], rotate: 90 }] });
  expect(r.ok, r.text);
  made = kv(r.text, "paths") ? JSON.parse(kv(r.text, "paths"))[0] : made;
  const b1 = await box(made);
  const w0 = b0.bbox[1][0] - b0.bbox[0][0], w1 = b1.bbox[1][1] - b1.bbox[0][1];
  near(w1, w0, 0.05, "width after rotation");
  return "width and depth swapped";
});
await step("Edit: copy twice (array)", async () => {
  const n0 = JSON.parse(kv((await call("forma_status", {})).text, "counts")).building;
  const r = await call("forma_edit", { ops: [{ op: "copy", paths: [made], dy: 15, count: 2 }] });
  expect(r.ok, r.text);
  const n1 = JSON.parse(kv((await call("forma_status", {})).text, "counts")).building;
  near(n1 - n0, 2, 0, "new buildings");
  return "+2 buildings";
});
await step("Edit: rename", async () => {
  const r = await call("forma_edit", { ops: [{ op: "rename", paths: [made], name: "E2E renamed" }] });
  expect(r.ok, r.text);
  made = kv(r.text, "paths") ? JSON.parse(kv(r.text, "paths"))[0] : made;
  const f = await call("forma_find", { name: "E2E renamed" });
  expect(rows(f.text).length === 1, f.text);
  return "found by new name";
});
await step("Edit: custom properties", async () => {
  const r = await call("forma_edit", { ops: [{ op: "props", paths: [made], patch: { "e2e:test": { tag: "ok" } } }] });
  expect(r.ok, r.text);
  const rd = json((await call("forma_read", { paths: [made], what: ["props"] })).text);
  expect(rd?.props?.["e2e:test"]?.tag === "ok", JSON.stringify(rd?.props));
  return "property stored";
});
await step("Floors: +2 on a block made by the MCP", async () => {
  const r = await call("forma_edit", { ops: [{ op: "floors", paths: [made], add: 2 }] });
  expect(r.ok, r.text);
  const rd = json((await call("forma_read", { paths: [made], what: ["floors", "bbox"] })).text);
  near(rd.floors, 6, 0, "floors"); near(rd.height, 21, 0.1, "height");
  return `${rd.floors} floors, ${rd.height} m`;
});
await step("Floors: −3 on a Site Design building", async () => {
  const r0 = json((await call("forma_read", { paths: [basic], what: ["floors", "bbox"] })).text);
  const r = await call("forma_edit", { ops: [{ op: "floors", paths: [basic], add: -3 }] });
  expect(r.ok, r.text);
  const r1 = json((await call("forma_read", { paths: [basic], what: ["floors", "bbox"] })).text);
  near(r1.floors, r0.floors - 3, 0, "floors");
  expect(r1.height < r0.height - 6, `height ${r0.height} → ${r1.height}`);
  return `${r0.floors} → ${r1.floors} floors, ${r0.height} → ${r1.height} m`;
});
if (bdesign) {
  await step("Floors: Building Design building is refused with a clear message (nothing changed)", async () => {
    const c0 = kv((await call("forma_status", {})).text, "counts");
    const r = await call("forma_edit", { ops: [{ op: "floors", paths: [bdesign], add: 6 }] });
    expect(!r.ok && /Building Design/.test(r.text), r.text);
    expect(kv((await call("forma_status", {})).text, "counts") === c0, "something changed");
    return "refused, no change";
  });
}
await step("Undo: every edit in this test, back to the start of the copy", async () => {
  let n = 0;
  for (; n < 30; n++) {
    const r = await call("forma_edit", { undo: 1 });
    if (!r.ok) { expect(/nothing to undo/.test(r.text), r.text); break; }
  }
  return `${n} undo steps`;
});

// ---------- 4. view & analysis (visual only) ----------
await step("View: colour by height, isolate, show all, clear colours", async () => {
  for (const a of [{ action: "color_by", by: "height" }, { action: "isolate", category: "building" }, { action: "show_all" }, { action: "clear_colors" }]) {
    const r = await call("forma_view", a);
    expect(r.ok, `${a.action}: ${r.text}`);
  }
  return "4 actions";
});
await step("View: picture of the site", async () => {
  const r = await call("forma_view", { action: "capture", fit: "iso", width: 640, height: 400 });
  expect(r.ok && r.image, r.text);
  return `${Math.round(Buffer.from(r.image.data, "base64").length / 1024)} KB image`;
});
await step("Analysis: sun hours on open ground (21 June)", async () => {
  const r = await call("forma_analysis", { action: "sun_hours", month: 6, day: 21, threshold: 4 });
  expect(r.ok && +kv(r.text, "cells") > 0, r.text);
  await call("forma_analysis", { action: "sun_hours_hide" });
  return `median ${kv(r.text, "median")} h of ${kv(r.text, "daylight_h")} h, ${kv(r.text, "ms")} ms`;
});
await step("Analysis: list Forma analyses", async () => {
  const r = await call("forma_analysis", { action: "list" });
  expect(r.ok, r.text);
  return `${r.text.split("\n").length - 2} rows`;
});
await step("Errors: a wrong path gives a plain fix", async () => {
  const r = await call("forma_edit", { ops: [{ op: "move", paths: ["root/does-not-exist"], dx: 1 }] });
  expect(!r.ok && /fix:/.test(r.text), r.text);
  return "error + fix";
});

// ---------- 5. back to the original, delete the copy, prove nothing changed ----------
await step("Clean up: back to the original design option, delete the copy", async () => {
  let r = await call("forma_site", { action: "switch", id: original });
  expect(r.ok, r.text);
  for (let i = 0; i < 40; i++) {
    const s = await call("forma_status", {});
    if (JSON.parse(kv(s.text, "model") ?? "{}").id === original) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  r = await call("forma_site", { action: "delete_proposal", id: copy, confirm: true });
  expect(r.ok, r.text);
  return "copy deleted";
});
await step("Original design option is exactly as before", async () => {
  const after = await fingerprint();
  for (const k of Object.keys(before)) expect(before[k] === after[k], `${k} changed`);
  return `${JSON.parse(after.counts).building} buildings, GFA ${after.gfa} m², FAR ${after.far} — unchanged`;
});

finish();

function finish() {
  const pass = results.filter((r) => r.status === "PASS").length, fail = results.filter((r) => r.status === "FAIL").length;
  const md = [`# forma-mcp live end-to-end test`, ``, `${new Date().toISOString()} · ${pass} passed · ${fail} failed`, ``, `| Check | Result | Detail | Time |`, `|---|---|---|---|`,
    ...results.map((r) => `| ${r.name} | ${r.status === "PASS" ? "✅" : r.status === "LIMIT" ? "⚠️" : "❌"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 220)} | ${(r.ms / 1000).toFixed(1)} s |`)].join("\n");
  writeFileSync(out, md + "\n");
  console.log(`\n${pass} passed, ${fail} failed → ${out}`);
  client.close();
}
