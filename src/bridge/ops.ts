// Ops executed inside the Forma iframe. Every op takes plain JSON args and returns
// plain JSON (no typed arrays), already trimmed for low token cost.
// Units: metres / m² / degrees, local project coordinates (Forma native).
import type { EmbeddedViewSdk } from "forma-embedded-view-sdk";
import { FormaError } from "../shared/protocol.js";
import {
  type P2, type M4, type Box, IDENTITY, area, cleanRing, centroid, rect, offset, mul, translation,
  rotationZ, bboxOfTriangles, mergeBoxes, extrude, pointInPoly, convexHull, baseOutline,
  selfIntersects, ringLocation, ringsOverlap, r1, r2,
} from "../shared/geom.js";
import { rasterMax, sunHours } from "../shared/sun.js";
import { stackFromInternal } from "../shared/floors.js";
import { checkRules, type RuleBuilding, type Rules } from "../shared/rules.js";

type F = EmbeddedViewSdk;
type AnyObj = Record<string, any>;

export type TreeNode = {
  path: string;
  urn: string;
  key: string;
  parent?: string;
  name?: string;
  cat?: string;
  func?: string;
  virtual?: boolean;
  transform?: number[];
  children: string[];
};

type UpdateOp =
  | { type: "add"; parentPath?: string; urn: string; name?: string; transform?: number[] }
  | { type: "replace"; path: string; urn: string; cur?: string }
  | { type: "remove"; path: string; urn?: string };

type UndoEntry = { label: string; at: number; inverse: UpdateOp[]; proposalId?: string };

const LIMIT_MAX = 500;
const SUN_TEX = "forma-mcp-sun-hours";
const CHECK_SAVE_FIX = "Use forma_find to check the current design before retrying.";
const STALE_SAVE_MESSAGE = "Forma isn't saving changes from this page.";
const STALE_SAVE_FIX = "Reload the Forma page (or open the design option directly), reopen the Forma MCP panel, then check with forma_find before retrying.";
const SAVE_READBACK_MS = 10_000;
const REGISTRATION_MS = 2 * 60_000;

/** 0..1 -> blue (little sun) .. yellow (most sun). */
function sunRamp(t: number): [number, number, number] {
  const s = Math.max(0, Math.min(1, t));
  const stops: [number, number, number][] = [[49, 54, 149], [69, 117, 180], [116, 173, 209], [254, 224, 144], [253, 174, 97], [255, 230, 0]];
  const f = s * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  return [0, 1, 2].map((k) => Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * u)) as [number, number, number];
}

export class Ops {
  private session: {
    kind?: "udm" | "proposal";
    tree?: { rootUrn: string; nodes: Map<string, TreeNode> };
    stale?: true;
  } = {};
  private funcs?: { id: string; name: string; color?: string }[];
  private undoStack: UndoEntry[] = [];
  private overlays: string[] = [];
  private submittedAnalyses = new Map<string, { type: "sun" | "noise"; at: number }>();

  constructor(private F: F) {}

  // ---------- dispatch ----------
  async run(op: string, args: AnyObj = {}): Promise<unknown> {
    return this.dispatch(op, args);
  }

  private async dispatch(op: string, args: AnyObj): Promise<unknown> {
    const [ns, action] = op.split(".");
    switch (ns) {
      case "status": return args.modelOnly ? { model: await this.activeModel() } : this.status();
      case "find": return this.find(args);
      case "read": return this.read(args);
      case "metrics": return this.metrics(args);
      case "check": return this.check(args);
      case "report": return this.report(args);
      case "create": return this.create(args);
      case "edit": return this.edit(args);
      case "undo": return this.undo(args);
      case "view": return this.view(args);
      case "analysis": return this.analysis(args);
      case "site": return this.site(args);
      case "script": return this.script(args);
      case "ping": return "pong";
      default:
        throw new FormaError(`unknown op '${op}'${action ? "" : ""}`, "Use one of the forma_* tools.");
    }
  }

  // ---------- session plumbing (UDM sessions + legacy proposal sessions) ----------
  resetSession() {
    this.session = {};
  }

  async sessionKind(): Promise<"udm" | "proposal"> {
    const session = this.session;
    return session.kind ??= await this.F.proposal.getId().then((id) => (id ? "proposal" : "udm"), () => "udm" as const);
  }

  private rootUrn() {
    return this.F.udm.getRootUrn().catch(() => this.F.proposal.getRootUrn());
  }

  /** One atomic batch of add/replace/remove, then wait until persisted so reads see it. */
  private async applyBatch(ops: UpdateOp[], wait = true) {
    this.requireWritablePage();
    const session = this.session;
    const results = await this.F.elements.batch({ operations: ops as any });
    const confirmed = wait && await withTimeout(this.F.udm.awaitPersisted(), 20000).then(() => true, () => false);
    // Other reads may have cached the proposal while the save was pending.
    session.tree = undefined;
    const readback = this.readTree(session, true);
    const nodes = await (wait && !confirmed ? withTimeout(readback, SAVE_READBACK_MS) : readback).catch(() => undefined);
    const unreadableSave = wait && !confirmed && !nodes;
    if (unreadableSave) session.stale = true;
    const issues = ops.flatMap((op, i) => {
      if (op.type === "add") {
        const path = results[i]?.path;
        if (!path) return ["Forma did not return a path for a new element."];
        return nodes?.has(path) ? [] : [`Could not find the new element at ${path}.`];
      }
      if (op.type === "replace" && nodes?.get(op.path)?.urn !== op.urn)
        return [`Could not find the new version of ${op.path}.`];
      if (op.type === "remove" && nodes?.has(op.path)) return [`The previous element is still visible at ${op.path}.`];
      return [];
    });
    const verified = !!nodes && !issues.length;
    if (!nodes) issues.unshift("The design could not be read back from Forma.");
    const saved = confirmed && verified ? undefined : [
      "Saved state unconfirmed (NOT CONFIRMED).",
      !confirmed ? (wait ? "Forma did not confirm saving within 20 seconds." : "The call did not wait for Forma to confirm saving.") : "",
      ...issues,
    ].filter(Boolean).join(" ");
    return { results, nodes, verified, saved, fix: unreadableSave ? STALE_SAVE_FIX : saved ? CHECK_SAVE_FIX : undefined };
  }

  private modelKey(): Promise<string> {
    return this.F.proposal.getId().catch(() => "udm");
  }

  // ---------- tree ----------
  async getTree(): Promise<Map<string, TreeNode>> {
    return this.readTree(this.session);
  }

  private async readTree(session: Ops["session"], fresh = false): Promise<Map<string, TreeNode>> {
    const wasStale = session.stale;
    const rootUrn = await this.rootUrn();
    const cached = session.tree;
    if (!fresh && !session.stale && cached && cached.rootUrn === rootUrn) return cached.nodes;
    const { elements } = await this.F.elements.get({ urn: rootUrn, recursive: true });
    if (!elements[rootUrn])
      throw new FormaError("Forma couldn't load this design", STALE_SAVE_FIX);
    const nodes = new Map<string, TreeNode>();
    const walk = (urn: string, path: string, key: string, parent?: string, name?: string, transform?: number[]) => {
      const el = elements[urn as keyof typeof elements] as AnyObj | undefined;
      const p = (el?.properties ?? {}) as AnyObj;
      const node: TreeNode = {
        path, urn, key, parent, name: name ?? p.name, cat: p.category, func: p.functionId,
        virtual: p.virtual || undefined, transform, children: [],
      };
      nodes.set(path, node);
      for (const c of (el?.children ?? []) as AnyObj[]) {
        const cp = `${path}/${c.key}`;
        node.children.push(cp);
        walk(c.urn, cp, c.key, path, c.name, c.transform);
      }
    };
    walk(rootUrn, "root", "root");
    // A read started before a save failure cannot clear the failure.
    if (wasStale === session.stale) {
      session.tree = { rootUrn, nodes };
      session.stale = undefined;
    }
    return nodes;
  }

  private async functions() {
    if (!this.funcs) this.funcs = (await this.F.settings.get()).buildingFunctions;
    return this.funcs;
  }

  private async funcId(f?: string): Promise<string | undefined> {
    if (!f) return undefined;
    const fs = await this.functions();
    const hit = fs.find((x) => x.id === f) ?? fs.find((x) => x.name.toLowerCase() === f.toLowerCase());
    if (!hit) throw new FormaError(`unknown building function '${f}'`, `Use one of: ${fs.map((x) => x.name).join(", ")} (or forma_site action:add_function).`);
    return hit.id;
  }

  private async funcName(id?: string) {
    if (!id) return undefined;
    return (await this.functions()).find((x) => x.id === id)?.name ?? id;
  }

  /** Resolve {paths|from|category} into concrete element paths. */
  private async targets(a: AnyObj, required = true): Promise<string[]> {
    let paths: string[] | undefined = a.paths ?? (a.path ? [a.path] : undefined);
    if (!paths && a.from === "selection") paths = await this.F.selection.getSelection();
    if (!paths && (a.category || a.from === "all")) {
      const nodes = await this.getTree();
      const cats = a.category ? [a.category].flat().map(normCat) : undefined;
      paths = [...nodes.values()].filter((n) => n.cat && n.path !== "root" && (!cats || cats.includes(n.cat))).map((n) => n.path);
    }
    if (required && (!paths || !paths.length))
      throw new FormaError("no target elements", a.from === "selection" ? "Select elements in Forma first, or pass paths / from:'r#'." : "Pass paths, from:'r#'|'selection'|'all', or category.");
    return paths ?? [];
  }

  private async requireEdit() {
    this.requireWritablePage();
    if (!(await this.editAccess())) throw new FormaError("no edit access to this project", "Ask the project owner for edit rights, or work on a duplicate you own.");
    await this.requireFresh();
  }

  editAccess(): Promise<boolean | undefined> {
    // The SDK exposes no page-level permission for legacy proposals. UDM list entries
    // have edit rights, but the SDK does not identify the active document in that list.
    return this.F.getCanEdit().catch(() => undefined);
  }

  private requireWritablePage() {
    if (this.session.stale) throw new FormaError(STALE_SAVE_MESSAGE, STALE_SAVE_FIX);
  }

