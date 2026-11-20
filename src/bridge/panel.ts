// The Forma MCP panel: only what Forma itself does not have — an assistant that changes the
// design from plain language. Area metrics, selection details, design options, visibility,
// pictures and sun studies are Forma's own panels; we do not duplicate them here.
import { PRESETS, fillPreset, type Preset } from "./presets.js";
import { describeChange, toNumbers, type AiEvent, type AiStatus, type Numbers, type PanelController } from "./controller.js";
import { markdown } from "./md.js";

type Kids = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

// Static icon markup (never user data).
const ICON: Record<string, string> = {
  send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
};
const icon = (name: string) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICON[name];
  return s;
};

const errText = (e: unknown) => {
  const x = e as { message?: string; fix?: string };
  return { text: x?.message ?? String(e), fix: x?.fix };
};

/** Copy text; falls back to a hidden textarea when the Clipboard API is blocked inside Forma's frame. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0;top:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* blocked */ }
    ta.remove();
    return ok;
  }
}

const EXAMPLES = [
  "Add a 6-storey residential block in the free corner of the site.",
  "Check the design: max height 25 m, FAR 2.0, at least 5 m from the site boundary.",
  "Make the tallest Site Design building 3 floors lower.",
];

export type KvLike = { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void };
type WorkEntry = { k: "work"; status: "done" | "bad" | "stopped"; text: string; secs: number; steps: string[]; fix?: string };
type DeltaEntry = { k: "delta"; items: string[]; undone?: boolean };
type Entry = { k: "me"; text: string } | { k: "ai"; text: string } | WorkEntry | DeltaEntry | { k: "note"; text: string };
const CHAT_KEY = "fmcp:chat";
const MAX_ENTRIES = 120;

export type Setup = { connected: boolean; ai?: AiStatus; aiError?: string };

