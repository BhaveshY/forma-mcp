// In-memory stand-in for the Forma embedded-view SDK, covering the calls Ops makes.
type Child = { key: string; urn: string; name?: string; transform?: number[] };
type El = { urn: string; properties: Record<string, any>; children?: Child[] };

export function mockForma(opts: { canEdit?: boolean; kind?: "proposal" | "udm" } = {}) {
  let rev = 1;
  let keySeq = 0;
  const els = new Map<string, El>();
  const footprints = new Map<string, [number, number][]>(); // by urn
  const boxes = new Map<string, number[]>(); // by urn: [minx,miny,minz,maxx,maxy,maxz]
  const children: Child[] = [];
  const calls: { fn: string; arg: any }[] = [];
  const rootUrn = () => `urn:adsk-forma-elements:proposal:proj:prop1:${rev}`;
  const mkUrn = (sys: string) => `urn:adsk-forma-elements:${sys}:proj:e${++keySeq}:1`;

  const addEl = (cat: string, name: string, fp?: [number, number][], h = 10, extra: Record<string, any> = {}) => {
    const urn = mkUrn(cat);
    els.set(urn, { urn, properties: { category: cat, name, ...extra } });
    if (fp) {
      footprints.set(urn, fp);
      const xs = fp.map((p) => p[0]), ys = fp.map((p) => p[1]);
      boxes.set(urn, [Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), h]);
    }
    children.push({ key: `k${keySeq}`, urn, name });
    return `root/k${keySeq}`;
  };

  addEl("terrain", "Terrain");
  const b1 = addEl("building", "Block A", [[0, 0], [20, 0], [20, 10], [0, 10]], 21, { functionId: "res" });
  const b2 = addEl("building", "Block B", [[30, 0], [40, 0], [40, 10], [30, 10]], 9);
  const site = addEl("site_limit", "Site", [[-10, -10], [60, -10], [60, 40], [-10, 40]], 0);

  const byPath = (p: string) => children.find((c) => `root/${c.key}` === p);
  const box = (c: Child) => {
    const b = boxes.get(c.urn);
    if (!b) return undefined;
    const t = c.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return [b[0] + t[12], b[1] + t[13], b[2] + t[14], b[3] + t[12], b[4] + t[13], b[5] + t[14]];
  };

  const batch = async ({ operations }: { operations: any[] }) => {
    calls.push({ fn: "batch", arg: operations });
    const out: ({ path: string } | null)[] = [];
    for (const o of operations) {
      if (o.type === "add") {
        if (!els.has(o.urn)) throw new Error(`unknown urn ${o.urn}`);
        const key = `k${++keySeq}`;
        children.push({ key, urn: o.urn, name: o.name, transform: o.transform });
        out.push({ path: `root/${key}` });
      } else if (o.type === "remove") {
        const i = children.findIndex((c) => `root/${c.key}` === o.path);
        if (i < 0) throw new Error(`no path ${o.path}`);
        children.splice(i, 1);
        out.push(null);
      } else {
        const c = byPath(o.path);
        if (!c) throw new Error(`no path ${o.path}`);
        c.urn = o.urn;
        out.push(null);
      }
    }
    rev++;
    return out;
  };

  const F: any = {
    getProjectId: () => "proj",
    getRegion: () => "EMEA",
    getCanEdit: async () => opts.canEdit ?? true,
    getPresentationUnitSystem: async () => "metric",
    project: {
      get: async () => ({ name: "Test Site", countryCode: "DE", srid: 25832, refPoint: [500000, 5500000], projString: "", timezone: "Europe/Berlin", hubId: "h" }),
      getGeoLocation: async () => [49.6, 8.6],
    },
    proposal: {
      getId: async () => (opts.kind === "udm" ? Promise.reject(new Error("udm session")) : "prop1"),
      getRootUrn: async () => rootUrn(),
      getAll: async () => [{ urn: "urn:adsk-forma-elements:proposal:proj:prop1:1", properties: { name: "Option A" } }, { urn: "urn:adsk-forma-elements:proposal:proj:prop2:3", properties: { name: "Option B" } }],
      updateElements: batch,
      switch: async (a: any) => calls.push({ fn: "switch", arg: a }),
    },
    udm: {
      getRootUrn: async () => rootUrn(),
      awaitPersisted: async () => {},
      subscribe: async () => ({ unsubscribe() {} }),
      list: async () => [{ fileUrn: "urn:adsk.wipprod:dm.lineage:aaa", id: "u1", name: "Model 1", revision: "1", updatedAt: "", updatedBy: "", hasEditorAccess: true }],
      switch: async () => true,
    },
    elements: {
      get: async ({ urn, recursive }: any) => {
        const all: Record<string, any> = {};
        if (urn === rootUrn() || urn.startsWith("urn:adsk-forma-elements:proposal:")) {
          const root = { urn: rootUrn(), properties: { category: "proposal", name: "Option A" }, children: children.map((c) => ({ ...c })) };
          all[root.urn] = root;
          if (recursive) for (const c of children) all[c.urn] = els.get(c.urn);
          return { element: root, elements: all };
        }
        const e = els.get(urn);
        if (!e) throw new Error("not found");
        return { element: e, elements: { [urn]: e } };
      },
      batch,
      editProperties: async ({ urn, propertiesJsonMergePatch }: any) => {
        const e = els.get(urn)!;
        const nu = mkUrn("edited");
        els.set(nu, { urn: nu, properties: { ...e.properties, ...propertiesJsonMergePatch } });
        if (footprints.has(urn)) footprints.set(nu, footprints.get(urn)!);
        if (boxes.has(urn)) boxes.set(nu, boxes.get(urn)!);
        return { urn: nu };
      },
      floorStack: {
        createFromFloors: async (r: any) => {
          calls.push({ fn: "createFromFloors", arg: r });
          const urn = mkUrn("floorstack");
          els.set(urn, { urn, properties: { category: "building" } });
          const pts: number[][] = r.plans?.length ? r.plans.flatMap((p: any) => p.vertices.map((v: any) => [v.x, v.y])) : r.floors[0].polygon;
          const h = r.floors.reduce((t: number, f: any) => t + f.height, 0);
          const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
          boxes.set(urn, [Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), h]);
          return { urn };
        },
        createFromFloorsBatch: async (reqs: any[]) => {
          calls.push({ fn: "createFromFloorsBatch", arg: reqs });
          return {
            urns: reqs.map((r) => {
              const urn = mkUrn("floorstack");
              const poly = r.floors[0].polygon ?? r.plans[0].vertices.map((v: any) => [v.x, v.y]);
              const h = r.floors.reduce((s: number, f: any) => s + f.height, 0);
              els.set(urn, { urn, properties: { category: "building" } });
              footprints.set(urn, poly);
              const xs = poly.map((p: number[]) => p[0]), ys = poly.map((p: number[]) => p[1]);
              boxes.set(urn, [Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), h]);
              return urn;
            }),
          };
        },
      },
      representations: {
        grossFloorAreaPolygons: async ({ urn }: any) => {
          const fp = footprints.get(urn);
          const b = boxes.get(urn);
          if (!fp || !b || els.get(urn)?.properties.category !== "building") return undefined;
          const floors = Math.max(1, Math.round((b[5] - b[2]) / 3));
          return { data: Array.from({ length: floors }, (_, i) => ({ grossFloorPolygon: [fp], elevation: i * 3 })) };
        },
      },
    },
    integrateElements: {
      createElementHierarchy: async ({ data }: any) => {
        calls.push({ fn: "createElementHierarchy", arg: data });
        const urn = mkUrn("integrate");
        els.set(urn, { urn, properties: data.elements.root.properties });
        return { id: "x", urn, revision: "1" };
      },
    },
    geometry: {
      getFootprint: async ({ path }: any) => {
        const c = byPath(path);
        const fp = c && footprints.get(c.urn);
        return fp ? { type: "Polygon", coordinates: fp } : undefined;
      },
      getTriangles: async ({ path }: any) => {
        const c = byPath(path);
        const b = c && box(c);
        if (!b) return new Float32Array();
        const [x0, y0, z0, x1, y1, z1] = b; // bottom + top faces of the box (real meshes are closed)
        return new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y0, z0, x1, y1, z0, x0, y1, z0,
          x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y0, z1, x1, y1, z1, x0, y1, z1]);
      },
      getPathsInsidePolygons: async ({ polygons }: any) => {
        const [poly] = polygons;
        // Real Forma (verified live): an open ring matches nothing.
        const [f, l] = [poly[0], poly[poly.length - 1]];
        if (f[0] !== l[0] || f[1] !== l[1]) return [];
        const xs = poly.map((p: number[]) => p[0]), ys = poly.map((p: number[]) => p[1]);
        return children.filter((c) => { const b = box(c); return b && b[0] >= Math.min(...xs) && b[3] <= Math.max(...xs) && b[1] >= Math.min(...ys) && b[4] <= Math.max(...ys); }).map((c) => `root/${c.key}`);
      },
    },
    selection: { getSelection: async () => [b2] },
    settings: { get: async () => ({ buildingFunctions: [{ id: "res", name: "Residential", color: "#f2c94c" }, { id: "off", name: "Office", color: "#56ccf2" }] }), buildingFunctions: { add: async () => ({ buildingFunctions: [] }) } },
    terrain: {
      getElevationAt: async ({ x }: any) => 100 + x * 0.01,
      getBbox: async () => ({ min: { x: -100, y: -100, z: 95 }, max: { x: 100, y: 100, z: 110 } }),
      isInternal: async () => false,
      getPads: async () => [],
      addPads: async (p: any) => calls.push({ fn: "addPads", arg: p }),
      applyPads: async () => {},
    },
    areaMetrics: {
      calculate: async () => ({
        customMetrics: [],
        builtInMetrics: {
          grossFloorArea: { id: "gfa", name: "GFA", functionBreakdown: [{ functionId: "res", functionName: "Residential", functionColor: "", value: 1400 }, { functionId: "off", functionName: "Office", functionColor: "", value: "UNABLE_TO_CALCULATE" }] },
          buildingCoverage: { id: "c", name: "cov", value: 0.11 },
          siteArea: { id: "s", name: "site", value: 3500 },
        },
        unitStatistics: { count: { id: "u", name: "units", value: 12 } },
        parkingStatistics: { spots: 4, area: 50 },
      }),
    },
    camera: {
      capture: async ({ width, height }: any) => ({ width, height, toDataURL: (m: string) => `data:${m};base64,QUJD` }),
      move: async (a: any) => calls.push({ fn: "camera.move", arg: a }),
      getCurrent: async () => ({ type: "perspective", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }),
      switchPerspective: async () => {},
    },
    render: {
      elementColors: { set: async (a: any) => { calls.push({ fn: "colors", arg: a }); return { id: "c" }; }, clearAll: async () => ({ id: "c" }) },
      setElementsVisibility: async (a: any) => calls.push({ fn: "vis", arg: a }),
      unhideAllElements: async () => {},
      geojson: { add: async () => ({ id: "g1" }), cleanup: async () => {} },
      cleanup: async () => {},
    },
    sun: { getDate: async () => new Date("2026-06-21T12:00:00Z"), setDate: async () => {} },
    analysis: {
      list: async () => [{ analysisId: "a1", analysisType: "sun", status: "SUCCEEDED", createdAt: 1, elementUrn: "", proposalId: "prop1", proposalRevision: "1" }],
      triggerSun: async () => ({ analysisId: "a2", analysisType: "sun", status: "CREATED" }),
      triggerNoise: async () => ({ analysisId: "a3", analysisType: "noise", status: "CREATED" }),
      getGroundGrid: async () => ({ grid: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), mask: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 0]), width: 3, height: 3, x0: 0, y0: 0, scale: { x: 1, y: 1 }, resolution: 1 }),
    },
    predictiveAnalysis: { getWindParameters: async () => ({ data: [{ direction: 0, probability: 0.2, weibull_parameters: { scale: 1, shape: 1 } }], height: 10, roughness: 0.3 }) },
  };
  return { F, calls, paths: { b1, b2, site }, children, els, footprints, boxes };
}