  /**
   * Refuse to write from a window that shows an older version of the design (changed in another
   * window or by a colleague): Forma would not save on top of it (verified live).
   */
  private async requireFresh() {
    if ((await this.sessionKind()) !== "proposal") return;
    const [local, id, all] = await Promise.all([
      this.F.proposal.getRootUrn().catch(() => undefined),
      this.F.proposal.getId().catch(() => undefined),
      this.F.proposal.getAll().catch(() => undefined),
    ]);
    const rev = (u?: string) => Number(String(u ?? "").split(":")[5]);
    const saved = all?.find((p: AnyObj) => String(p.urn).split(":")[4] === id)?.urn;
    if (local && saved && rev(saved) > rev(local))
      throw new FormaError("this Forma window shows an older version of the design (it was changed in another window or by a colleague), so nothing was changed",
        "Tell the user: reload this Forma tab (F5), reopen the Forma MCP panel, then try again. Do not retry before that.");
  }

  // ---------- status ----------
  private async activeModel() {
    const { rows } = await this.listModels().catch(() => ({ rows: [] as string[][] }));
    const cur = rows.find((r) => r[2] === "*");
    return { id: cur?.[0], name: cur?.[1], count: rows.length };
  }

  async status() {
    const F = this.F;
    const [project, kind, canEdit, unitSystem, selection, nodes, model] = await Promise.all([
      F.project.get().catch(() => undefined),
      this.sessionKind(),
      this.editAccess(),
      F.getPresentationUnitSystem().catch(() => undefined),
      F.selection.getSelection().catch(() => [] as string[]),
      this.getTree(),
      this.activeModel(),
    ]);
    const counts: Record<string, number> = {};
    for (const n of nodes.values()) if (n.cat && n.path !== "root") counts[n.cat] = (counts[n.cat] ?? 0) + 1;
    return {
      project: { id: safe(() => F.getProjectId()), ...(project && { name: project.name, country: project.countryCode, srid: project.srid, refPoint: project.refPoint, tz: project.timezone }) },
      session: kind, model,
      canEdit, display: unitSystem, selection: selection.length, counts,
      undo: this.undoStack.length,
    };
  }

  // ---------- find ----------
  async find(a: AnyObj) {
    const nodes = await this.getTree();
    let list = [...nodes.values()].filter((n) => n.path !== "root");
    if (a.from === "selection") {
      const sel = new Set(await this.F.selection.getSelection());
      list = list.filter((n) => sel.has(n.path));
    } else if (a.paths) {
      const ps = new Set<string>(a.paths);
      list = list.filter((n) => ps.has(n.path));
    } else if (!a.any) list = list.filter((n) => n.cat);
    if (a.category) {
      const cats = [a.category].flat().map(normCat);
      list = list.filter((n) => n.cat && cats.includes(n.cat));
    }
    const aliases = a.name || list.some((n) => n.cat === "building")
      ? (await this.siteBuildingScope(nodes)).aliases
      : new Map<string, string>();
    if (a.name) {
      const q = String(a.name).trim().toLowerCase();
      const alias = /^(?:building\s+)?([a-z]|\d{2,})(?:\s+\([\d.]+\s*m\))?$/.exec(q);
      const match = alias && [...aliases].find(([, label]) => label.toLowerCase() === `building ${alias[1]}`);
      list = list.filter((n) => match ? n.path === match[0] : n.name?.toLowerCase().includes(q));
    }
    if (a.func) {
      const id = await this.funcId(a.func);
      list = list.filter((n) => n.func === id);
    }
    if (a.virtual !== undefined) list = list.filter((n) => !!n.virtual === !!a.virtual);
    if (a.inside) {
      // Forma only matches against a CLOSED ring (first point repeated) — an open ring silently returns nothing.
      const ring = cleanRing(a.inside);
      const inside = new Set(await this.F.geometry.getPathsInsidePolygons({ polygons: [[...ring, ring[0]]] }));
      list = list.filter((n) => inside.has(n.path));
    }
    const total = list.length;
    const offset0 = Math.max(0, a.offset ?? 0);
    const limit = Math.min(a.limit ?? 100, LIMIT_MAX);
    const page = list.slice(offset0, offset0 + limit);
    const fields: string[] = a.fields ?? ["area", "height"];
    const cols = ["path", "cat", "name", "func", ...fields, "alias"];
    const rows = await pool(page, 12, async (n) => {
      const m = await this.measure(n, fields);
      return [n.path, n.cat ?? "", n.name ?? "", (await this.funcName(n.func)) ?? "", ...fields.map((f) => m[f] ?? ""), aliases.get(n.path) ?? ""];
    });
    return { total, offset: offset0, cols, rows, paths: list.map((n) => n.path) };
  }

  /** Cheap per-element measurements, computed only for requested fields. */
  private async measure(n: TreeNode, fields: string[]): Promise<AnyObj> {
    const out: AnyObj = {};
    const F = this.F;
    const want = (f: string) => fields.includes(f);
    const jobs: Promise<void>[] = [];
    if (want("area")) jobs.push(this.footprint(n.path).then((fp) => {
      if (fp?.type === "Polygon" && fp.coordinates.length > 2) out.area = r1(area(fp.coordinates as P2[]));
    }).catch(() => {}));
    if (want("height") || want("bbox") || want("z")) jobs.push(F.geometry.getTriangles({ path: n.path }).then((t) => {
      const b = bboxOfTriangles(t);
      if (!b) return;
      out.height = r2(b.max[2] - b.min[2]);
      out.z = r2(b.min[2]);
      out.bbox = [b.min.map(r1), b.max.map(r1)];
    }).catch(() => {}));
    if (want("floors") || want("gfa")) jobs.push(F.elements.representations.grossFloorAreaPolygons({ urn: n.urn as any }).then((rep) => {
      if (!rep?.data?.length) return;
      const elevs = new Set(rep.data.map((g: AnyObj) => r2(g.elevation)));
      out.floors = elevs.size;
      out.gfa = r1(rep.data.reduce((s: number, g: AnyObj) => s + multiRingArea(g.grossFloorPolygon), 0));
    }).catch(() => {}));
    await Promise.all(jobs);
    // Native Forma buildings carry "floor" children instead of GFA polygons.
    if ((want("floors")) && out.floors === undefined && n.cat === "building") {
      const nodes = this.session.tree?.nodes;
      const fl = n.children.filter((c) => nodes?.get(c)?.cat === "floor").length;
      if (fl) out.floors = fl;
    }
    // Fall back to Forma's own area metrics for this one element (matches Forma's UI).
    if ((want("gfa") && out.gfa === undefined) || (want("area") && out.area === undefined && n.cat === "building") || want("use")) {
      const m = await F.areaMetrics.calculate({ paths: [n.path] }).catch(() => undefined);
      if (m) {
        const fb = m.builtInMetrics.grossFloorArea.functionBreakdown;
        const g = fb.reduce((s, f) => s + (typeof f.value === "number" ? f.value : 0), 0);
        if (want("use")) {
          // main use = the function with the most floor area; "mixed" names the top two
          const uses = fb.filter((f) => typeof f.value === "number" && f.value > 0).sort((a, b) => (b.value as number) - (a.value as number));
          const nm = (f: AnyObj) => f.functionName || (f.functionId === "unspecified" ? "Unspecified" : f.functionId);
          if (uses.length) out.use = uses.length > 1 && (uses[1].value as number) > 0.2 * g ? `${nm(uses[0])} + ${nm(uses[1])}` : nm(uses[0]);
          out.uses = uses.map((f) => `${nm(f)} ${f.value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} m²`).join(" · ");
        }
        if (want("gfa") && out.gfa === undefined && g > 0) out.gfa = r1(g);
        const cov = m.builtInMetrics.buildingCoverage.value;
        if (want("area") && out.area === undefined && typeof cov === "number" && cov > 0) out.area = r1(cov);
      }
    }
    return out;
  }

  /** Footprint at a path, or on its first child (Forma wraps inline GeoJSON in a child element). */
  private async footprint(path: string): Promise<{ type: "Polygon" | "LineString"; coordinates: [number, number][]; derived?: "outline" } | undefined> {
    const get = (p: string) => this.F.geometry.getFootprint({ path: p }).catch(() => undefined);
    const fp = await get(path);
    if (fp) return fp;
    const node = (await this.getTree()).get(path);
    // Forma wraps inline GeoJSON in a child; native buildings keep geometry on "floor" children.
    for (const kid of node?.children ?? []) {
      const k = await get(kid);
      if (k) return k;
    }
    // Native Forma buildings often expose no footprint at all (verified live): trace the exact
    // outline of the mesh's base faces; fall back to the convex hull of the lowest vertices.
    if (node?.cat !== "building") return undefined;
    const t = await this.F.geometry.getTriangles({ path }).catch(() => undefined);
    if (!t || t.length < 9) return undefined;
    const exact = baseOutline(t);
    if (exact) return { type: "Polygon", coordinates: exact.map(([x, y]) => [r2(x), r2(y)] as [number, number]), derived: "outline" };
    let zmin = Infinity;
    for (let i = 2; i < t.length; i += 3) if (t[i] < zmin) zmin = t[i];
    const base: P2[] = [];
    for (let i = 0; i < t.length; i += 3) if (t[i + 2] - zmin < 0.05) base.push([t[i], t[i + 1]]);
    const hull = convexHull(base);
    return hull.length >= 3 ? { type: "Polygon", coordinates: hull.map(([x, y]) => [r2(x), r2(y)] as [number, number]), derived: "outline" } : undefined;
  }