export function mountPanel(root: HTMLElement, ctrl: PanelController, opts: { store?: KvLike } = {}) {
  // ---------- saved conversation (survives a panel reload, e.g. when Forma switches design option) ----------
  let entries: Entry[] = [];
  const save = () => {
    if (!opts.store) return;
    try { opts.store.set(CHAT_KEY, JSON.stringify({ v: 1, threadId: ctrl.threadId, entries: entries.slice(-MAX_ENTRIES) })); } catch { /* storage full or blocked */ }
  };
  const record = <E extends Entry>(e: E): E => { entries.push(e); save(); return e; };

  // ---------- header: connection ----------
  const dot = h("span", { class: "dot" });
  const conn = h("span", { class: "conn" }, "Starting…");
  const moreBtn = h("button", { class: "ibtn", title: "Connection details and help", "aria-label": "Connection details and help" }, icon("more"));
  moreBtn.addEventListener("click", () => { const m = document.getElementById("more"); if (m) m.hidden = !m.hidden; });
  const header = h("header", {}, h("div", { class: "hrow" }, dot, conn, h("span", { class: "grow" }), moreBtn));
  const banners = h("div", { class: "banners" });

  // ---------- feed ----------
  const feed = h("main", { class: "feed", "aria-live": "polite" });
  const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  const push = (el: HTMLElement) => {
    const stick = atBottom() || feed.childElementCount < 2;
    feed.querySelector(".welcome")?.remove();
    feed.append(el);
    if (stick) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
    return el;
  };
  const keepDown = () => { if (atBottom()) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight)); };

  function welcome() {
    feed.append(h("div", { class: "welcome" },
      h("p", {}, h("b", {}, "Describe what you want"), " and the assistant changes the design for you, checks it against your planning limits, or writes a report. Every change can be undone."),
      h("div", { class: "examples" }, ...EXAMPLES.map((t) => h("button", { class: "ex", onclick: () => { input.value = t; grow(); input.focus(); } }, t)))));
  }

  // ---------- composer ----------
  const chips = h("div", { class: "chips" }, ...PRESETS.map((p) => h("button", { class: "chip", title: p.blurb, onclick: () => openPreset(p) }, p.title)));
  const input = h("textarea", { rows: 1, placeholder: "Ask anything…", "aria-label": "Message to the assistant", maxlength: 8000 });
  const sendBtn = h("button", { class: "send", title: "Send (Enter)", "aria-label": "Send" }, icon("send"));
  const newBtn = h("button", { class: "newchat", title: "Start a new conversation", hidden: true }, icon("plus"), "New chat");
  const setupBox = h("div", { class: "setup", hidden: true });
  const composer = h("footer", {}, setupBox, chips, h("div", { class: "box" }, input, sendBtn), newBtn);
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void submit(input.value.trim()); }
  });
  sendBtn.addEventListener("click", () => (ctrl.busy ? ctrl.stop() : void submit(input.value.trim())));
  newBtn.addEventListener("click", () => {
    if (ctrl.busy) return;
    ctrl.newConversation();
    entries = [];
    save();
    feed.replaceChildren();
    welcome();
    newBtn.hidden = true;
  });

  root.append(header, banners, feed, composer);

  // ---------- setup checklist (first run, signed out, helper not running) ----------
  const setup: Setup = { connected: false };
  let aiReady = false;
  function renderSetup() {
    const s = setup;
    const items: [boolean | undefined, string, string?][] = [
      [s.connected, "Forma MCP helper is running on this computer", s.connected ? undefined : "Start Codex once, or run install.cmd again (it starts the helper at login)."],
      [s.ai ? s.ai.installed : s.aiError ? false : undefined, "Codex is installed", s.ai && !s.ai.installed ? s.ai.fix : s.aiError],
      [s.ai?.installed ? s.ai.loggedIn : undefined, "Codex is signed in to your ChatGPT account", s.ai?.installed && !s.ai.loggedIn ? s.ai.fix : undefined],
    ];
    aiReady = !!(s.connected && s.ai?.installed && s.ai?.loggedIn);
    setupBox.hidden = aiReady;
    if (aiReady) return;
    const firstFix = items.find(([ok]) => ok === false)?.[2];
    setupBox.replaceChildren(
      h("div", { class: "ctitle" }, "Before the assistant can help"),
      h("ul", { class: "checks" }, ...items.map(([ok, label]) => h("li", { class: ok === true ? "ok" : ok === false ? "no" : "wait" }, h("span", { class: "mark" }, ok === true ? "✓" : ok === false ? "✕" : "…"), label))),
      firstFix ? h("div", { class: "mut" }, firstFix) : "",
      h("button", { class: "btn", onclick: () => void refreshAi(true) }, "Check again"),
    );
  }
  async function refreshAi(flash = false) {
    if (setup.connected) {
      try {
        setup.ai = await ctrl.checkAi();
        setup.aiError = undefined;
      } catch (e) {
        setup.ai = undefined;
        setup.aiError = errText(e).fix ?? errText(e).text;
      }
    }
    renderSetup();
    if (flash && !aiReady) { setupBox.classList.remove("flash"); void setupBox.offsetWidth; setupBox.classList.add("flash"); }
    return aiReady;
  }

  function openPreset(p: Preset) {
    feed.querySelector(".preset-form")?.remove();
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const form = h("form", { class: "card preset-form" }, h("div", { class: "ctitle" }, p.title), h("div", { class: "mut" }, p.blurb));
    for (const f of p.fields) {
      const el = f.type === "select"
        ? h("select", {}, ...f.options.map((o) => h("option", { value: o, selected: o === f.default }, o)))
        : h("input", { type: f.type === "number" ? "number" : "text", value: String(f.default), ...(f.type === "number" ? { min: f.min, max: f.max, step: f.step ?? 1 } : {}) });
      inputs.set(f.id, el);
      form.append(h("label", { class: f.type === "select" ? "wide" : "" }, h("span", {}, f.label + (f.type === "number" && f.unit ? ` (${f.unit})` : "")), el));
    }
    form.append(h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Start"), h("button", { class: "btn", type: "button", onclick: () => form.remove() }, "Cancel")));
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const vals: Record<string, string | number> = {};
      for (const f of p.fields) {
        const v = inputs.get(f.id)!.value;
        vals[f.id] = f.type === "number" ? Number(v) : v;
      }
      form.remove();
      void submit(fillPreset(p, vals), p.title);
    });
    push(form);
    requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
  }

  // ---------- renderers (shared by live runs and the restored conversation) ----------
  const meEl = (text: string) => h("div", { class: "msg me" }, text);
  function aiEl(text: string) {
    const copy = h("button", { class: "copy", title: "Copy answer", "aria-label": "Copy answer" }, icon("copy"));
    copy.addEventListener("click", async () => { copy.classList.toggle("done", await copyText(text)); });
    return h("div", { class: "msg ai" }, h("div", { class: "md" }, ...markdown(text)), copy);
  }
  function finishedWorkEl(e: WorkEntry) {
    const steps = h("ol", { class: "steps", hidden: true }, ...e.steps.map((s) => h("li", {}, s)));
    const toggle = h("button", { class: "link", onclick: () => { steps.hidden = !steps.hidden; } }, `${e.secs} s · ${e.steps.length} steps`);
    const w = h("div", { class: `work finished${e.status === "done" ? "" : " bad"}` },
      h("div", { class: "wrow" }, e.status === "done" ? icon("check") : h("span", { class: "x" }, "!"), h("span", {}, e.text), h("span", { class: "grow" }), toggle), steps);
    if (e.fix) w.append(h("div", { class: "fix" }, e.fix));
    return w;
  }
  const deltaEl = (items: string[], note?: string) => h("div", { class: "delta" }, ...items.map((t) => h("span", {}, t)), note ? h("span", { class: "undone" }, note) : "");

  function restore() {
    if (!opts.store) return false;
    let saved: { v?: number; threadId?: string; entries?: Entry[] } | undefined;
    try { saved = JSON.parse(opts.store.get(CHAT_KEY) ?? "null") ?? undefined; } catch { saved = undefined; }
    if (!saved?.entries?.length) return false;
    entries = saved.entries;
    if (saved.threadId) ctrl.threadId = saved.threadId;
    for (const e of entries) {
      if (e.k === "me") feed.append(meEl(e.text));
      else if (e.k === "ai") feed.append(aiEl(e.text));
      else if (e.k === "work") feed.append(finishedWorkEl(e));
      else if (e.k === "delta") feed.append(deltaEl(e.items, e.undone ? "Undone" : undefined));
      else if (e.k === "note") feed.append(h("div", { class: "note mut" }, e.text));
    }
    newBtn.hidden = false;
    requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
    return true;
  }
  if (!restore()) welcome();

  const setBusy = (busy: boolean) => {
    sendBtn.replaceChildren(icon(busy ? "stop" : "send"));
    sendBtn.title = busy ? "Stop" : "Send (Enter)";
    sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
    sendBtn.classList.toggle("stop", busy);
    chips.classList.toggle("off", busy);
  };

  /** Area numbers and the assistant's undo depth, to report what a run changed and undo exactly that run. */
  async function snapshot(): Promise<{ n?: Numbers; undo: number }> {
    const [m, st] = await Promise.all([ctrl.direct("metrics").catch(() => undefined), ctrl.direct("status").catch(() => undefined)]);
    return { n: m ? toNumbers(m) : undefined, undo: Number(st?.undo) || 0 };
  }

  const openApprovals: (() => void)[] = [];

  /** Show one running task: live step line, answers, end state, what changed + Undo, Try again. */
  function track(o: { start: (on: (e: AiEvent) => void) => void; before?: { n?: Numbers; undo: number }; startedAt?: number; steps?: string[]; retry?: () => void }) {
    setBusy(true);
    newBtn.hidden = false;
    const t0 = o.startedAt ?? Date.now();
    const stepList: string[] = [...(o.steps ?? [])];
    const now = h("span", {}, stepList.at(-1) ?? "Starting…");
    const steps = h("ol", { class: "steps" }, ...stepList.map((s) => h("li", {}, s)));
    const toggle = h("button", { class: "link", hidden: !stepList.length, onclick: () => { steps.hidden = !steps.hidden; } }, "");
    steps.hidden = true;
    const work = push(h("div", { class: "work" }, h("div", { class: "wrow" }, h("span", { class: "spin" }), now, h("span", { class: "grow" }), toggle), steps));
    const secs = () => Math.round((Date.now() - t0) / 1000);
    const timer = setInterval(() => (toggle.textContent = `${secs()} s · ${stepList.length} steps`), 1000);
    const finish = async () => {
      if (!o.before) return keepDown();
      const after = await snapshot();
      const changed = o.before.n && after.n ? describeChange(o.before.n, after.n) : [];
      const made = Math.max(0, after.undo - o.before.undo);
      if (changed.length || made) {
        const entry = record<DeltaEntry>({ k: "delta", items: changed });
        const row = deltaEl(changed);
        if (made) {
          const undo = h("button", { class: "undo", title: "Undo everything this request changed" }, icon("undo"), "Undo this");
          undo.addEventListener("click", async () => {
            undo.disabled = true;
            try {
              await ctrl.direct("undo", { steps: made });
              row.replaceChildren(h("span", { class: "undone" }, "Undone — the design is back as before this request."));
              entry.undone = true;
              save();
            } catch (e) {
              undo.disabled = false;
              row.append(h("div", { class: "fix" }, errText(e).text));
            }
          });
          row.append(undo);
        }
        work.after(row);
      }
      keepDown();
    };
    const onEvent = (e: AiEvent) => {
      if (e.kind === "step") {
        if (e.text === stepList.at(-1)) return;
        stepList.push(e.text);
        now.textContent = e.text;
        steps.append(h("li", {}, e.text));
        toggle.hidden = false;
        keepDown();
        return;
      }
      if (e.kind === "say") {
        work.before(aiEl(e.text));
        record({ k: "ai", text: e.text });
        keepDown();
        return;
      }
      clearInterval(timer);
      setBusy(false);
      for (const close of openApprovals.splice(0)) close();
      work.classList.add("finished");
      work.querySelector(".spin")?.replaceWith(e.kind === "done" ? icon("check") : h("span", { class: "x" }, "!"));
      toggle.hidden = false;
      toggle.textContent = `${secs()} s · ${stepList.length} steps`;
      const status = e.kind === "done" ? "done" : e.kind === "cancelled" ? "stopped" : "bad";
      const text = e.kind === "done" ? "Done" : e.kind === "cancelled" ? "Stopped." : e.text;
      now.textContent = text;
      if (status !== "done") work.classList.add("bad");
      if (e.kind === "error" && e.fix) work.append(h("div", { class: "fix" }, e.fix));
      if (status !== "done" && o.retry) {
        const again = h("button", { class: "retry" }, icon("retry"), "Try again");
        again.addEventListener("click", () => { again.remove(); o.retry!(); });
        work.append(again);
      }
      record<WorkEntry>({ k: "work", status, text, secs: secs(), steps: stepList, fix: e.kind === "error" ? e.fix : undefined });
      if (e.kind === "error" && /sign|log ?in|install/i.test(`${e.text} ${e.fix ?? ""}`)) void refreshAi();
      void finish();
    };
    try {
      o.start(onEvent);
    } catch (e) {
      onEvent({ kind: "error", text: errText(e).text, fix: errText(e).fix });
    }
  }

  async function submit(prompt: string, title?: string) {
    if (!prompt || ctrl.busy) return;
    if (!aiReady && !(await refreshAi(true))) return;
    push(meEl(title ?? prompt));
    record({ k: "me", text: title ?? prompt });
    input.value = "";
    grow();
    setBusy(true);
    const before = await snapshot();
    track({ before, start: (on) => ctrl.ask(prompt, on, title), retry: () => void submit(prompt, title) });
  }

  return {
    askApproval(title: string, detail?: string): Promise<boolean> {
      return new Promise((resolve) => {
        const box = h("div", { class: "card approve" }, h("div", { class: "ctitle" }, "The assistant asks"), h("div", {}, title), detail ? h("div", { class: "mut" }, detail) : null);
        let answered = false;
        const done = (ok: boolean, note = ok ? "Approved." : "Rejected — nothing was changed.") => {
          if (answered) return;
          answered = true;
          box.querySelector(".row")?.remove();
          box.classList.add(ok ? "yes" : "no");
          box.append(h("div", { class: "mut" }, note));
          record({ k: "note", text: `${title}: ${note}` });
          resolve(ok);
        };
        openApprovals.push(() => done(false, "The task ended before you answered — nothing was done."));
        box.append(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => done(true) }, "Approve"), h("button", { class: "btn danger", onclick: () => done(false) }, "Reject")));
        const works = feed.querySelectorAll(".work:not(.finished)");
        const work = works[works.length - 1];
        if (work) work.before(box); else push(box);
        box.scrollIntoView({ block: "nearest" });
      });
    },
    /** A task this window started was still running when the panel (re)loaded: show it live, allow Stop. */
    resume(runId: string, prompt: string, steps: string[], startedAt: number) {
      if (ctrl.busy) return;
      const kinds = entries.map((e) => e.k);
      if (kinds.lastIndexOf("me") <= kinds.lastIndexOf("work")) { push(meEl(prompt)); record({ k: "me", text: prompt }); }
      track({ startedAt, steps, start: (on) => ctrl.attach(runId, on) });
    },
    /** Another Forma window's task is running: say so instead of failing on Send. */
    busyElsewhere(running: boolean) {
      const el = document.getElementById("elsewhere");
      if (running && !el) banners.append(h("div", { id: "elsewhere", class: "card note" }, "The assistant is working on a task from another Forma window. You can send a request when it is done."));
      else if (!running) el?.remove();
    },
    /** Connection state from the bridge client. */
    setConnection(state: string, text: string) {
      dot.className = `dot ${state}`;
      conn.textContent = state === "connected" ? text : state === "reconnecting" ? "Reconnecting…" : "Not connected";
      conn.title = text;
      document.body.classList.toggle("offline", state !== "connected");
      let banner = document.getElementById("offline");
      if (state === "waiting") {
        if (!banner) banner = banners.appendChild(h("div", { id: "offline", class: "card bad" }, ""));
        banner.textContent = text;
      } else banner?.remove();
      setup.connected = state === "connected";
      void refreshAi();
    },
    /** The selection only shapes the hint; Forma shows the selected building's details itself. */
    setSelection(paths: string[]) {
      input.placeholder = paths.length === 1 ? "Ask about the selected building…" : paths.length > 1 ? "Ask about the selection…" : "Ask anything…";
    },
    /** View-only access: the assistant can still answer and check, but cannot change the design. */
    setCanEdit(canEdit: boolean | undefined) {
      const el = document.getElementById("viewonly");
      if (canEdit === false && !el) banners.append(h("div", { id: "viewonly", class: "card note" }, h("b", {}, "View only."), " You can ask questions, check rules and make reports, but changes need edit rights on this design option."));
      else if (canEdit !== false) el?.remove();
    },
    /** A newer forma-mcp is installed: this panel's code is old and must not be used for changes. */
    setOutdated() {
      if (document.getElementById("outdated")) return;
      document.getElementById("update")?.remove();
      banners.prepend(h("div", { id: "outdated", class: "card bad" }, h("b", {}, "A newer version of Forma MCP is installed."), " Reload this Forma tab (F5) and open the panel again. Until then the panel can only read, not change the design."));
    },
    /** A newer release is published in the shared install folder. */
    setUpdate(version: string, run: () => void) {
      if (document.getElementById("update") || document.getElementById("outdated")) return;
      const btn = h("button", { class: "btn primary" }, "Update now");
      const box = h("div", { id: "update", class: "card note" }, h("b", {}, `Forma MCP ${version} is available.`), " ", btn);
      btn.addEventListener("click", () => {
        btn.disabled = true;
        run();
        box.replaceChildren(h("span", { class: "spin" }), "Updating… when it is done, this panel asks you to reload the tab.");
      });
      banners.append(box);
    },
    modelChanged() {},
    refresh() {},
  };
}
