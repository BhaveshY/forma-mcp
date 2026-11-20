// Runs inside the Forma embedded view: connection to the local hub + the visual panel.
import { Forma } from "forma-embedded-view-sdk/auto";
import { Ops } from "./ops.js";
import { BridgeClient, browserStore, type WsLike } from "./client.js";
import { PanelController, type AiEvent, type AiLike, type AiStatus } from "./controller.js";
import { mountPanel, copyText } from "./panel.js";
import type { Msg } from "../shared/protocol.js";

declare const __BUILD__: string | undefined;
const BUILD = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";
const ops = new Ops(Forma, logLine);
const $ = (id: string) => document.getElementById(id)!;
const log: string[] = [];
let panel: ReturnType<typeof mountPanel> | undefined;
let lastState: { state: string; text: string } | undefined;

function logLine(line: string) {
  log.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
  log.length = Math.min(log.length, 20);
  $("log").textContent = log.join("\n");
}

// Stable id for this browser tab (survives reloads), so a task stays in the window that started it.
const tabId = (() => {
  try {
    let id = sessionStorage.getItem("fmcp:tab");
    if (!id) { id = Math.random().toString(36).slice(2, 12); sessionStorage.setItem("fmcp:tab", id); }
    return id;
  } catch { return Math.random().toString(36).slice(2, 12); }
})();
let lastFocus = 0;
/** Tell the hub the user is working in this Forma window (throttled). */
const markActive = () => {
  if (Date.now() - lastFocus < 1500) return;
  lastFocus = Date.now();
  if (client?.connected) client.push({ t: "focus" } satisfies Msg);
};

function info(reset = false) {
  return ops.runInOrder(async () => {
    if (reset) ops.resetSession();
    const [canEdit, project, proposalId] = await Promise.all([
      ops.editAccess(),
      Forma.project.get().catch(() => undefined),
      Forma.proposal.getId().catch(() => undefined),
    ]);
    return { projectId: Forma.getProjectId(), projectName: project?.name, proposalId, region: Forma.getRegion(), canEdit, sdk: "0.96", tabId, build: BUILD };
  });
}

// ---- assistant transport: the hub runs `codex exec` on the user's subscription ----
const waiters = new Map<string, (s: AiStatus) => void>();
const listeners = new Map<string, (e: AiEvent) => void>();
const uid = () => Math.random().toString(36).slice(2, 10);

const ai: AiLike = {
  check: () =>
    new Promise((resolve, reject) => {
      if (!client.connected) return reject(new Error("Not connected — start a Codex chat or the background hub (see INSTALL.md)."));
      const id = uid();
      const t = setTimeout(() => { waiters.delete(id); reject(new Error("No answer from the local hub.")); }, 20000);
      waiters.set(id, (s) => { clearTimeout(t); resolve(s); });
      client.push({ t: "ai.check", id });
    }),
  run: (prompt, threadId, onEvent, title) => {
    const runId = uid();
    listeners.set(runId, (e) => {
      if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") listeners.delete(runId);
      onEvent(e);
    });
    if (!client.connected) onEvent({ kind: "error", text: "Not connected to the local hub.", fix: "Open a Codex chat or start the background hub (see INSTALL.md)." });
    else client.push({ t: "ai.run", runId, prompt, threadId, title } satisfies Msg);
    return { cancel: () => client.push({ t: "ai.cancel", runId }) };
  },
  attach: (runId, onEvent) => {
    listeners.set(runId, (e) => {
      if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") listeners.delete(runId);
      onEvent(e);
    });
    return { cancel: () => client.push({ t: "ai.cancel", runId }) };
  },
};
const diagWaiters = new Map<string, (text: string) => void>();
let elsewhereRun: string | undefined;