  // ---------- read ----------
  async read(a: AnyObj) {
    const paths = await this.targets(a);
    if (paths.length > 50) throw new FormaError(`${paths.length} paths; read takes ≤50`, "Use forma_find for many elements, or read a smaller page.");
    const what: string[] = a.what ?? ["props", "footprint", "bbox", "floors"];
    const nodes = await this.getTree();
    return pool(paths, 8, async (path) => {
      const n = nodes.get(path);
      if (!n) return { path, error: "not found (paths change after edits; re-run forma_find)" };
      const out: AnyObj = { path, urn: short(n.urn), cat: n.cat, name: n.name, func: await this.funcName(n.func) };
      if (n.children.length) out.children = n.children.length;
      if (what.includes("transform") && n.transform && !isIdentity(n.transform)) out.transform = n.transform.map(r2);
      const jobs: Promise<void>[] = [];
      if (what.includes("props")) jobs.push(this.F.elements.get({ urn: n.urn as any }).then(({ element }) => {
        const { geometry, ...props } = (element.properties ?? {}) as AnyObj;
        out.props = trimJson(props, 1500);
        if (element.representations) out.reps = Object.keys(element.representations);
      }).catch(() => {}));
      if (what.includes("footprint")) jobs.push(this.footprint(path).then((fp) => {
        if (!fp) return;
        out.footprint = { type: fp.type, pts: fp.coordinates.map((p) => [r2(p[0]), r2(p[1])]), ...((fp as AnyObj).derived ? { note: "traced from the 3D shape" } : {}) };
        if (fp.type === "Polygon") out.area = r1(area(fp.coordinates as P2[]));
      }).catch(() => {}));
      const m = await this.measure(n, what.filter((w) => ["bbox", "floors"].includes(w)).flatMap((w) => (w === "bbox" ? ["bbox", "height"] : ["floors", "gfa"])));
      Object.assign(out, m);
      if (what.includes("floors")) jobs.push(this.F.elements.representations.grossFloorAreaPolygons({ urn: n.urn as any }).then((rep) => {
        if (!rep?.data?.length) return;
        const by = new Map<number, { a: number; t: Set<string> }>();
        for (const g of rep.data as AnyObj[]) {
          const k = r2(g.elevation), e = by.get(k) ?? { a: 0, t: new Set() };
          e.a += multiRingArea(g.grossFloorPolygon);
          if (g.areaType) e.t.add(g.areaType);
          by.set(k, e);
        }
        out.levels = [...by.entries()].sort((x, y) => x[0] - y[0]).map(([z, e]) => [z, r1(e.a)]);
      }).catch(() => {}));
      await Promise.all(jobs);
      return out;
    });
  }

  // ---------- planning rules + report (Forma has neither for the user's own limits) ----------
  private async siteBuildingScope(nodes: Map<string, TreeNode>) {
    const siteNode = [...nodes.values()].find((n) => n.cat === "site_limit");
    const sfp = siteNode ? await this.footprint(siteNode.path).catch(() => undefined) : undefined;
    const site = sfp?.type === "Polygon" && sfp.coordinates.length > 2 ? cleanRing(sfp.coordinates as P2[]) : undefined;
    const all = [...nodes.values()].filter((n) => n.cat === "building");
    const inside = site && await this.F.geometry.getPathsInsidePolygons({ polygons: [[...site, site[0]]] })
      .then((paths) => new Set(paths), () => new Set<string>());
    const buildings = inside ? all.filter((n) => inside.has(n.path)) : all;
    return { site, paths: buildings.map((n) => n.path), aliases: buildingAliases(buildings) };
  }

  /** Buildings counted on the site: those inside the site boundary, or a given subset. */
  private async siteBuildings(a: AnyObj): Promise<{ site?: P2[]; buildings: RuleBuilding[]; gfa: AnyObj[] }> {
    const nodes = await this.getTree();
    const scope = await this.siteBuildingScope(nodes);
    const paths = a.paths || a.from || a.category
      ? (await this.targets(a)).filter((p) => nodes.get(p)?.cat === "building")
      : scope.paths;
    const rows = await pool(paths, 8, async (path) => {
      const n = nodes.get(path)!;
      const [fp, m] = await Promise.all([this.footprint(path).catch(() => undefined), this.measure(n, ["height", "floors", "gfa", "use"])]);
      const ring = fp?.type === "Polygon" && fp.coordinates.length > 2 ? cleanRing(fp.coordinates as P2[]) : undefined;
      return { path, name: n.name, uses: m.uses, func: (await this.funcName(n.func)) ?? (m.use as string | undefined), ring, height: m.height as number | undefined, floors: m.floors as number | undefined, gfa: m.gfa as number | undefined };
    });
    labelBuildings(rows, scope.aliases);
    return {
      site: scope.site,
      buildings: rows.filter((r) => r.ring).map((r) => ({ path: r.path, name: r.name, ring: r.ring!, height: r.height, floors: r.floors })),
      gfa: rows.map((r) => ({ path: r.path, name: r.name ?? "", use: r.func ?? "", uses: r.uses ?? "", floors: r.floors ?? "", height_m: r.height ?? "", footprint_m2: r.ring ? r1(area(r.ring)) : "", gfa_m2: r.gfa ?? "" })),
    };
  }

  /** check {rules:{maxHeight,maxFloors,maxFar,maxCoverage,minSetback,minSpacing}, show?} */
  async check(a: AnyObj) {
    const rules = (a.rules ?? {}) as Rules;
    const keys = ["maxHeight", "maxFloors", "maxFar", "maxCoverage", "minSetback", "minSpacing"] as const;
    if (!keys.some((k) => typeof rules[k] === "number"))
      throw new FormaError("no rules given", "Pass rules:{maxHeight?, maxFloors?, maxFar?, maxCoverage? (percent), minSetback?, minSpacing?} in metres.");
    const [sb, m] = await Promise.all([this.siteBuildings(a), this.metrics({})]);
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const scoped = !!(a.paths || a.from || a.category);
    let footprint = num(m.footprint_m2);
    if (scoped && rules.maxCoverage !== undefined && footprint === undefined && num(m.site_area_m2)) {
      const full = await this.siteBuildings({});
      footprint = full.buildings.reduce((sum, b) => sum + area(b.ring), 0);
    }
    const r = checkRules({ site: sb.site, siteArea: num(m.site_area_m2), gfa: num(m.gfa_m2), footprint, buildings: sb.buildings }, rules);
    if (a.show) {
      const colors = new Map<string, string>();
      for (const b of sb.buildings) colors.set(b.path, "#2e9e5b");
      for (const v of r.violations) { if (v.path) colors.set(v.path, "#d93025"); if (v.other) colors.set(v.other, "#d93025"); }
      if (colors.size) await this.F.render.elementColors.set({ pathsToColor: colors }).catch(() => {});
    }
    const note = [
      scoped && (rules.maxFar !== undefined || rules.maxCoverage !== undefined)
        ? "FAR and coverage are site-wide figures. Building counts and other checks use the selected buildings." : "",
      a.show ? "Buildings that break a rule are red, the others green (view only, clear with forma_view action:clear_colors)." : "",
    ].filter(Boolean).join(" ");
    return { ...r, note: note || undefined, missing_outline: sb.gfa.length - sb.buildings.length || undefined };
  }

  /** report {rules?} — per-building table + totals (+ rule check) for a saved design report. */
  async report(a: AnyObj) {
    const [sb, m, st] = await Promise.all([this.siteBuildings(a), this.metrics({}), this.status()]);
    const out: AnyObj = { project: (st as AnyObj)?.project?.name, design_option: (st as AnyObj)?.model?.name, totals: m, buildings: sb.gfa };
    if (a.rules && Object.keys(a.rules).length) {
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      out.rules = a.rules;
      out.check = checkRules({ site: sb.site, siteArea: num(m.site_area_m2), gfa: num(m.gfa_m2), footprint: num(m.footprint_m2), buildings: sb.buildings }, a.rules);
    }
    return out;
  }

  // ---------- metrics ----------
  async metrics(a: AnyObj) {
    const paths = a.paths || a.from || a.category ? await this.targets(a) : undefined;
    const m = await this.F.areaMetrics.calculate({ paths });
    // Site figures (GFA, FAR, coverage) count only buildings INSIDE the site boundary, like Forma's
    // own BTA/BYA; neighbouring context buildings are excluded. Whole-model totals are kept separately.
    let inSite: Awaited<ReturnType<F["areaMetrics"]["calculate"]>> | undefined;
    let noneInSite = false;
    if (!paths) {
      const sites = [...(await this.getTree()).values()].filter((n) => n.cat === "site_limit");
      const fp = sites[0] ? await this.footprint(sites[0].path) : undefined;
      if (fp?.type === "Polygon" && fp.coordinates.length > 2) {
        const ring = cleanRing(fp.coordinates as P2[]);
        const nodes = await this.getTree();
        const inside = (await this.F.geometry.getPathsInsidePolygons({ polygons: [[...ring, ring[0]]] }).catch(() => [] as string[]))
          .filter((p) => nodes.get(p)?.cat === "building");
        if (inside.length) inSite = await this.F.areaMetrics.calculate({ paths: inside }).catch(() => undefined);
        else noneInSite = true;
      }
    }
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const sumGfa = (mm: typeof m) => {
      const by: Record<string, number> = {};
      let t = 0;
      for (const f of mm.builtInMetrics.grossFloorArea.functionBreakdown) {
        const v = num(f.value);
        if (v === undefined) continue;
        by[f.functionName || f.functionId] = r1((by[f.functionName || f.functionId] ?? 0) + v);
        t += v;
      }
      return { t, by };
    };
    const all = sumGfa(m);
    const use = inSite ? sumGfa(inSite) : noneInSite ? { t: 0, by: {} } : all;
    const gfa = use.t, byFunc = use.by;
    const site = num(m.builtInMetrics.siteArea.value);
    const cov = num((inSite ?? m).builtInMetrics.buildingCoverage.value) ?? (noneInSite ? 0 : undefined);
    const custom = m.customMetrics.map((c) => [c.name, r1(c.functionBreakdown.reduce((s, f) => s + (num(f.value) ?? 0), 0)), c.unitOfMeasurement ?? ""]);
    return {
      scope: paths ? `${paths.length} elements` : inSite || noneInSite ? "buildings inside the site boundary" : "proposal",
      gfa_m2: r1(gfa), gfa_by_function: byFunc,
      ...(inSite || noneInSite ? { gfa_all_buildings_m2: r1(all.t) } : {}),
      site_area_m2: site !== undefined ? r1(site) : "n/a (no site limit)",
      // Forma reports building coverage as a footprint area (m²), verified on a live project.
      footprint_m2: cov !== undefined ? r1(cov) : "n/a",
      coverage: site && cov !== undefined ? `${Math.round((cov / site) * 100)}%` : "n/a",
      far: site ? r2(gfa / site) : "n/a",
      units: num((inSite ?? m).unitStatistics.count.value) ?? "n/a",
      parking: { spots: m.parkingStatistics.spots, area_m2: r1(m.parkingStatistics.area) },
      ...(custom.length ? { custom } : {}),
    };
  }

