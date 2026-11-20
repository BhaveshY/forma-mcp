# forma-mcp

An MCP server for Autodesk Forma, covering site design and building massing. It drives the live Forma scene through the official embedded-view SDK (`forma-embedded-view-sdk` 0.96).

## Install

On Windows, give this repository link to Codex or Claude Code and say “install this,” or follow [AGENTS.md](AGENTS.md). The repository includes the built installer.

```
Codex  ──stdio── forma-mcp (hub, 127.0.0.1:8081) ──WebSocket── bridge panel inside Forma ── Forma SDK
          └── 2nd Codex session   ── forma-mcp (relay) ──┘
```

- **Fast:** tool calls go over a local WebSocket, not a cloud round trip. In the end-to-end test the MCP→hub→bridge round trip took about 0.6 ms per call, so in practice speed depends on Forma itself.
- **Few tokens:** there are 10 tools, and all their schemas together come to about 2.8k tokens. Results are TSV tables or `key: value` lines, with numbers rounded to cm. Analysis results come back as statistics, not raw grids. `forma_find` returns handles (`r1`), and later calls pass `from:"r1"` or `from:"last"` instead of copying paths.
- **Reliable:**
  - One `forma_create` or `forma_edit` call is one atomic batch and one undo step (`forma_edit {undo:1}`).
  - Writes wait until Forma has persisted them.
  - `preview:true` does a dry run.
  - A write is never retried silently. If its state is unknown, the error says so.
  - Every error ends with a `fix:` line.
  - Several Codex sessions share one hub. If the hub process exits, another session takes over, and the bridge reconnects on its own.
- **Safe:**
  - The server binds to 127.0.0.1 only.
  - The bridge socket accepts only pages that the server itself serves (the Origin header is checked).
  - Relay sessions authenticate with a token stored in `~/.forma-mcp/token`.
  - Deleting a proposal requires `confirm:true`.

## The Forma panel (no coding needed)

The panel adds the one thing Forma does not have: **an assistant that changes the design from plain language**. It does not repeat anything Forma already shows. Area metrics, selection details, design options, visibility, pictures and sun studies stay in Forma's own panels.

- **Ask in plain words** and press Enter, or pick a ready-made task (check planning rules, design report, massing options, podium and tower, fill the site, improve sunlight).
  - Runs use `codex exec` on your own Codex subscription, with `gpt-6.1-sol`, medium reasoning and the Fast tier.
  - One live line shows what the assistant is doing; the full list of steps folds away.
  - The Send button turns into **Stop** while a run is going. Follow-up messages continue the same conversation; **New chat** starts over.
- **After every change** the panel shows what changed, e.g. "Floor area +1,200 m²", and an **Undo this** button that reverses exactly that request.
- **Removals ask first:** removing anything shows **Approve / Reject**. Nothing is removed until you approve.
- **Check planning rules:** height, floors, FAR, site coverage, distance to the site boundary and distance between buildings, against limits you type in. Problem buildings turn red in the 3D view; nothing is changed. Forma has no built-in check against your own limits, so this is not a duplicate.
- **Design report:** saves an HTML page (read or print to PDF) and a CSV for Excel to `Documents\Forma MCP reports`, with key figures, floor area by use, every building on the site and, optionally, the rule check.
- **Answers are formatted:** lists, tables and bold text, each with a Copy button.
- **The conversation survives a panel reload.** Forma reloads the panel when you switch design option; the chat and a task that is still running come back, and Stop still works.
- **Failed requests show Try again.**
- **First run:** a checklist shows what is missing (helper running, Codex installed, Codex signed in) with the fix, and a Check again button.
- **Plain warnings** when something is wrong: Forma not connected, view-only access, this window outdated or showing an older version of the design, or a task running from another Forma window.
- **Update now:** when a newer release is published in the folder you installed from (for example a shared drive), the panel offers it with one button.
- **Copy diagnostics** (the ⋯ menu): one text for support with versions, connection state and the helper log. It contains no prompts, answers or design data.