const client = new BridgeClient({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/bridge`,
  connect: (url) => new WebSocket(url) as unknown as WsLike,
  // Requests from Codex (via the hub). "ui.approve" asks the person in this panel.
  run: async (op, args) => {
    if (op === "ui.approve") {
      const ok = panel ? await panel.askApproval(String(args.title ?? "Approve this step?"), args.detail as string | undefined) : false;
      return { approved: ok };
    }
    return ops.run(op, args);
  },
  info: async () => {
    const i = await info(true);
    panel?.setCanEdit(i.canEdit);
    return i;
  },
  store: browserStore(),
  onState: ({ state, text }) => {
    lastState = { state, text };
    panel?.setConnection(state, text);
    $("count").textContent = String(client?.stats.served ?? 0);
  },
  onLog: logLine,
  onMessage: (m) => {
    if (m.t === "ai.status") waiters.get(m.id)?.(m.status), waiters.delete(m.id);
    else if (m.t === "ai.event") {
      listeners.get(m.runId)?.(m.ev as AiEvent);
      if (m.runId === elsewhereRun && ["done", "error", "cancelled"].includes(m.ev.kind)) { elsewhereRun = undefined; panel?.busyElsewhere(false); }
    } else if (m.t === "ai.active") {
      // The panel was reloaded (e.g. Forma switched design option) while a task ran.
      if (listeners.has(m.runId)) return;
      if (!m.tab || m.tab === tabId) panel?.resume(m.runId, m.prompt, m.steps, m.startedAt);
      else { elsewhereRun = m.runId; panel?.busyElsewhere(true); }
    } else if (m.t === "diag.res") diagWaiters.get(m.id)?.(m.text), diagWaiters.delete(m.id);
    else if (m.t === "update") panel?.setUpdate(m.version, () => client.push({ t: "update.run" } satisfies Msg));
    else if (m.t === "outdated") panel?.setOutdated();
  },
});
client.start();

// One-click tools call Forma directly in this panel (instant, no Codex).
const ctrl = new PanelController({ run: (op, args) => ops.run(op, args ?? {}) }, ai);
panel = mountPanel($("app"), ctrl, { store: sessionKv() });
info().then((i) => panel?.setCanEdit(i.canEdit)).catch(() => {});
if (lastState) panel.setConnection(lastState.state, lastState.text);

// Live panel: numbers follow every design change, the selection line follows clicks in Forma.
Forma.selection.subscribe(({ paths }) => { markActive(); panel?.setSelection(paths); }).catch(() => {});
for (const ev of ["pointerdown", "keydown", "focus"]) addEventListener(ev, markActive, { capture: true });
Forma.selection.getSelection().then((p) => panel?.setSelection(p)).catch(() => {});
Forma.proposal.subscribe(() => panel?.modelChanged(), { debouncedPersistedOnly: true }).catch(() => {});
Forma.udm.subscribe(({ rootUrn }) => ops.observeRevision(rootUrn)).catch(() => {});

addEventListener("online", () => client.nudge());
addEventListener("focus", () => client.nudge());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && client.nudge());

Forma.udm.subscribe(async () => {
  panel?.modelChanged();
  const i = await info();
  panel?.setCanEdit(i.canEdit);
  client.push({ t: "info", info: i } satisfies Msg);
}, { debouncedPersistedOnly: true }).catch(() => {});

/** Panel-local storage for the conversation; survives reloads of this tab only. */
function sessionKv() {
  try {
    const s = window.sessionStorage;
    s.getItem("fmcp:probe");
    return { get: (k: string) => s.getItem(k), set: (k: string, v: string) => s.setItem(k, v), remove: (k: string) => s.removeItem(k) };
  } catch { return undefined; }
}

// Support: one text with versions, connection state and the helper log (no prompts or design data).
$("diag").addEventListener("click", async () => {
  const btn = $("diag") as HTMLButtonElement;
  const panelPart = [`panel build ${BUILD} · tab ${tabId} · ${navigator.userAgent}`, `connection: ${lastState?.state ?? "?"} – ${lastState?.text ?? ""}`, `requests served: ${client.stats.served} · reconnects: ${client.stats.connects}`, "--- panel log ---", ...log].join("\n");
  let hubPart = "(helper not connected)";
  if (client.connected) {
    const id = uid();
    hubPart = await new Promise<string>((res) => {
      const t = setTimeout(() => { diagWaiters.delete(id); res("(no answer from the helper)"); }, 15000);
      diagWaiters.set(id, (text) => { clearTimeout(t); res(text); });
      client.push({ t: "diag", id } satisfies Msg);
    });
  }
  const text = `${hubPart}\n--- panel ---\n${panelPart}`;
  $("log").textContent = text;
  btn.textContent = (await copyText(text)) ? "Copied — paste it into your message to support" : "Shown below — select and copy it";
  setTimeout(() => (btn.textContent = "Copy diagnostics"), 4000);
});

$("pop").addEventListener("click", async () => {
  try {
    await Forma.openFloatingPanel({
      embeddedViewId: "forma-mcp-floating",
      url: location.href.split("?")[0] + "?floating=1",
      title: "Forma MCP",
      preferredSize: { width: 340, height: 640 },
      placement: { type: "right", offsetTop: 80 },
    });
  } catch (e) {
    log.unshift(`Pop out is not available here: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    $("log").textContent = log.join("\n");
  }
});