  // ---------- create ----------
  async create(a: AnyObj) {
    const items: AnyObj[] = a.items ?? [];
    if (!items.length) throw new FormaError("items is empty", "Pass items:[{type:'building', polygon:[[x,y],...], floors:6}].");
    if (items.length > 200) throw new FormaError("max 200 items per call", "Split into several calls.");
    const plans = await Promise.all(items.map((it, i) => this.planItem(it, i)));
    if (!a.preview) await this.requireEdit();
    const warnings = await this.placementWarnings(plans);
    if (a.preview) return { preview: true, warnings, items: plans.map((p) => p.summary) };

    // 1) create element revisions (batched per kind)
    const urns: string[] = new Array(plans.length);
    const bIdx = plans.map((p, i) => (p.floorStack ? i : -1)).filter((i) => i >= 0);
    if (bIdx.length) {
      const { urns: made } = await this.F.elements.floorStack.createFromFloorsBatch(bIdx.map((i) => plans[i].floorStack!));
      bIdx.forEach((i, k) => (urns[i] = made[k]));
    }
    await pool(plans.map((p, i) => [p, i] as const).filter(([p]) => p.hierarchy), 6, async ([p, i]) => {
      urns[i] = (await this.F.integrateElements.createElementHierarchy({ data: p.hierarchy! as any })).urn;
    });

    // 2) add all to the proposal in one batch
    const ops: UpdateOp[] = plans.map((p, i) => ({ type: "add", urn: urns[i], name: p.name, transform: p.transform, parentPath: items[i].parent }));
    const { results, nodes, verified, saved, fix } = await this.applyBatch(ops, a.wait !== false);
    const paths = results.flatMap((r) => r?.path ? [r.path] : []);
    if (verified) await this.pushUndo(`create ${paths.length}`, paths.map((path, i) => ({ type: "remove", path, urn: urns[i] })));
    const summaries = await pool(plans, 8, async (p, i) => {
      const path = results[i]?.path;
      const node = path ? nodes?.get(path) : undefined;
      if (p.floorStack) {
        const measured = node ? await this.measure(node, ["area"]) : {};
        p.summary.footprint = measured.area;
      }
      return { path, ...p.summary };
    });
    return { created: paths.length, paths, pathsVerified: verified, saved, fix, warnings, items: summaries };
  }

  private async placementWarnings(plans: { name?: string; ring?: P2[] }[]): Promise<string[]> {
    if (!plans.some((p) => p.ring)) return [];
    const nodes = [...(await this.getTree()).values()];
    const buildings = nodes.filter((n) => n.cat === "building");
    const site = nodes.find((n) => n.cat === "site_limit");
    const outline = async (path: string) => {
      const fp = await this.footprint(path).catch(() => undefined);
      return fp?.type === "Polygon" ? safe(() => cleanRing(fp.coordinates)) : undefined;
    };
    const [boundary, existing] = await Promise.all([
      site ? outline(site.path) : undefined,
      pool(buildings, 8, async (b) => ({ name: b.name || b.path, path: b.path, ring: await outline(b.path) })),
    ]);
    return plans.flatMap(({ name, ring }, i) => {
      if (!ring) return [];
      const label = `items[${i}]${name ? ` "${name}"` : ""}`;
      const warnings: string[] = [];
      if (boundary && ringLocation(ring, boundary).outside) {
        const where = ringsOverlap(ring, boundary) ? "partly outside" : "fully outside";
        warnings.push(`${label} is ${where} the site boundary.`);
      }
      for (const b of existing) {
        if (b.ring && ringsOverlap(ring, b.ring)) {
          warnings.push(`${label} overlaps ${b.name}${b.name === b.path ? "" : ` (${b.path})`}.`);
        }
      }
      return warnings;
    });
  }