To add a ready-made task, add one entry to `src/bridge/presets.ts`: a title, a short description, form fields, and a prompt with `{fieldId}` placeholders. Then rebuild. Nothing else needs to change.

The model and its settings can be changed through environment variables; see [INSTALL.md §3a](INSTALL.md).

## Tools

| Tool | What it does |
|---|---|
| `forma_status` | Start here: link, project/CRS, session kind (UDM or proposal), edit rights, counts by category |
| `forma_find` | Filtered element table: category, name, function, inside a polygon, selection. Fields: area, height, z, bbox, floors, gfa |
| `forma_read` | Details for up to 50 elements: props, footprint points, bbox, floor levels, transform |
| `forma_metrics` | GFA total and per function, site area, coverage, FAR, units, parking |
| `forma_check` | Planning-rule check: maxHeight, maxFloors, maxFar, maxCoverage (%), minSetback, minSpacing; `show:true` colours problem buildings red |
| `forma_report` | Saves an HTML + CSV design report on the user's computer and returns the file paths |
| `forma_create` | Buildings (floors, floor heights, function, podium/tower `tiers` with `inset`), masses, site limits, zones, lines, meshes |
| `forma_edit` | move/rotate, copy arrays, remove, rename, property patch; `undo:n` |
| `forma_view` | capture (image), fit/camera presets, color, color_by (height/floors/area/gfa/function), hide/isolate, sun date, overlays |
| `forma_analysis` | list, sun, noise, result stats (optionally inside a polygon or against a threshold), wind parameters |
| `forma_site` | project info, terrain elevations, pads, building functions, design options (list/switch/duplicate/delete) |
| `forma_script` | Runs JS inside Forma with the full SDK in scope, for anything the other tools don't cover |

Units are metres, m² and degrees. XY are local project coordinates, the same ones Forma uses.

## Setup

Install for Codex: follow [INSTALL.md](INSTALL.md). The short version is `npm ci; npm run release`, then run `release\forma-mcp\install.ps1`.

```sh
npm install
npm run build     # one self-contained dist/server.js (~500 KB, bridge panel embedded)
npm test          # 76 tests: geometry, sun hours, ops vs mock SDK, reconnect/takeover/half-open, MCP end-to-end,
                  # fake codex replaying recorded JSONL, approvals, the real panel DOM (typing, Enter, Stop)
```

To load the panel in Forma, install the **Forma MCP** extension in the project: App Store → gear menu → **Find extension by ID** → `b673af74-97c8-4023-9c43-9f8a105d8644`. Its left-panel view points to `http://localhost:8081/`. See [INSTALL.md §3](INSTALL.md) for giving colleagues access.

Dev helpers:

- `npm run fake-bridge` runs a mock Forma connected to the hub.
- `node scripts/call.mjs <tool> '<json>'` calls one MCP tool.
- `FORMA_MCP_ONLY_PROPOSAL=<site id or proposal name>` refuses every write unless that site or proposal is active.

## Example calls

```jsonc
forma_create {"preview":true,"items":[{"type":"building","name":"Tower A","rect":[40,20,32,24,15],
  "tiers":[{"floors":2,"floorHeight":4.5,"func":"Commercial"},{"inset":4,"floors":12,"func":"Residential"}]}]}
forma_find  {"category":"building","fields":["height","floors","gfa"]}      // -> r1
forma_edit  {"ops":[{"op":"move","from":"r1","dx":5,"rotate":10}]}
forma_edit  {"undo":2}
forma_view  {"action":"color_by","by":"height"}
forma_view  {"action":"capture","fit":"iso"}
```

## Live verification (real Forma, EU region)

These results come from a demo site in a sandbox. It used site id `pro_g8borswh8t` and ran as a legacy proposal session. Writes were locked to that site.

