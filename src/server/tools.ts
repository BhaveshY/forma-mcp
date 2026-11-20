import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LinkManager } from "./link.js";
import { FormaError } from "../shared/protocol.js";
import { kv, render, table } from "./format.js";
import { saveReport } from "./report.js";

type AnyObj = Record<string, any>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Out = { content: Content[]; isError?: boolean };

function textResult(text: string, isError = false): Out {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function renderWriteFields(result: AnyObj, unconfirmed: boolean): string {
  if (!unconfirmed) return render(result);
  const { paths, ...fields } = result;
  return render({ ...fields, "unverified paths": paths });
}

// Plain arrays, not z.tuple: tuple schemas ("items": [...]) make Codex/OpenAI silently drop the whole tool.
const pt = z.array(z.number()).min(2).max(3);
const poly = z.array(pt).min(3);
const target = {
  paths: z.array(z.string()).optional(),
  from: z.string().optional(),
  category: z.union([z.string(), z.array(z.string())]).optional(),
};

const CREATE_EXAMPLE = '{"items":[{"type":"building","rect":[0,0,10,8],"floors":1}],"preview":true}';
const EDIT_EXAMPLE = '{"ops":[{"op":"move","category":"building","dx":1}],"preview":true}';

function oneTypo(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length !== b.length) {
    const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
    return longer.slice(i + 1) === shorter.slice(i);
  }
  return a.slice(i + 1) === b.slice(i + 1)
    || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

function strictFields<S extends z.ZodRawShape>(shape: S) {
  const fields = Object.keys(shape);
  const schema = z.object(shape, {
    errorMap(issue, ctx) {
      if (issue.code !== "unrecognized_keys") return { message: ctx.defaultError };
      const details = issue.keys.map((key) => {
        const candidates = fields.filter((name) => oneTypo(key.toLowerCase(), name.toLowerCase()));
        return candidates.length === 1 ? `"${key}" (did you mean ${candidates[0]}?)` : `"${key}"`;
      });
      return { message: `Unknown field${details.length === 1 ? "" : "s"} ${details.join(", ")}.
fix: Correct the field name or remove it from the request.` };
    },
  }).strict();

  // The MCP SDK parses before calling the handler and appends a path to each Zod issue.
  // Collect the issues here so the field locations come before the final fix line.
  const parse = schema.safeParseAsync.bind(schema);
  schema.safeParseAsync = async (input, params) => {
    const result = await parse(input, params);
    if (result.success) return result;
    const fixes = new Set<string>();
    const errors = result.error.issues.map((issue) => {
      const [message, fix] = issue.message.split("\nfix: ");
      if (fix) fixes.add(fix);
      const path = issue.path.reduce<string>((s, part) => typeof part === "number" ? `${s}[${part}]` : s ? `${s}.${part}` : part, "");
      return path ? `${path}: ${message}` : message;
    });
    const fix = fixes.size ? [...fixes].join(" ") : "Correct the values above and send the request again.";
    return { success: false, error: new z.ZodError([
      { code: "custom", path: [], message: `${errors.join("\n")}\nfix: ${fix}` },
    ]) };
  };
  return schema;
}

const num = z.number().optional();
const str = z.string().optional();
const numbers = z.array(z.number()).optional();
const rect = z.union([z.array(z.number()).min(4).max(5), strictFields({ x: num, y: num, w: z.number(), d: z.number(), rot: num })]).optional();
const floorPlan = { polygon: z.array(pt).optional(), rect, floors: z.number().int().optional(), floorHeight: num, heights: numbers, func: str };
const item = strictFields({
  ...floorPlan, type: str, name: str, groundHeight: num, tiers: z.array(strictFields({ ...floorPlan, inset: num })).optional(),
  z: z.union([z.number(), z.literal("terrain")]).optional(), parent: str, height: num, category: str,
  props: z.record(z.any()).optional(), virtual: z.boolean().optional(), line: z.array(pt).optional(),
  verts: numbers, faces: numbers, doubleSided: z.boolean().optional(),
});
const editOp = strictFields({
  ...target, path: str, op: str, dx: num, dy: num, dz: num, rotate: num, about: pt.optional(),
  count: z.number().int().optional(), name: str, patch: z.record(z.any()).optional(),
  floors: z.number().int().optional(), add: z.number().int().optional(),
});
const fit = z.union([z.boolean(), z.string(), strictFields({ ...target, path: str, view: str, zoom: num })]);
const pad = strictFields({ id: str, polygon: poly, z: num, elevation: num, slope: num });

/** Result-set handles so the model never has to copy long path lists. */
class Handles {
  private sets = new Map<string, string[]>();
  private n = 0;
  last: string[] = [];
  put(paths: string[]) {
    const id = `r${++this.n}`;
    this.sets.set(id, paths);
    if (this.sets.size > 40) this.sets.delete(this.sets.keys().next().value!);
    return id;
  }
  resolve(a: AnyObj): AnyObj {
    if (typeof a?.from !== "string") return a;
    if (a.from === "last") {
      if (!this.last.length) throw new FormaError("'last' is empty", "Create or edit something first, or use forma_find.");
      const { from, ...rest } = a;
      return { ...rest, paths: this.last };
    }
    const m = /^r\d+$/.test(a.from) ? this.sets.get(a.from) : undefined;
    if (/^r\d+$/.test(a.from) && !m) throw new FormaError(`unknown handle ${a.from}`, "Handles expire after 40 newer finds; re-run forma_find.");
    if (!m) return a;
    const { from, ...rest } = a;
    return { ...rest, paths: m };
  }
}

export function registerTools(server: McpServer, link: LinkManager) {
  const h = new Handles();

  // Safety lock: writes require the active proposal to match the configured name or ID.
  const onlyProposal = process.env.FORMA_MCP_ONLY_PROPOSAL?.trim();
  const matchesLock = (id: unknown, name: unknown) => id === onlyProposal || name === onlyProposal;
  const guard = async () => {
    if (!onlyProposal) return;
    const st = (await link.call("status", { modelOnly: true })) as AnyObj;
    const name = st?.model?.name;
    if (!matchesLock(st?.model?.id, name))
      throw new FormaError(
        `write blocked: active proposal is ${name ? `'${name}'` : "unknown"}, but writes are locked to '${onlyProposal}'`,
        `Use forma_site action:proposals to find the locked proposal by name or ID, then open it in Forma before making changes.`,
      );
  };

  // Panel-driven runs: risky steps wait for Approve/Reject in the Forma panel.
  const panelApproval = process.env.FORMA_MCP_APPROVAL === "panel";
  const approve = async (title: string, detail?: string) => {
    if (!panelApproval) return;
    const r = (await link.call("ui.approve", { title, detail }, { timeoutMs: 10 * 60000 })) as AnyObj;
    if (!r?.approved)
      throw new FormaError(`the user rejected: ${title}`, "Do not retry this step. Continue without it, or explain what you wanted to do and ask the user.");
  };

  const run = async (op: string, args: AnyObj, opts: { write?: boolean; timeoutMs?: number } = {}) => {
    if (opts.write || op === "create" || op === "edit") await guard();
    return link.call(op, args, opts) as Promise<AnyObj>;
  };

  const wrap = <A extends AnyObj>(fn: (a: A) => Promise<Out | string>) => async (a: A): Promise<Out> => {
    try {
      const r = await fn(a);
      return typeof r === "string" ? textResult(r) : r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const fix = e instanceof FormaError ? e.fix : undefined;
      const guidance = fix ? `\nfix: ${fix}` : message.includes("\nfix: ") ? "" : "\nfix: Check the current design with forma_status or forma_find before trying again.";
      return textResult(`error: ${message}${guidance}`, true);
    }
  };

  const ro = { readOnlyHint: true, openWorldHint: false };
  const setLast = (r: AnyObj) => {
    if (r.pathsVerified === false) h.last = [];
    else if (r.pathsVerified && r.paths?.length) h.last = r.paths;
  };

  server.registerTool("forma_status", {
    description: "Show the connected project, active design option, edit rights and element counts. Pass bridge:'b2' to select a Forma tab.",
    inputSchema: strictFields({ bridge: z.string().optional() }),
    annotations: ro,
  }, wrap(async (a) => {
    if (a.bridge) await link.select(a.bridge);
    const st = await run("status", {}); // waits briefly for a reconnecting panel; errors with a fix if none
    const ls = await link.status();
    const bridges = ls.bridges.map((b) => `${b.id}${b.active ? "*" : ""}${b.tab ? `[tab ${b.tab}]` : ""}${b.outdated ? "[OLD PANEL: reload tab]" : ""} ${b.project}`).join(", ");
    return [`link: ${ls.role} v${ls.version} ${ls.url} · forma: ${bridges} · codex sessions: ${ls.agents}`, kv(st), "units: m, m², degrees; XY = local project coords"].join("\n");
  }));

  server.registerTool("forma_find", {
    description: "Find elements by paths or category (e.g. building, site_limit, road). from accepts r# handles, last, selection or all. Filters combine. r# targets every match; page with offset. area is the footprint in m².",
    inputSchema: strictFields({
      ...target,
      name: z.string().optional().describe("name substring or building alias, e.g. Building A or A"),
      func: z.string().optional().describe("building function name or id"),
      inside: poly.optional().describe("polygon [[x,y],…]: only elements inside"),
      virtual: z.boolean().optional(),
      any: z.boolean().optional().describe("include uncategorised nodes"),
      fields: z.array(z.enum(["area", "height", "z", "bbox", "floors", "gfa"])).optional().describe("default [area,height]"),
      limit: z.number().int().min(1).max(500).optional().describe("default 100"),
      offset: z.number().int().min(0).optional(),
    }),
    annotations: ro,
  }, wrap(async (a) => {
    const args = h.resolve(a);
    if (args.from === "all") delete args.from;
    const r = await run("find", args, { timeoutMs: 60000 });
    const id = h.put(r.paths);
    const end = r.offset + r.rows.length;
    const page = r.total > r.rows.length ? ` (showing ${r.rows.length})` : "";
    const head = `${id}: ${r.total} match${r.total === 1 ? "" : "es"}${page}`;
    const more = end < r.total ? `\nmore: offset=${end}` : "";
    return `${head} — from:'${id}' targets all ${r.total}\n${table(r.cols, r.rows)}${more}`;
  }));

  server.registerTool("forma_read", {
    description: "Details for ≤50 elements: props, footprint points, bbox/height, floor levels [[z,m²]], transform, children.",
    inputSchema: strictFields({ ...target, what: z.array(z.enum(["props", "footprint", "bbox", "floors", "transform"])).optional().describe("default props,footprint,bbox,floors") }),
    annotations: ro,
  }, wrap(async (a) => {
    const r = (await run("read", h.resolve(a), { timeoutMs: 60000 })) as unknown as AnyObj[];
    return r.map((x) => JSON.stringify(x)).join("\n");
  }));

  server.registerTool("forma_metrics", {
    description: "Forma area metrics: GFA total and by function, site area, building coverage, FAR (GFA/site), unit count, parking. Whole proposal by default, or a subset.",
    inputSchema: strictFields(target),
    annotations: ro,
  }, wrap(async (a) => render(await run("metrics", h.resolve(a), { timeoutMs: 60000 }))));

  const rules = strictFields({
    maxHeight: z.number().optional().describe("m"), maxFloors: z.number().int().optional(), maxFar: z.number().optional(),
    maxCoverage: z.number().optional().describe("percent of site area"), minSetback: z.number().optional().describe("m from the site boundary"),
    minSpacing: z.number().optional().describe("m between buildings"),
  });

  server.registerTool("forma_check", {
    description: "Check planning limits on buildings inside the site boundary or targets from paths|from. show:true colours problems red and other checked buildings green (view only). Distances are metres, coverage is percent.",
    inputSchema: strictFields({ ...target, rules, show: z.boolean().optional() }),
    annotations: ro,
  }, wrap(async (a) => {
    const r = await run("check", h.resolve(a), { timeoutMs: 90000 });
    const head = r.ok ? `ALL RULES MET (${r.checked.join(", ")})` : `${r.violations.length} PROBLEM(S)`;
    const lines = (r.violations as AnyObj[]).map((v) => `- ${v.text}${v.path ? ` [${v.path}]` : ""}`);
    return [head, ...lines, `summary: ${kv(r.summary)}`, r.skipped?.length ? `not checked: ${r.skipped.join(", ")}` : "", r.missing_outline ? `${r.missing_outline} building(s) without a readable outline were skipped` : "", r.note ?? ""].filter(Boolean).join("\n");
  }));

  server.registerTool("forma_report", {
    description: "Save HTML and CSV design reports with site figures, per-building floor area by use and optional planning checks. Tell the user where the files were saved.",
    inputSchema: strictFields({ ...target, rules: rules.optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap(async (a) => {
    const r = await run("report", h.resolve(a), { timeoutMs: 90000 });
    const f = saveReport(r);
    const rulesLine = r.check ? `\nrules: ${r.check.ok ? "all met" : `${r.check.violations.length} problem(s)`}` : "";
    return `saved report for ${r.buildings?.length ?? 0} buildings\nhtml: ${f.html}\ncsv: ${f.csv}${rulesLine}`;
  }));

  server.registerTool("forma_create", {
    description: [
      "Create elements in one undoable batch. XY is in local metres. z defaults to the lowest terrain point under the footprint.",
      "items[].type:",
      "- building {polygon|rect:[x,y,w,d,rotDeg], floors, floorHeight=3, groundHeight?, func?, name?, tiers?:[{inset|polygon|rect, floors, floorHeight?, func?}]} (tiers = podium/tower/setbacks, bottom-up; inset metres from base)",
      "- mass {polygon|rect, height, category?} generic extrusion (e.g. category:'vegetation')",
      "- site_limit {polygon} · zone {polygon, category} · line {line:[[x,y],…], category} · mesh {verts, faces, category}",
      "preview:true = dry run returning floors/height/footprint/GFA. New paths become handle 'last'.",
    ].join("\n"),
    inputSchema: strictFields({
      items: z.array(item, {
        required_error: `Add the elements to create in items.\nfix: Try ${CREATE_EXAMPLE}`,
        invalid_type_error: `Items must be a list.\nfix: Try ${CREATE_EXAMPLE}`,
      }).min(1, `Add at least one item.\nfix: Try ${CREATE_EXAMPLE}`).max(200, "A call can create up to 200 items.\nfix: Split your items into batches of 200 or fewer."),
      preview: z.boolean().optional(),
      wait: z.boolean().optional().describe("wait until persisted (default true)"),
    }),
    annotations: { destructiveHint: false, openWorldHint: false },
  }, wrap(async (a) => {
    const r = await run("create", a, { write: !a.preview, timeoutMs: 90000 });
    setLast(r);
    const rows = (r.items as AnyObj[]).map((x) => [x.path ?? "", x.type, x.name ?? "", x.floors ?? "", x.height ?? "", x.footprint ?? x.area ?? "", x.gfa ?? "", x.z ?? ""]);
    const handle = r.pathsVerified && r.paths?.length ? " → handle 'last'" : "";
    const head = r.preview ? "preview (nothing written)" : r.saved
      ? `${r.saved}${handle ? "\nVisible elements: handle 'last'." : ""}`
      : `created ${r.created}${handle} · undo: forma_edit {undo:1}`;
    const unconfirmed = Boolean(r.saved);
    const pathColumn = unconfirmed ? "unverified path" : "path";
    const text = [head, table([pathColumn, "type", "name", "floors", "h_m", "foot_m2", "gfa_m2", "z"], rows),
      ...(r.warnings ?? []).map((warning: string) => `warning: ${warning}`), r.fix && `fix: ${r.fix}`].filter(Boolean).join("\n");
    return textResult(text, unconfirmed);
  }));

  server.registerTool("forma_edit", {
    description: [
      "Edit elements in ONE atomic, undoable batch. ops[]: {op, paths|from|category, …}",
      "- move {dx,dy,dz?,rotate?(deg about bbox centre or 'about':[x,y])} · copy {dx,dy,count?} (array copies)",
      "- remove · rename {name} · props {patch:{'office:info':{k:v}}} (namespace must be 'word:word'; JSON merge patch, null deletes)",
      "- floors {floors:N (new total) | add:±n} change a building's number of floors; keeps its outline, floor heights and uses. Use this for taller/lower buildings — never remove 'floor' children. Buildings made in Forma's Building Design tool cannot be changed here (tell the user to use that editor).",
      "Moved/renamed elements get NEW paths (returned, and set as 'last'). undo:n reverts the last n MCP writes. preview:true = dry run.",
    ].join("\n"),
    inputSchema: strictFields({
      ops: z.array(editOp).optional(),
      undo: z.number().int().min(1).max(50).optional(),
      preview: z.boolean().optional(),
      wait: z.boolean().optional(),
    }),
    annotations: { destructiveHint: true, openWorldHint: false },
  }, wrap(async (a) => {
    if (a.undo) {
      const r = await run("undo", { steps: a.undo }, { write: true, timeoutMs: 60000 });
      setLast(r);
      const { pathsVerified, ...result } = r;
      const unconfirmed = Boolean(result.saved);
      return textResult(renderWriteFields(result, unconfirmed), unconfirmed);
    }
    if (!a.ops?.length) throw new FormaError("Choose an edit to preview or apply, or undo a previous change", `Try ${EDIT_EXAMPLE}`);
    const handleCounts: string[] = [];
    const ops = a.ops.map((o, i) => {
      const resolved = h.resolve(o);
      if (o.from && resolved !== o) {
        const count = resolved.paths.length;
        handleCounts.push(`ops[${i}] from:'${o.from}' targets ${count} element${count === 1 ? "" : "s"}`);
      }
      return resolved;
    });
    const removals = ops.filter((o: AnyObj) => o.op === "remove");
    if (removals.length && !a.preview) {
      const n = removals.reduce((s: number, o: AnyObj) => s + (o.paths?.length ?? (o.path ? 1 : 0)), 0);
      await approve(n ? `Remove ${n} element${n === 1 ? "" : "s"} from the design` : "Remove elements from the design", "You can undo this afterwards.");
    }
    const r = await run("edit", { ...a, ops }, { write: !a.preview, timeoutMs: 90000 });
    setLast(r);
    const { pathsVerified, saved, fix, ...result } = r;
    const unconfirmed = Boolean(saved);
    const text = [saved, ...handleCounts, renderWriteFields(result, unconfirmed), fix && `fix: ${fix}`].filter(Boolean).join("\n");
    return textResult(text, unconfirmed);
  }));

  server.registerTool("forma_view", {
    description: [
      "Look at and style the 3D scene (visual only, nothing saved).",
      "action: capture {width=1024,height=640,format?,quality?,fit?:'iso'|'top'|{view,paths|from}} returns an image",
      "· fit {view:iso|top|north|south|east|west|ne|nw|se|sw, paths|from|category, zoom?} · camera {position:[x,y,z],target?} · perspective",
      "· color {paths|from, color:'#hex'} or {colors:{path:'#hex'}} · color_by {by:height|floors|area|gfa|func, min?,max?} · clear_colors",
      "· hide|show|isolate {paths|from|category} · show_all · sun {date?:ISO} · overlay {polygons?|lines?, z?} · clear_overlays",
    ].join("\n"),
    inputSchema: strictFields({
      action: z.enum(["capture", "fit", "camera", "perspective", "color", "color_by", "clear_colors", "hide", "show", "isolate", "show_all", "sun", "overlay", "clear_overlays"]),
      ...target,
      view: z.string().optional(), zoom: z.number().optional(), fit: fit.optional(),
      width: z.number().int().optional(), height: z.number().int().optional(), format: z.enum(["jpeg", "png"]).optional(), quality: z.number().optional(),
      position: z.array(z.number()).optional(), target: z.array(z.number()).optional(), ms: z.number().optional(),
      color: z.string().optional(), colors: z.record(z.string()).optional(), by: z.string().optional(), min: z.number().optional(), max: z.number().optional(),
      date: z.string().optional(), polygons: z.array(poly).optional(), lines: z.array(z.array(pt)).optional(), z: z.number().optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap(async (a) => {
    const args = h.resolve(a);
    if (args.fit && typeof args.fit === "object") args.fit = h.resolve(args.fit);
    const r = await run("view", args, { timeoutMs: 45000 });
    if (a.action === "capture") return { content: [{ type: "image", data: r.image, mimeType: r.mime }, { type: "text", text: `${r.width}x${r.height}` }] };
    return render(r);
  }));

  server.registerTool("forma_analysis", {
    description: "Poll result {id} after submitting sun or noise. Results summarise any shared grid with optional polygon, threshold and bins. sun_hours gives a quick current-scene calculation on open ground with an optional overlay. wind_params reports reference wind data.",
    inputSchema: strictFields({
      action: z.enum(["list", "sun", "noise", "result", "sun_hours", "sun_hours_hide", "wind_params"]),
      ...target,
      id: z.string().optional(), month: z.number().int().min(1).max(12).optional(), day: z.number().int().min(1).max(31).optional(),
      inside: poly.optional(), threshold: z.number().optional(), bins: z.number().int().min(2).max(20).optional(),
      types: z.array(z.string()).optional(), allProposals: z.boolean().optional(), limit: z.number().int().optional(),
      show: z.boolean().optional(), res: z.number().min(0.5).max(10).optional(),
    }),
    annotations: { openWorldHint: false },
  }, wrap(async (a) => render(await run("analysis", h.resolve(a), { write: a.action === "sun" || a.action === "noise", timeoutMs: 120000 }))));

  server.registerTool("forma_site", {
    description: "Project & site. action: info (CRS, lat/lon, terrain bbox, functions) · elevation {points:[[x,y],…]} · pads · add_pads {pads:[{polygon,z,slope?}], apply?} · functions · add_function {name,color?} · proposals (design options) · switch {id} · duplicate {id?} · delete_proposal {id, confirm:true only after user OK}",
    inputSchema: strictFields({
      action: z.enum(["info", "elevation", "pads", "add_pads", "functions", "add_function", "proposals", "switch", "duplicate", "delete_proposal"]).optional(),
      points: z.array(pt).optional(), pads: z.array(pad).optional(), apply: z.boolean().optional(),
      name: z.string().optional(), color: z.string().optional(), id: z.string().optional(), confirm: z.boolean().optional(), switch: z.boolean().optional(),
    }),
    annotations: { openWorldHint: false },
  }, wrap(async (a) => {
    const action = a.action ?? "";
    // switch/duplicate change no content; delete under the lock may only target the locked proposal.
    if (action === "delete_proposal") await approve("Delete a design option", "This cannot be undone.");
    if (onlyProposal && action === "delete_proposal") {
      const list = (await link.call("site", { action: "proposals" })) as AnyObj;
      const row = (list.rows as string[][]).find((r) => r[0] === a.id);
      if (!row || row[2] === "*" || !matchesLock(row[0], row[1]))
        throw new FormaError(`Deletion is locked to an inactive proposal matching '${onlyProposal}' by name or ID`,
          "Check the proposal ID with forma_site action:proposals. If the locked proposal is active, open a different proposal before deleting it.");
      return render(await link.call("site", a, { write: true, timeoutMs: 60000 }));
    }
    if (["switch", "duplicate"].includes(action)) return render(await link.call("site", a, { write: true, timeoutMs: 60000 }));
    const write = ["add_pads", "add_function"].includes(action);
    return render(await run("site", a, { write, timeoutMs: 60000 }));
  }));

  server.registerTool("forma_script", {
    description: "Escape hatch: run async JS inside Forma with (Forma, args, h) in scope; `return` a JSON-able value (typed arrays are summarised, output capped by maxChars). h.tree() = element tree Map, h.geom = helpers. Full SDK: Forma.elements/geometry/terrain/render/analysis/… (forma-embedded-view-sdk 0.96). Writes here are NOT in MCP undo.",
    inputSchema: strictFields({ code: z.string(), args: z.record(z.any()).optional(), maxChars: z.number().int().optional(), timeoutMs: z.number().int().max(120000).optional() }),
    annotations: { destructiveHint: true, openWorldHint: false },
  }, wrap(async (a) => {
    await approve("Run an advanced custom step", "The assistant wants to run its own script inside Forma. It is not covered by Undo.");
    const r = await run("script", a, { write: true, timeoutMs: a.timeoutMs ?? 30000 });
    return typeof r === "string" ? r : JSON.stringify(r);
  }));
}