  private async planItem(it: AnyObj, i: number) {
    const type = it.type ?? "building";
    const name = it.name;
    const summary: AnyObj = { i, type, name };
    if (type === "building") {
      const tiers: AnyObj[] = it.tiers ?? [{ polygon: it.polygon, rect: it.rect, floors: it.floors, floorHeight: it.floorHeight, heights: it.heights, func: it.func }];
      if (!tiers.length) throw new FormaError(`items[${i}] has no tiers`, "Add a tier with at least one floor or omit tiers for a single block.");
      const base = ringOf(tiers[0].polygon ?? it.polygon, tiers[0].rect ?? it.rect, `items[${i}]`);
      const floors: AnyObj[] = [];
      const planDefs: AnyObj[] = [];
      const anyFunc = tiers.some((t) => t.func ?? it.func);
      let h = 0, gfa = 0, footprint = base;
      for (const [ti, t] of tiers.entries()) {
        const where = it.tiers ? `items[${i}].tiers[${ti}]` : `items[${i}]`;
        const ring = t.inset !== undefined ? ringOf(offset(base, t.inset), undefined, where) : t.polygon || t.rect ? ringOf(t.polygon, t.rect, where) : base;
        if (ti === 0) footprint = ring;
        const heights: number[] = t.heights ?? Array.from({ length: t.floors ?? it.floors ?? 1 }, (_, k) => (ti === 0 && k === 0 && it.groundHeight ? it.groundHeight : t.floorHeight ?? it.floorHeight ?? 3));
        if (!heights.length || heights.some((x) => !(x > 0 && x < 50))) throw new FormaError(`items[${i}] floor heights must be 0–50 m`, "Use floorHeight like 3.0 and floors ≥ 1.");
        const fid = await this.funcId(t.func ?? it.func);
        if (anyFunc) {
          const pid = `p${ti}`;
          planDefs.push({
            id: pid,
            vertices: ring.map(([x, y], k) => ({ id: `${pid}v${k}`, x, y })),
            units: [{ polygon: ring.map((_, k) => `${pid}v${k}`), holes: [], ...(fid ? { functionId: fid } : {}) }],
          });
          for (const fh of heights) floors.push({ planId: pid, height: fh });
        } else for (const fh of heights) floors.push({ polygon: ring, height: fh });
        h += heights.reduce((s, x) => s + x, 0);
        gfa += area(ring) * heights.length;
      }
      const z = await this.baseZ(it.z, base);
      Object.assign(summary, { floors: floors.length, height: r2(h), footprint: r1(area(footprint)), gfa: r1(gfa), z: r2(z) });
      return { name, summary, ring: footprint, transform: z ? translation(0, 0, z) : undefined, floorStack: { floors, ...(planDefs.length ? { plans: planDefs } : {}) } as any };
    }
    const category = type === "site_limit" ? "site_limit" : it.category;
    const props: AnyObj = { ...(it.props ?? {}), ...(category ? { category } : {}), ...(name ? { name } : {}), ...(it.virtual ? { virtual: true } : {}) };
    if (type === "site_limit" || type === "zone" || type === "geojson" || type === "line") {
      const line = it.line ?? it.polygon;
      if (type === "line" && (!Array.isArray(line) || line.length < 2))
        throw new FormaError(`items[${i}] needs at least two points for a line`, "For example, pass line:[[0,0],[10,0]].");
      const geom = type === "line"
        ? { type: "LineString", coordinates: line.map((p: P2) => [+p[0], +p[1]]) }
        : (() => { const r = ringOf(it.polygon, it.rect, `items[${i}]`); return { type: "Polygon", coordinates: [[...r, r[0]]] }; })();
      props.geometry = { type: "Inline", format: "GeoJSON", geoJson: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: geom }] } };
      if (geom.type === "Polygon") summary.area = r1(area(geom.coordinates[0] as P2[]));
      return { name, summary, hierarchy: hier(props) };
    }
    if (type === "mass" || type === "mesh") {
      let mesh: { verts: number[]; faces: number[] };
      let z = 0;
      let footprint: P2[] | undefined;
      if (type === "mesh") {
        mesh = { verts: it.verts, faces: it.faces };
        if (!mesh.verts?.length || mesh.verts.length % 3 || !mesh.faces?.length || mesh.faces.length % 3) throw new FormaError(`items[${i}] verts/faces must be flat xyz / triangle-index lists`, "verts:[x,y,z,...], faces:[a,b,c,...].");
      } else {
        const ring = footprint = ringOf(it.polygon, it.rect, `items[${i}]`);
        if (!(it.height > 0)) throw new FormaError(`items[${i}] mass needs a positive height`, "Pass height in metres, for example height:3.");
        z = await this.baseZ(it.z, ring);
        mesh = extrude(ring, 0, it.height);
        Object.assign(summary, { height: it.height, footprint: r1(area(ring)), z: r2(z) });
      }
      props.geometry = { type: "Inline", format: "Mesh", verts: mesh.verts, faces: mesh.faces, ...(it.doubleSided ? { doubleSided: true } : {}) };
      return { name, summary, ring: footprint, transform: z ? translation(0, 0, z) : undefined, hierarchy: hier(props) };
    }
    throw new FormaError(`items[${i}] unknown type '${type}'`, "type: building | mass | site_limit | zone | line | mesh");
  }

  /** z: number = absolute; "terrain"/undefined = lowest terrain point under the ring; 0 allowed. */
  private async baseZ(z: unknown, ring: P2[]): Promise<number> {
    if (typeof z === "number") return z;
    const pts = [...ring, centroid(ring)];
    const zs = await Promise.all(pts.map(([x, y]) => this.F.terrain.getElevationAt({ x, y }).catch(() => NaN)));
    const ok = zs.filter((v) => Number.isFinite(v));
    return ok.length ? Math.min(...ok) : 0;
  }

  // ---------- edit ----------
  async edit(a: AnyObj) {
    const list: AnyObj[] = a.ops ?? [];
    if (!list.length) throw new FormaError("ops is empty", "Pass ops:[{op:'move', paths:[...], dx:5}].");
    if (!a.preview) await this.requireEdit();
    const nodes = await this.getTree();
    const updates: UpdateOp[] = [];
    const inverse: UpdateOp[] = [];
    const notes: AnyObj[] = [];
    const touched = new Set<string>();
    const floorChecks: { p?: string; addIndex?: number; expect: number }[] = [];
    const node = (p: string) => {
      const n = nodes.get(p);
      if (!n || p === "root") throw new FormaError(`element '${p}' not found`, "Paths change after every edit; re-run forma_find or use from:'last'.");
      if (touched.has(p)) throw new FormaError(`'${p}' used by two ops in one call`, "Combine them (move takes dx,dy,dz and rotate together) or use two calls.");
      touched.add(p);
      return n;
    };
    for (const [k, o] of list.entries()) {
      const paths = await this.targets(o);
      switch (o.op) {
        case "move":
        case "copy": {
          let pivot: P2 | undefined = o.about;
          if (o.rotate && !pivot) {
            const boxes = await Promise.all(paths.map((p) => this.F.geometry.getTriangles({ path: p }).then(bboxOfTriangles)));
            const b = mergeBoxes(boxes);
            pivot = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0];
          }
          const count = o.op === "copy" ? Math.max(1, Math.min(o.count ?? 1, 100)) : 1;
          for (const p of paths) {
            const n = o.op === "move" ? node(p) : nodes.get(p);
            if (!n) throw new FormaError(`element '${p}' not found`, "Re-run forma_find.");
            for (let c = 1; c <= count; c++) {
              const s = o.op === "copy" ? c : 1;
              let m: M4 = translation((o.dx ?? 0) * s, (o.dy ?? 0) * s, (o.dz ?? 0) * s);
              if (o.rotate) m = mul(m, rotationZ(o.rotate * s, pivot![0], pivot![1]));
              const t = mul(m, n.transform ?? IDENTITY).map((v) => Math.abs(v) < 1e-12 ? 0 : v);
              if (o.op === "move") {
                updates.push({ type: "remove", path: p });
                inverse.unshift({ type: "add", parentPath: n.parent, urn: n.urn, name: n.name, transform: n.transform });
              }
              updates.push({ type: "add", parentPath: n.parent, urn: n.urn, name: o.op === "copy" && n.name ? `${n.name} ${c}` : n.name, transform: t });
            }
          }
          notes.push({ k, op: o.op, n: paths.length * count });
          break;
        }
        case "remove":
          for (const p of paths) {
            const n = node(p);
            updates.push({ type: "remove", path: p });
            inverse.unshift({ type: "add", parentPath: n.parent, urn: n.urn, name: n.name, transform: n.transform });
          }
          notes.push({ k, op: "remove", n: paths.length });
          break;
        case "rename": {
          if (!o.name) throw new FormaError(`ops[${k}] needs a name for the building`, 'Pass name:"New name" with the rename operation.');
          for (const p of paths) {
            const n = node(p);
            updates.push({ type: "remove", path: p }, { type: "add", parentPath: n.parent, urn: n.urn, name: o.name, transform: n.transform });
            inverse.unshift({ type: "add", parentPath: n.parent, urn: n.urn, name: n.name, transform: n.transform });
          }
          notes.push({ k, op: "rename", n: paths.length });
          break;
        }
        case "props": {
          if (!o.patch || typeof o.patch !== "object") throw new FormaError(`ops[${k}] props needs patch`, "patch:{'my:namespace':{key:value}} (JSON merge patch; null deletes).");
          const badNs = Object.keys(o.patch).filter((ns) => !/^\w{1,20}:\w{1,50}$/.test(ns));
          if (badNs.length) throw new FormaError(`ops[${k}] property group '${badNs[0]}' must look like 'office:tags'`, "Forma stores custom properties under a namespace 'word:word', e.g. patch:{'office:info':{status:'approved'}}.");
          if (a.preview) { notes.push({ k, op: "props", n: paths.length }); break; }
          const made = await pool(paths, 6, async (p) => {
            const n = node(p);
            const { urn } = await this.F.elements.editProperties({ urn: n.urn as any, propertiesJsonMergePatch: o.patch });
            return { p, urn, old: n.urn };
          });
          for (const m of made) {
            updates.push({ type: "replace", path: m.p, urn: m.urn });
            inverse.unshift({ type: "replace", path: m.p, urn: m.old, cur: m.urn });
          }
          notes.push({ k, op: "props", n: paths.length });
          break;
        }
        case "floors": {
          // Change the number of floors: rebuild the building with the same outlines, heights and uses.
          if (o.floors === undefined && o.add === undefined) throw new FormaError(`ops[${k}] floors needs floors (new total) or add (e.g. -3)`, "Example: {op:'floors', from:'selection', add:-3}");
          const made: { p: string; urn: string; old: string; from: number; to: number }[] = [];
          for (const p of paths) {
            const n = node(p);
            if (n.cat !== "building") throw new FormaError(`'${p}' is not a building`, "Pick buildings with forma_find category:'building'.");
            // Building Design buildings are regenerated by Forma from its own editor data (verified live):
            // a swapped-in replacement is overwritten, so changing them here cannot work.
            const parentUrn = n.parent ? nodes.get(n.parent)?.urn : undefined;
            // Building Design buildings are regenerated by Forma from its editor and SHARED across design
            // options (both verified live): changing them here is neither reliable nor contained. Always refuse.
            if (/:building-design:/.test(n.urn) || /:building-design:/.test(parentUrn ?? ""))
              throw new FormaError(`'${p}' was made in Forma's Building Design tool; its floors can only be changed there`, "Tell the user: open this building in Forma's Building Design editor and change its number of floors there. Nothing was changed. Do not retry with other ops.");
            const { element } = await this.F.elements.get({ urn: n.urn as any });
            const internal = (element.representations as AnyObj | undefined)?.__INTERNAL__?.data;
            let req: { floors: AnyObj[]; plans?: AnyObj[] };
            let from: number;
            if (internal?.floors?.length) {
              from = internal.floors.length;
              const to = o.floors ?? from + o.add;
              try { req = stackFromInternal(internal, to); } catch (e) { throw new FormaError(`'${p}': ${(e as Error).message}`, "Choose at least 1 floor."); }
            } else {
              const m = await this.measure(n, ["floors", "height"]);
              from = Number(m.floors) || Math.max(1, Math.round((Number(m.height) || 3) / 3));
              const to = o.floors ?? from + o.add;
              if (!Number.isInteger(to) || to < 1 || to > 200) throw new FormaError(`'${p}': floor count must be 1–200 (got ${to})`, "Choose at least 1 floor.");
              const fp = await this.footprint(p);
              if (fp?.type !== "Polygon") throw new FormaError(`'${p}' has no readable footprint`, "This building can't be resized here; edit it in Forma.");
              const h = (Number(m.height) || from * 3) / from;
              req = { floors: Array.from({ length: to }, () => ({ polygon: cleanRing(fp.coordinates as P2[]), height: r2(h) })) };
            }
            const to = req.floors.length;
            if (to === from) { notes.push({ k, op: "floors", path: p, unchanged: from }); continue; }
            if (a.preview) { notes.push({ k, op: "floors", path: p, from, to }); continue; }
            const { urn } = await this.F.elements.floorStack.createFromFloors(req as any);
            const expect = req.floors.reduce((t: number, f: AnyObj) => t + Number(f.height), 0);
            made.push({ p, urn, old: n.urn, from, to });
            floorChecks.push({ p, expect });
          }
          for (const m of made) {
            updates.push({ type: "replace", path: m.p, urn: m.urn });
            inverse.unshift({ type: "replace", path: m.p, urn: m.old, cur: m.urn });
            notes.push({ k, op: "floors", path: m.p, from: m.from, to: m.to });
          }
          break;
        }
        default:
          throw new FormaError(`ops[${k}] unknown op '${o.op}'`, "op: move | copy | remove | rename | props | floors");
      }
    }
    if (a.preview) return { preview: true, ops: notes, sdkOps: updates.length };
    const { results: res, verified, saved, fix } = await this.applyBatch(updates, a.wait !== false);
    // Floor changes must really show up: check each building's height, and roll back if Forma ignored it.
    if (floorChecks.length && !saved) {
      const bad: string[] = [];
      for (const c of floorChecks) {
        const path = c.p ?? (c.addIndex !== undefined ? res[c.addIndex]?.path : undefined);
        if (!path) { bad.push("new building not found"); continue; }
        const t = await this.F.geometry.getTriangles({ path }).catch(() => undefined);
        const b = t ? bboxOfTriangles(t) : undefined;
        const h = b ? b.max[2] - b.min[2] : NaN;
        if (!(Math.abs(h - c.expect) <= Math.max(0.5, c.expect * 0.02))) bad.push(`${path} (height ${Number.isFinite(h) ? r1(h) : "?"} m, expected ${r1(c.expect)} m)`);
      }
      if (bad.length) {
        const added = res.map((r, i) => (updates[i].type === "add" && r?.path ? ({ type: "remove", path: r.path } as UpdateOp) : undefined)).filter(Boolean) as UpdateOp[];
        const reverted = await this.applyBatch([...added, ...inverse.map((u) => (u.type === "replace" ? { type: "replace", path: u.path, urn: u.urn } : u))] as UpdateOp[]).catch(() => undefined);
        if (!reverted || reverted.saved)
          return { saved: "Saved state unconfirmed. Forma did not confirm restoring the original floor change.",
            fix: CHECK_SAVE_FIX, pathsVerified: false };
        throw new FormaError(`Forma did not apply the floor change: ${bad.join("; ")}. It was rolled back; nothing changed.`, "Tell the user this building's floors can't be changed from here and to change them in Forma directly. Do not retry.");
      }
    }
    // Re-added elements get new paths; undo removes those, then restores the originals.
    const newPaths = res.map((r, i) => (updates[i].type === "add" ? r?.path : undefined)).filter(Boolean) as string[];
    const removed = updates.filter((u) => u.type === "remove").length;
    const readded = res.map((r, i) => (updates[i].type === "add" && r?.path ? ({ type: "remove", path: r.path, urn: (updates[i] as AnyObj).urn } as UpdateOp) : undefined)).filter(Boolean) as UpdateOp[];
    const inv: UpdateOp[] = [...readded, ...inverse];
    if (verified) await this.pushUndo(`edit ${notes.map((x) => x.op).join("+")}`, inv);
    return { ...(saved ? { requested: notes, requested_removals: removed } : { applied: notes, removed }),
      paths: newPaths, pathsVerified: verified, saved, fix };

  }

  async undo(a: AnyObj) {
    this.requireWritablePage();
    const steps = Math.max(1, Math.min(a.steps ?? 1, this.undoStack.length));
    if (!this.undoStack.length) throw new FormaError("nothing to undo in this session", "Forma's own undo (Ctrl+Z in Forma) covers manual edits.");
    await this.requireEdit();
    const done: string[] = [];
    let paths: string[] = [];
    for (let s = 0; s < steps; s++) {
      const e = this.undoStack.pop()!;
      const key = await this.modelKey();
      if (e.proposalId && e.proposalId !== key) {
        this.undoStack.push(e);
        throw new FormaError(`undo entry belongs to another proposal (${e.proposalId})`, "Switch back with forma_site action:switch first.");
      }
      const nodes = await this.getTree();
      const ops: UpdateOp[] = [];
      for (const u of e.inverse) {
        if (u.type === "add") { ops.push({ type: "add", parentPath: u.parentPath, urn: u.urn, name: u.name, transform: u.transform }); continue; }
        let path = u.path;
        if (!nodes.has(path)) {
          // Paths change when elements are re-added (move, rename, earlier undo); the urn stays.
          const want = u.type === "remove" ? u.urn : u.cur;
          const hits = want ? [...nodes.values()].filter((n) => n.urn === want) : [];
          if (hits.length !== 1) {
            this.undoStack.push(e);
            throw new FormaError(`cannot undo '${e.label}': ${u.path} no longer exists (edited elsewhere)`, "Inspect with forma_find and fix manually; Forma's own undo (Ctrl+Z) may help.");
          }
          path = hits[0].path;
        }
        ops.push(u.type === "remove" ? { type: "remove", path } : { type: "replace", path, urn: u.urn });
      }
      const { results, verified, saved, fix } = await this.applyBatch(ops);
      paths = results.flatMap((r) => r?.path ? [r.path] : []);
      if (saved) return { undone: done, requested_undo: e.label, paths, pathsVerified: verified, saved, fix, remaining: this.undoStack.length };
      done.push(e.label);
    }
    return { undone: done, paths, pathsVerified: true, remaining: this.undoStack.length };
  }

  private async pushUndo(label: string, inverse: UpdateOp[]) {
    const proposalId = await this.modelKey();
    this.undoStack.push({ label, at: Date.now(), inverse, proposalId });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  /** Design options: UDMs in UDM sessions, proposals in legacy sessions. */
  async listModels(): Promise<{ cols: string[]; rows: string[][]; kind: string }> {
    const F = this.F;
    if ((await this.sessionKind()) === "udm") {
      // The SDK does not flag which UDM is open, so "current" stays blank here.
      const all = await F.udm.list();
      return { kind: "udm", cols: ["fileUrn", "name", "current", "editable"], rows: all.map((m) => [m.fileUrn, m.name, "", m.hasEditorAccess ? "y" : "n"]) };
    }
    const [all, cur] = await Promise.all([F.proposal.getAll(), F.proposal.getId()]);
    return { kind: "proposal", cols: ["id", "name", "current"], rows: all.map((p) => [propId(p) ?? "", p.properties?.name ?? "", propId(p) === cur ? "*" : ""]) };
  }

  // ---------- view ----------
  async view(a: AnyObj) {
    const F = this.F;
    switch (a.action) {
      case "capture": {
        if (a.fit) await this.fit(a.fit === true || a.fit === "all" ? {} : typeof a.fit === "string" ? { view: a.fit } : a.fit, 0);
        const w = clamp(a.width ?? 1024, 64, 2048), h = clamp(a.height ?? 640, 64, 2048);
        const canvas = await F.camera.capture({ width: w, height: h });
        const mime = a.format === "png" ? "image/png" : "image/jpeg";
        const url = canvas.toDataURL(mime, clamp(a.quality ?? 0.72, 0.3, 0.95));
        return { image: url.slice(url.indexOf(",") + 1), mime, width: w, height: h };
      }
      case "camera":
        if (a.position) await F.camera.move({ position: v3(a.position), target: a.target ? v3(a.target) : undefined, transitionTimeMs: a.ms ?? 0 });
        return camOut(await F.camera.getCurrent());
      case "fit":
        return this.fit(a, a.ms ?? 0);
      case "perspective":
        await F.camera.switchPerspective();
        return camOut(await F.camera.getCurrent());
      case "color": {
        const map = new Map<string, string>();
        if (a.colors) for (const [p, c] of Object.entries(a.colors)) map.set(p, String(c));
        else for (const p of await this.targets(a)) map.set(p, a.color ?? "#ff6a00");
        await F.render.elementColors.set({ pathsToColor: map });
        return { colored: map.size };
      }
      case "color_by":
        return this.colorBy(a);
      case "clear_colors":
        await F.render.elementColors.clearAll();
        return { ok: true };
      case "hide":
      case "show": {
        const paths = await this.targets(a);
        await F.render.setElementsVisibility({ paths: paths.map((path) => ({ path, visible: a.action === "show" })) });
        return { [a.action === "hide" ? "hidden" : "shown"]: paths.length };
      }
      case "isolate": {
        const keep = new Set(await this.targets(a));
        const nodes = await this.getTree();
        const keepAnc = new Set<string>();
        for (const p of keep) for (let q: string | undefined = p; q; q = nodes.get(q)?.parent) keepAnc.add(q);
        const hide = [...nodes.values()].filter((n) => n.cat && n.cat !== "terrain" && !keepAnc.has(n.path) && ![...keep].some((k) => n.path.startsWith(k + "/")));
        await F.render.setElementsVisibility({ paths: hide.map((n) => ({ path: n.path, visible: false })) });
        return { kept: keep.size, hidden: hide.length };
      }
      case "show_all":
        await F.render.unhideAllElements();
        return { ok: true };
      case "sun":
        if (a.date) await F.sun.setDate({ date: new Date(a.date) });
        return { date: (await F.sun.getDate()).toISOString() };
      case "overlay": {
        const feats: AnyObj[] = [];
        for (const p of a.polygons ?? []) { const r = cleanRing(p); feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...r, r[0]]] } }); }
        for (const l of a.lines ?? []) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } });
        if (!feats.length) throw new FormaError("The overlay needs a polygon or line", "For example, pass lines:[[[0,0],[10,0]]].");
        const { id } = await F.render.geojson.add({ geojson: { type: "FeatureCollection", features: feats } as any, transform: a.z ? (translation(0, 0, a.z) as any) : undefined });
        this.overlays.push(id);
        return { id, features: feats.length };
      }
      case "clear_overlays":
        await Promise.all([F.render.geojson.cleanup(), F.render.cleanup()]);
        this.overlays = [];
        return { ok: true };
      default:
        throw new FormaError(`unknown view action '${a.action}'`, "action: capture | camera | fit | perspective | color | color_by | clear_colors | hide | show | isolate | show_all | sun | overlay | clear_overlays");
    }
  }

  private async fit(a: AnyObj, ms: number) {
    const paths = a.paths || a.from || a.category ? await this.targets(a) : undefined;
    let box: Box | undefined;
    if (paths?.length) box = mergeBoxes(await pool(paths.slice(0, 200), 12, async (p) => {
      const b = await this.F.geometry.getTriangles({ path: p }).then(bboxOfTriangles).catch(() => undefined);
      if (b) return b;
      const fp = await this.footprint(p);
      if (!fp?.coordinates?.length) return undefined;
      const xs = fp.coordinates.map((q) => q[0]), ys = fp.coordinates.map((q) => q[1]);
      return { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), 0] } as Box;
    }));
    if (!box) {
      const b = await this.F.terrain.getBbox();
      box = { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }
    const c = [0, 1, 2].map((k) => (box!.min[k] + box!.max[k]) / 2);
    const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], (box.max[2] - box.min[2]) * 1.5, 30);
    const d = span * (a.zoom ?? 1.6);
    const view = a.view ?? "iso";
    const dir: Record<string, number[]> = {
      top: [0, -0.001, 1], iso: [0.5, -0.6, 0.95], // steep enough to look over taller neighbours north: [0, 1, 0.35], south: [0, -1, 0.35], east: [1, 0, 0.35], west: [-1, 0, 0.35],
      ne: [0.7, 0.7, 0.5], nw: [-0.7, 0.7, 0.5], se: [0.7, -0.7, 0.5], sw: [-0.7, -0.7, 0.5],
    };
    const v = dir[view] ?? dir.iso;
    const l = Math.hypot(v[0], v[1], v[2]);
    const position = { x: c[0] + (v[0] / l) * d, y: c[1] + (v[1] / l) * d, z: c[2] + (v[2] / l) * d };
    await this.F.camera.move({ position, target: { x: c[0], y: c[1], z: c[2] }, transitionTimeMs: ms });
    return { view, center: c.map(r1), span: r1(span) };
  }

  private async colorBy(a: AnyObj) {
    const by = a.by ?? "height";
    const paths = await this.targets({ category: "building", ...a });
    const nodes = await this.getTree();
    const map = new Map<string, string>();
    const legend: AnyObj = {};
    if (by === "func") {
      const fs = await this.functions();
      for (const p of paths) {
        const f = fs.find((x) => x.id === nodes.get(p)?.func);
        const col = f?.color ?? "#9e9e9e";
        map.set(p, col);
        legend[f?.name ?? "none"] = col;
      }
    } else {
      const field = by === "area" ? "area" : by === "gfa" ? "gfa" : by === "floors" ? "floors" : "height";
      const vals = await pool(paths, 12, async (p) => ({ p, v: (await this.measure(nodes.get(p)!, [field]))[field] as number | undefined }));
      const ok = vals.filter((x) => typeof x.v === "number") as { p: string; v: number }[];
      const lo = a.min ?? Math.min(...ok.map((x) => x.v)), hi = a.max ?? Math.max(...ok.map((x) => x.v));
      for (const { p, v } of ok) map.set(p, ramp(hi > lo ? (v - lo) / (hi - lo) : 0.5));
      Object.assign(legend, { field, min: r1(lo), max: r1(hi), ramp: "blue→red" });
    }
    await this.F.render.elementColors.set({ pathsToColor: map });
    return { colored: map.size, legend };
  }

  // ---------- analysis ----------
  async analysis(a: AnyObj) {
    const F = this.F;
    switch (a.action) {
      case "list": {
        const pid = await F.proposal.getId().catch(() => undefined);
        const [listed, noise] = await Promise.all([
          F.analysis.list({ analysisTypes: a.types }),
          a.types ? [] : F.analysis.list({ analysisTypes: ["noise"] }).catch(() => []),
        ]);
        const all = [...new Map([...listed, ...noise].map((x) => [x.analysisId, x])).values()];
        const rows = all.filter((x) => a.allProposals || !pid || x.proposalId === pid).sort((x, y) => y.createdAt - x.createdAt).slice(0, a.limit ?? 20)
          .map((x) => [x.analysisId, x.analysisType, x.status, new Date(x.createdAt < 1e12 ? x.createdAt * 1000 : x.createdAt).toISOString().slice(0, 16)]);
        return { cols: ["id", "type", "status", "created"], rows };
      }
      case "sun":
      case "noise": {
        await this.requireEdit();
        const paths = a.paths || a.from ? await this.targets(a) : await this.targets({ category: "building" }, false);
        const r = a.action === "sun"
          ? await F.analysis.triggerSun({ selectedElementPaths: paths, month: a.month ?? 6, date: a.day ?? 21 })
          : await F.analysis.triggerNoise({ selectedElementPaths: paths });
        this.submittedAnalyses.set(r.analysisId, { type: a.action, at: Date.now() });
        if (this.submittedAnalyses.size > 100) {
          const oldest = this.submittedAnalyses.keys().next();
          if (!oldest.done) this.submittedAnalyses.delete(oldest.value);
        }
        return { id: r.analysisId, type: r.analysisType, status: r.status, next: analysisPollHint(r.analysisId, a.action) };
      }
      case "result": {
        if (!a.id) throw new FormaError("result needs id", "Get ids from forma_analysis action:list.");
        const analysisId = String(a.id);
        const submitted = this.submittedAnalyses.get(analysisId);
        // Noise jobs can be absent from the generic list. The SDK has a dedicated lookup.
        const noise = async () => {
          const direct = typeof F.analysis.getNoiseAnalysis === "function"
            ? await F.analysis.getNoiseAnalysis({ analysisId }).catch(() => undefined)
            : undefined;
          if (direct) return direct;
          const records = await F.analysis.list({ analysisTypes: ["noise"] }).catch(() => []);
          return records.find((x) => x.analysisId === analysisId);
        };
        const listed = async () => (await F.analysis.list({})).find((x) => x.analysisId === analysisId);
        const an = submitted?.type === "noise" ? (await noise()) ?? (await listed()) : (await listed()) ?? (await noise());
        if (!an) {
          if (submitted && Date.now() - submitted.at < REGISTRATION_MS) {
            return { id: analysisId, type: submitted.type, status: "registering", next: analysisPollHint(analysisId, submitted.type) };
          }
          throw new FormaError(`analysis '${analysisId}' not found`, "Use forma_analysis action:list to check the ID, or look in Forma's Analyze panel.");
        }
        if (an.status === "FAILED" || an.status === "STOPPED") {
          return { id: an.analysisId, type: an.analysisType, status: an.status,
            fix: "Open Forma's Analyze panel to see why this analysis ended." };
        }
        if (an.status !== "SUCCEEDED" && an.status !== "COMPLETED") {
          return { id: an.analysisId, type: an.analysisType, status: an.status, next: analysisPollHint(an.analysisId, an.analysisType) };
        }
        const g = await F.analysis.getGroundGrid({ analysis: an }).catch((e: Error) => {
          if (/texture metadata/i.test(String(e?.message))) return undefined;
          throw new FormaError("Forma could not share the analysis grid", "Open the result in Forma's Analyze panel.");
        });
        if (!g) {
          const fresh = an.analysisType === "sun"
            ? " For a fresh current-scene calculation, use forma_analysis action:sun_hours."
            : "";
          return { id: an.analysisId, type: an.analysisType, status: an.status, grid: "not shared by Forma",
            next: `View the stored result in Forma's Analyze panel.${fresh}` };
        }
        return { id: an.analysisId, type: an.analysisType, status: an.status, ...gridStats(g, a.inside, a.bins ?? 8, a.threshold) };
      }
      case "sun_hours":
        return this.sunHoursLocal(a);
      case "sun_hours_hide":
        await F.terrain.groundTexture.remove({ name: SUN_TEX }).catch(() => {});
        return { hidden: true };
      case "wind_params": {
        const w = await F.predictiveAnalysis.getWindParameters();
        return { height: w.height, roughness: w.roughness, rose: w.data.map((d) => [d.direction, r2(d.probability)]) };
      }
      default:
        throw new FormaError(`unknown analysis action '${a.action}'`, "action: list | sun | noise | result | wind_params");
    }
  }

  /**
   * Sun hours on open ground for one day, from the buildings' 3D shapes and the terrain.
   * Study area: `inside` polygon, else the site boundary, else around all buildings.
   */
  private async sunHoursLocal(a: AnyObj) {
    const F = this.F;
    const t0 = Date.now();
    const geo = await F.project.getGeoLocation().catch(() => undefined);
    if (!geo) throw new FormaError("the project has no geographic location", "Set the project location in Forma; sun hours need latitude/longitude.");
    const [lat, lon] = geo;
    const nodes = await this.getTree();
    const all = [...nodes.values()];
    const isTop = (n: TreeNode) => !n.parent || nodes.get(n.parent)?.cat !== n.cat;
    const blds = all.filter((n) => n.cat === "building" && isTop(n));
    const meshes = await pool(blds.map((n) => n.path), 8, (p) => F.geometry.getTriangles({ path: p }).catch(() => undefined));
    const boxes = meshes.map((t) => (t ? bboxOfTriangles(t) : undefined));
    let ring: P2[] | undefined = a.inside ? cleanRing(a.inside) : undefined;
    if (!ring) {
      const site = all.find((n) => n.cat === "site_limit");
      const fp = site ? await this.footprint(site.path) : undefined;
      if (fp?.type === "Polygon" && fp.coordinates.length > 2) ring = cleanRing(fp.coordinates as P2[]);
    }
    const study = ring
      ? { min: [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))], max: [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))] }
      : mergeBoxes(boxes);
    if (!study) throw new FormaError("nothing to study: no site boundary and no buildings", "Draw a site limit, or pass inside:[[x,y],…].");
    const zMax = Math.max(0, ...boxes.map((b) => b?.max[2] ?? 0));
    const zMin = Math.min(...boxes.filter(Boolean).map((b) => b!.min[2]), zMax);
    const margin = Math.min(150, Math.max(30, (zMax - zMin) * 2.5)); // obstacles this far out can still shade the area
    let res = Math.max(0.5, a.res ?? 2);
    const x0 = study.min[0] - margin, y0 = study.min[1] - margin;
    const spanX = study.max[0] - study.min[0] + 2 * margin, spanY = study.max[1] - study.min[1] + 2 * margin;
    while ((spanX / res) * (spanY / res) > 160000) res *= 1.25;
    const width = Math.ceil(spanX / res), height = Math.ceil(spanY / res), n = width * height;
    const g = { width, height, x0, y0, res, ground: new Float32Array(n).fill(NaN), top: new Float32Array(n).fill(-Infinity) };
    const terrain = all.find((x) => x.cat === "terrain");
    const tt = terrain ? await F.geometry.getTriangles({ path: terrain.path }).catch(() => undefined) : undefined;
    if (tt) rasterMax(tt, g, g.ground, "interp");
    const zGround = Number.isFinite(zMin) ? zMin : 0;
    for (let k = 0; k < n; k++) if (!Number.isFinite(g.ground[k])) g.ground[k] = zGround;
    for (const t of meshes) if (t) rasterMax(t, g, g.top, "max");
    for (let k = 0; k < n; k++) if (!(g.top[k] > g.ground[k])) g.top[k] = g.ground[k];
    const year = (await F.sun.getDate().catch(() => new Date())).getFullYear();
    const month = a.month ?? 6, day = a.day ?? 21;
    const sh = sunHours(g, lat, lon, year, month, day, a.stepMin ?? 15);
    // Statistics only for cells in the study area.
    const inStudy = new Uint8Array(n);
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++) {
        const k = r * width + c, px = x0 + (c + 0.5) * res, py = y0 + (r + 0.5) * res;
        inStudy[k] = sh.mask[k] && (ring ? pointInPoly([px, py], ring) : px >= study.min[0] && px <= study.max[0] && py >= study.min[1] && py <= study.max[1]) ? 1 : 0;
      }
    const stats = gridStats({ grid: sh.grid, mask: inStudy, width, height, x0, y0, resolution: res }, undefined, a.bins ?? 8, a.threshold);
    let shown = false;
    if (a.show !== false && typeof document !== "undefined") {
      shown = await this.showSunTexture(sh.grid, inStudy, width, height, x0, y0, res, sh.daylight_h).catch(() => false);
    }
    return {
      scope: "current-scene",
      date: `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.`, daylight_h: r1(sh.daylight_h),
      ...stats,
      source: "calculated by forma-mcp from the 3D buildings and terrain (15-min steps)",
      ...(shown ? { overlay: "shown on the ground (yellow = most sun, blue = least); hide with action:sun_hours_hide" } : {}),
      ms: Date.now() - t0,
    };
  }

  private async showSunTexture(v: Float32Array, m: Uint8Array, w: number, hgt: number, x0: number, y0: number, res: number, maxH: number) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = hgt;
    const ctx = cv.getContext("2d");
    if (!ctx) return false;
    const img = ctx.createImageData(w, hgt);
    for (let r = 0; r < hgt; r++)
      for (let c = 0; c < w; c++) {
        const k = r * w + c, o = ((hgt - 1 - r) * w + c) * 4; // canvas row 0 = north
        if (!m[k]) continue;
        const [R, G, B] = sunRamp(maxH > 0 ? v[k] / maxH : 0);
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 190;
      }
    ctx.putImageData(img, 0, 0);
    await this.F.terrain.groundTexture.remove({ name: SUN_TEX }).catch(() => {});
    await this.F.terrain.groundTexture.add({ name: SUN_TEX, canvas: cv, position: { x: x0 + (w * res) / 2, y: y0 + (hgt * res) / 2, z: 5 }, scale: { x: res, y: res } });
    return true;
  }

  // ---------- site / proposals ----------
  async site(a: AnyObj) {
    const F = this.F;
    switch (a.action ?? "info") {
      case "info": {
        const [p, geo, bbox, internal, funcs] = await Promise.all([
          F.project.get(), F.project.getGeoLocation().catch(() => undefined), F.terrain.getBbox(), F.terrain.isInternal().catch(() => undefined), this.functions(),
        ]);
        return {
          name: p.name, country: p.countryCode, srid: p.srid, refPoint: p.refPoint, latlon: geo, tz: p.timezone,
          terrain: { min: [bbox.min.x, bbox.min.y, bbox.min.z].map(r1), max: [bbox.max.x, bbox.max.y, bbox.max.z].map(r1), internal },
          functions: funcs.map((f) => f.name),
        };
      }
      case "elevation": {
        const pts: P2[] = a.points ?? [];
        if (!pts.length || pts.length > 2000) throw new FormaError("Provide between 1 and 2,000 points", "Pass local coordinates, for example points:[[0,0]].");
        const zs = await pool(pts, 24, ([x, y]) => F.terrain.getElevationAt({ x, y }).catch(() => NaN));
        return { z: zs.map((z) => (Number.isFinite(z) ? r2(z) : null)) };
      }
      case "pads":
        return { pads: (await F.terrain.getPads()).map((p) => ({ id: p.id, z: p.elevation, slope: p.applySlope ? p.slopeAngle ?? p.slopePercentage : undefined, pts: p.coordinates.map((c) => [r2(c.x), r2(c.y)]) })) };
      case "add_pads": {
        await this.requireEdit();
        const pads = (a.pads ?? []).map((p: AnyObj, i: number) => ({
          id: p.id ?? `mcp-pad-${Date.now()}-${i}`,
          coordinates: cleanRing(p.polygon).map(([x, y]) => ({ x, y })),
          elevation: p.z ?? p.elevation,
          applySlope: p.slope !== undefined,
          ...(p.slope !== undefined ? { slopeAngle: p.slope } : {}),
        }));
        if (!pads.length || pads.some((p: AnyObj) => typeof p.elevation !== "number")) throw new FormaError("pads need polygon and z", "pads:[{polygon:[[x,y],...], z:12.5, slope?:30}]");
        await (a.apply ? F.terrain.applyPads(pads) : F.terrain.addPads(pads));
        return { added: pads.length, ids: pads.map((p: AnyObj) => p.id) };
      }
      case "functions":
        this.funcs = undefined;
        return { functions: (await this.functions()).map((f) => [f.id, f.name, f.color ?? ""]) };
      case "add_function": {
        await this.requireEdit();
        const r = await F.settings.buildingFunctions.add({ name: a.name, color: a.color });
        this.funcs = r.buildingFunctions;
        return { functions: r.buildingFunctions.map((f) => [f.id, f.name, f.color ?? ""]) };
      }
      case "proposals":
      case "models":
        return this.listModels();
      case "switch": {
        if (!a.id) throw new FormaError("switch needs id", "Get ids (proposal id or UDM fileUrn) from forma_site action:proposals.");
        if ((await this.sessionKind()) === "udm") {
          const ok = await F.udm.switch({ fileUrn: a.id });
          if (ok) this.resetSession();
          return { switched: ok ? a.id : false, note: ok ? "Extension reloads; the bridge reconnects in a few seconds." : "Unsaved work could not be saved; nothing changed." };
        }
        await F.proposal.switch({ proposalId: a.id });
        this.resetSession();
        return { switched: a.id };
      }
      case "duplicate": {
        this.requireWritablePage();
        if ((await this.sessionKind()) === "udm") throw new FormaError("duplicate is not available in Unified Design Model sessions", "Duplicate the model in Forma's UI, then forma_site action:switch.");
        const id = a.id ?? (await F.proposal.getId());
        const p = await F.proposal.duplicate({ proposalId: id });
        if (a.switch !== false) {
          await F.proposal.switch({ proposalId: propId(p)! });
          this.resetSession();
        }
        return { id: propId(p), name: p.properties?.name, switched: a.switch !== false };
      }
      case "delete_proposal":
        this.requireWritablePage();
        if ((await this.sessionKind()) === "udm") throw new FormaError("delete is not available in Unified Design Model sessions", "Delete the model in Forma's UI.");
        if (a.confirm !== true) throw new FormaError("deleting a proposal is irreversible", "Show the user the proposal name and repeat with confirm:true only after they approve.");
        await F.proposal.delete({ proposalId: a.id });
        return { deleted: a.id };
      default:
        throw new FormaError(`unknown site action '${a.action}'`, "action: info | elevation | pads | add_pads | functions | add_function | proposals | switch | duplicate | delete_proposal");
    }
  }

  // ---------- script ----------
  async script(a: AnyObj) {
    this.requireWritablePage();
    if (typeof a.code !== "string" || !a.code.trim()) throw new FormaError("The script is empty", 'Pass a script, for example code:"return 1".');
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (...p: string[]) => (...x: unknown[]) => Promise<unknown>;
    const fn = new AsyncFn("Forma", "args", "h", a.code);
    const helpers = { tree: () => this.getTree(), geom: { area, centroid, cleanRing, rect, offset, extrude } };
    const r = await fn(this.F, a.args ?? {}, helpers);
    this.session.tree = undefined; // script may have changed things
    return trimJson(r, a.maxChars ?? 6000);
  }
}