| Check | Result |
|---|---|
| Panel loads from `localhost:8081` inside Forma; status line; auto-reconnect after a hub restart and after a tab reload | ✅ |
| Building placement: created buildings land at the given XY. z comes from terrain, floors and functions are applied, and podium/tower insets work. | ✅ exact bbox match |
| Move and rotate about the bbox centre | ✅ matches the computed result to 0.1 m |
| Zone and line from inline GeoJSON at the given local XY | ✅ Forma stores the geometry on child `…/0`; reads fall back to it |
| Floors and GFA of native buildings | ✅ via `floor` children and Forma's area metrics |
| Footprint of native buildings (Forma gives none) | ✅ traced exactly from the base of the 3D shape: all 5 site buildings within 0.1 m² of Forma's own figure |
| Floor area, FAR, coverage | ✅ 13,331 m², 3.07, 47%: identical to Forma's BTA (307%) and BYA, counting only buildings inside the site boundary |
| Undo of create, then move, then undo ×2 | ✅ after a fix: stale paths are re-resolved by URN |
| Write guard blocks writes to any other site | ✅ |
| Sun analysis: trigger, list and status | ✅ |
| Sun-hours numbers | ✅ Forma keeps its live sun-hours grid to itself ("No texture metadata"), so forma-mcp computes sun hours from the 3D buildings and terrain: about 0.35 s, shown on the ground. `result` falls back to the same calculation. |
| Typed request in the panel | ✅ "Which building has the most floor area?" → "Building 1, 4,314.6 m²" (Forma: 4,315 m²) in 14 s |
| Panel Assistant: "Podium and tower" preset built by Codex (gpt-6.1-sol, medium, Fast) | ✅ in about 2 min |
| Panel Assistant: Reject on "Remove 1 element" | ✅ nothing removed; Codex reverted its preview and asked before going on |
| Codex CLI end-to-end, 14 steps including undo | ✅ |
| Typical latency | status ~200 ms · find ~60–270 ms · create ~1 s · edit ~0.5 s · capture ~0.3 s |

## Notes and limits (from live testing)

- **Live end-to-end test:** `node scripts/e2e-live.mjs` runs every feature against a real Forma window inside a temporary copy of the design option, checks each result and writes `e2e-report.md`. Last full run on the demo site: **24 of 24 checks passed**, and the original design option was verified unchanged afterwards (see `e2e-report.md`).
- **Building Design buildings** (made with Forma's Building Design tool) cannot be changed by forma-mcp. Forma rebuilds them from its own editor and shares them across design options. The assistant says so and points the user to that editor; nothing is changed.
- **Several Forma windows on one site:** the window you last clicked in is used. A panel's assistant task stays in its own window. A window showing an older version of the design refuses to make changes and asks for a reload. Best practice: keep one Forma tab per site open.
- **After an update**, an already-open panel shows "A newer version of Forma MCP is installed — reload this Forma tab" and cannot make changes until reloaded.
- **Not saved = not done:** if Forma does not confirm that a change was saved, the result says so.
- **Custom properties** must use a namespace such as `office:tags` (Forma's rule).
- **Sun hours** in the panel and `forma_analysis sun_hours` are calculated by forma-mcp from the 3D buildings and terrain in 15-minute steps. Trees are not counted as shading. Forma's own sun study is still available under Analyze.
- **Browser automation** tools cannot type into the panel (Forma's cross-origin frame). Typing with a real keyboard works; `test/panel.dom.test.ts` covers it.

### Live checks of the assistant

- Codex (gpt-6.1-sol, medium, Fast) asked to add 6 floors to a Building Design building: made no change and told the user to use Forma's Building Design editor.
- Typed question in the panel: "Which building has the most floor area?" → Building 1, 4,314.6 m² (Forma: 4,315 m²).
- "Podium and tower" ready-made task built correctly; Reject on "Remove 1 element" removed nothing.
