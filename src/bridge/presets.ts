// Ready-made assistant tasks. Each preset is a small form; its prompt template uses
// {fieldId} placeholders. Add a preset by adding an entry here — nothing else changes.

export type Field =
  | { id: string; label: string; type: "number"; default: number; unit?: string; min?: number; max?: number; step?: number }
  | { id: string; label: string; type: "select"; default: string; options: string[] }
  | { id: string; label: string; type: "text"; default: string; placeholder?: string };

export type Preset = { id: string; title: string; blurb: string; fields: Field[]; prompt: string };

const USES = ["All residential", "Residential with shops on the ground floor", "Office", "Half residential, half office"];

export const PRESETS: Preset[] = [
  {
    id: "rules",
    title: "Check planning rules",
    blurb: "Check the buildings on the site against your height, FAR, coverage and distance limits.",
    fields: [
      { id: "maxHeight", label: "Maximum height", type: "number", default: 25, unit: "m", min: 3, max: 400 },
      { id: "maxFar", label: "Maximum FAR", type: "number", default: 2.5, min: 0.1, max: 30, step: 0.1 },
      { id: "maxCoverage", label: "Maximum site coverage", type: "number", default: 40, unit: "%", min: 1, max: 100 },
      { id: "minSetback", label: "Distance from site boundary", type: "number", default: 5, unit: "m", min: 0, max: 100, step: 0.5 },
      { id: "minSpacing", label: "Distance between buildings", type: "number", default: 10, unit: "m", min: 0, max: 200, step: 0.5 },
    ],
    prompt:
      "Check the design with forma_check, show:true, rules maxHeight {maxHeight}, maxFar {maxFar}, maxCoverage {maxCoverage}, " +
      "minSetback {minSetback}, minSpacing {minSpacing}. Do not change anything. Answer with a short list: which rules are met, " +
      "which are not, and for each problem the building and by how much. Mention that the problem buildings are now red in the 3D view.",
  },
  {
    id: "report",
    title: "Design report",
    blurb: "Save a report with key figures and every building, as a web page and an Excel file.",
    fields: [
      { id: "rules", label: "Rule check in the report", type: "select", default: "None", options: ["None", "Max height 25 m, FAR 2.5, 5 m from the site boundary", "Max height 40 m, FAR 4, 3 m from the site boundary"] },
    ],
    prompt:
      "Save a design report with forma_report. Rule check to include: {rules} (if None, pass no rules). Do not change the design. Then tell me in two or three lines the key figures " +
      "(floor area, FAR, coverage, number of buildings) and where the two files were saved.",
  },
  {
    id: "massing",
    title: "Massing options",
    blurb: "Try several building layouts for the site and compare them.",
    fields: [
      { id: "count", label: "Number of options", type: "number", default: 3, min: 1, max: 5 },
      { id: "far", label: "Target FAR", type: "number", default: 2.5, min: 0.2, max: 15, step: 0.1 },
      { id: "maxHeight", label: "Maximum height", type: "number", default: 30, unit: "m", min: 3, max: 300 },
      { id: "setback", label: "Distance from site boundary", type: "number", default: 4, unit: "m", min: 0, max: 50 },
      { id: "use", label: "Use", type: "select", default: USES[1], options: USES },
    ],
    prompt:
      "Create {count} clearly different massing options inside the site boundary. Targets: FAR about {far}, " +
      "no building taller than {maxHeight} m, keep at least {setback} m from the site boundary. Use: {use}. " +
      "Put each option in its own design option: duplicate the current design option (it switches to the copy), " +
      "build the option there, and name its buildings 'Option N – <short idea>'. Do not change the original design option. " +
      "After each option, read the area summary. At the end switch back to the original design option and give a short " +
      "comparison: option, idea, GFA, FAR, tallest building.",
  },
  {
    id: "podium",
    title: "Podium and tower",
    blurb: "A low base building with a slimmer tower on top.",
    fields: [
      { id: "where", label: "Where", type: "select", default: "In the largest free area of the site", options: ["In the largest free area of the site", "On the footprint of the selected building (replace it)"] },
      { id: "podiumFloors", label: "Podium floors", type: "number", default: 2, min: 1, max: 6 },
      { id: "podiumUse", label: "Podium use", type: "select", default: "Shops / commercial", options: ["Shops / commercial", "Office", "Residential", "Parking"] },
      { id: "towerFloors", label: "Tower floors", type: "number", default: 12, min: 1, max: 80 },
      { id: "towerUse", label: "Tower use", type: "select", default: "Residential", options: ["Residential", "Office", "Hotel"] },
      { id: "inset", label: "Tower set back from podium edge", type: "number", default: 4, unit: "m", min: 0, max: 30 },
    ],
    prompt:
      "Design one podium-and-tower building {where}. Podium: {podiumFloors} floors of {podiumUse} (ground floor 4.5 m, others 4 m). " +
      "Tower: {towerFloors} floors of {towerUse} (3 m each), set back {inset} m from the podium edge on all sides. " +
      "Stay inside the site boundary and do not overlap existing buildings unless replacing the selected one. " +
      "Check the design with a preview first, then build it, take one picture, and report height, GFA and FAR.",
  },
  {
    id: "fill",
    title: "Fill the site with blocks",
    blurb: "Lay out a regular pattern of blocks on the free part of the site.",
    fields: [
      { id: "width", label: "Block length", type: "number", default: 24, unit: "m", min: 5, max: 200 },
      { id: "depth", label: "Block depth", type: "number", default: 12, unit: "m", min: 5, max: 60 },
      { id: "gap", label: "Gap between blocks", type: "number", default: 12, unit: "m", min: 0, max: 100 },
      { id: "floors", label: "Floors", type: "number", default: 5, min: 1, max: 40 },
      { id: "setback", label: "Distance from site boundary", type: "number", default: 4, unit: "m", min: 0, max: 50 },
      { id: "use", label: "Use", type: "select", default: USES[0], options: USES },
    ],
    prompt:
      "Fill the free part of the site with a regular pattern of rectangular blocks, {width} m long and {depth} m deep, " +
      "{gap} m apart, {floors} floors each (3 m), use: {use}. Keep {setback} m from the site boundary and do not overlap " +
      "existing buildings (check each spot is free first). Orient the blocks along the longest side of the site. " +
      "Preview first, then build all blocks in one step, take one picture, and report the number of blocks, GFA and FAR.",
  },
  {
    id: "sun",
    title: "Improve sunlight",
    blurb: "Adjust the new buildings so open spaces get more sun.",
    fields: [
      { id: "target", label: "Get more sun on", type: "select", default: "the courtyards and open spaces", options: ["the courtyards and open spaces", "the facades of the new buildings", "the neighbouring buildings"] },
      { id: "date", label: "Date", type: "select", default: "21 March", options: ["21 March", "21 June", "21 September", "21 December"] },
      { id: "allowed", label: "Allowed changes", type: "select", default: "Change heights only", options: ["Change heights only", "Move and rotate buildings", "Any change, keep the same GFA"] },
    ],
    prompt:
      "Improve sunlight on {target} on {date}. Allowed changes: {allowed}. Start a sun study and read its results. " +
      "If the results cannot be read, say so clearly and do not guess numbers. In that case only suggest geometric changes " +
      "(spacing, height steps, orientation) with your reasoning. Try at most 3 changes, undo any change that is not better, " +
      "and finish with what you changed and why.",
  },
];

export function fillPreset(p: Preset, values: Record<string, string | number>): string {
  return p.prompt.replace(/\{(\w+)\}/g, (_, k) => {
    const f = p.fields.find((x) => x.id === k);
    const v = values[k] ?? (f ? f.default : `{${k}}`);
    return String(v);
  });
}