// ---------- helpers ----------
const CAT_ALIASES: Record<string, string> = { buildings: "building", site: "site_limit", sitelimit: "site_limit", trees: "vegetation", tree: "vegetation", roads: "road" };
const normCat = (c: string) => CAT_ALIASES[c.toLowerCase()] ?? c;

/** Readable, unique building names for lists and reports. Forma names every new building
 *  "Building 1", so duplicates (or missing names) become "Building A (35 m)" in stable path order. */
export function labelBuildings(
  rows: { path: string; name?: string; height?: number }[],
  aliases = buildingAliases(rows),
) {
  for (const row of rows) {
    const alias = aliases.get(row.path);
    if (alias) row.name = row.height === undefined ? alias : `${alias} (${r1(row.height)} m)`;
  }
}

function buildingAliases(rows: { path: string; name?: string }[]) {
  const count = new Map<string, number>();
  for (const r of rows) if (r.name) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  const generic = rows.filter((r) => !r.name || count.get(r.name)! > 1).sort((a, b) => a.path.localeCompare(b.path));
  return new Map(generic.map((r, i) => {
    const letter = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
    return [r.path, `Building ${letter}`];
  }));
}

function analysisPollHint(id: string, type: string): string {
  const timing = type === "sun" ? " Sun usually takes 1–3 minutes." : type === "noise" ? " Noise analysis uses the design's road and rail traffic data." : "";
  return `Poll again in about 30 seconds with forma_analysis action:result id:${id}.${timing}`;
}

function ringOf(polygon: P2[] | undefined, r: AnyObj | number[] | undefined, where: string): P2[] {
  if (polygon) {
    const ring = safe(() => cleanRing(polygon));
    const fix = "List at least three distinct corners in order around the outline, with no crossing edges, or use rect:[0,0,10,8].";
    if (!ring) throw new FormaError(`${where} needs at least three distinct footprint corners`, fix);
    if (selfIntersects(ring)) throw new FormaError(`${where} has a self-intersecting footprint`, fix);
    if (area(ring) <= 1e-8) throw new FormaError(`${where} has a footprint with no area`, fix);
    return ring;
  }
  if (r) {
    const [x, y, w, d, rot] = Array.isArray(r) ? r : [r.x, r.y, r.w, r.d, r.rot];
    if (!(w > 0 && d > 0)) throw new FormaError(`${where} needs a positive width and depth`, "For example, use rect:[0,0,10,8].");
    return rect(x ?? 0, y ?? 0, w, d, rot ?? 0);
  }
  throw new FormaError(`${where} needs a footprint`, "For example, use polygon:[[0,0],[10,0],[0,8]] or rect:[0,0,10,8].");
}

function hier(properties: AnyObj) {
  return { rootElement: "root", elements: { root: { id: "root", properties } } };
}

function multiRingArea(rings: [number, number][][]): number {
  if (!rings?.length) return 0;
  return rings.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * area(r as P2[]), 0);
}

// urn:adsk-forma-elements:{system}:{authcontext}:{id}:{revision}
function propId(p: AnyObj): string | undefined {
  return p?.urn?.split(":")[4];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

function short(urn: string) {
  return urn.length > 40 ? urn.slice(urn.lastIndexOf(":", urn.length - 2) + 1) : urn;
}

function isIdentity(t: number[]) {
  return t.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
}

function v3(p: number[] | AnyObj) {
  return Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] ?? 0 } : (p as { x: number; y: number; z: number });
}

function camOut(c: AnyObj) {
  return { type: c.type, pos: [c.position.x, c.position.y, c.position.z].map(r1), target: [c.target.x, c.target.y, c.target.z].map(r1) };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

function ramp(t: number): string {
  // perceptually smooth blue → yellow → red
  const stops = [[49, 54, 149], [69, 117, 180], [116, 173, 209], [254, 224, 144], [244, 109, 67], [165, 0, 38]];
  const x = clamp(t, 0, 1) * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function gridStats(g: AnyObj, inside?: P2[], bins = 8, threshold?: number) {
  const { grid, mask, width, height, x0, y0, resolution } = g;
  const ring = inside ? cleanRing(inside) : undefined;
  const vals: number[] = [];
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (mask && !mask[i]) continue;
      const v = grid[i];
      if (!Number.isFinite(v)) continue;
      if (ring && !pointInPoly([x0 + (c + 0.5) * resolution, y0 + (r + 0.5) * resolution], ring)) continue;
      vals.push(v);
    }
  if (!vals.length) return { cells: 0, note: ring ? "no grid cells inside polygon" : "empty grid" };
  vals.sort((p, q) => p - q);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const lo = vals[0], hi = vals[vals.length - 1], step = (hi - lo) / bins || 1;
  const hist = new Array(bins).fill(0);
  for (const v of vals) hist[Math.min(bins - 1, Math.floor((v - lo) / step))]++;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return {
    cells: vals.length, cell_m: resolution, area_m2: r1(vals.length * resolution * resolution),
    min: r2(lo), p10: r2(q(0.1)), median: r2(q(0.5)), mean: r2(mean), p90: r2(q(0.9)), max: r2(hi),
    hist: { from: r2(lo), step: r2(step), counts: hist },
    ...(threshold !== undefined ? { share_at_or_above: r2(vals.filter((v) => v >= threshold).length / vals.length) } : {}),
    ...(ring ? { inside_note: "cell centres assume row 0 at y0, +y per row" } : {}),
  };
}

export function trimJson(v: unknown, maxChars: number): unknown {
  const seen = new WeakSet();
  const s = JSON.stringify(v, (_k, x) => {
    if (typeof x === "number") return Number.isInteger(x) ? x : Math.round(x * 1000) / 1000;
    if (ArrayBuffer.isView(x)) return `<${x.constructor.name} len=${(x as unknown as ArrayLike<number>).length}>`;
    if (x instanceof ArrayBuffer) return `<ArrayBuffer ${x.byteLength}B>`;
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Set) return [...x];
    if (typeof HTMLCanvasElement !== "undefined" && x instanceof HTMLCanvasElement) return `<canvas ${x.width}x${x.height}>`;
    if (x && typeof x === "object") { if (seen.has(x)) return "<cycle>"; seen.add(x); }
    return x;
  });
  if (s === undefined) return null;
  if (s.length <= maxChars) return JSON.parse(s);
  return { truncated: true, chars: s.length, head: s.slice(0, maxChars) };
}

export async function pool<T, R>(items: readonly T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
