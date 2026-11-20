// @vitest-environment happy-dom
// The real panel DOM: typing + Enter, Stop, approvals, "what changed" + Undo this — and nothing that
// duplicates Forma's own panels.
import { beforeEach, describe, expect, it } from "vitest";
import { mountPanel } from "../src/bridge/panel.js";
import { PanelController, type AiEvent, type AiLike } from "../src/bridge/controller.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !fn(); t += 10) await tick(10);
  expect(fn()).toBe(true);
}

let gfa = 1000, undoDepth = 0;
const undoCalls: number[] = [];
const memStore = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k) }; };
function setup(o: { store?: ReturnType<typeof memStore>; check?: AiLike["check"] } = {}) {
  document.body.innerHTML = '<div id="app"></div><div id="more" hidden></div>';
  const prompts: string[] = [];
  let emit: (e: AiEvent) => void = () => {};
  let cancelled = 0;
  const attached: string[] = [];
  const ai: AiLike = {
    check: o.check ?? (async () => ({ installed: true, loggedIn: true, version: "codex-cli 0.167.1", text: "" })),
    run: (p, _t, on) => { prompts.push(p); emit = on; return { cancel: () => { cancelled++; on({ kind: "cancelled", text: "Stopped." }); } }; },
    attach: (id, on) => { attached.push(id); emit = on; return { cancel: () => { cancelled++; on({ kind: "cancelled", text: "Stopped." }); } }; },
  };
  const ops = {
    run: async (op: string, a: any = {}) => {
      if (op === "metrics") return { gfa_m2: gfa, far: gfa / 1000, coverage: "30%", site_area_m2: 1000 };
      if (op === "status") return { undo: undoDepth };
      if (op === "undo") { undoCalls.push(a.steps); undoDepth -= a.steps; gfa = 1000; return { undone: ["x"] }; }
      return {};
    },
  };
  const ctrl = new PanelController(ops, ai);
  const panel = mountPanel(document.getElementById("app")!, ctrl, { store: o.store });
  panel.setConnection("connected", "Connected");
  const $ = <T extends Element>(s: string) => document.querySelector(s) as unknown as T;
  return { panel, ctrl, prompts, attached, emit: (e: AiEvent) => emit(e), cancelled: () => cancelled, $ };
}

beforeEach(() => { gfa = 1000; undoDepth = 0; undoCalls.length = 0; });

describe("panel (real DOM)", () => {
  it("only the assistant: no numbers, tools or design-option switcher (Forma has those)", () => {
    const { $ } = setup();
    expect($(".stats")).toBeNull();
    expect($(".tools")).toBeNull();
    expect($("select.opt")).toBeNull();
    expect($("textarea")).not.toBeNull();
  });

  it("typing + Enter sends the text; Shift+Enter does not", async () => {
    const { prompts, $ } = setup();
    const box = $<HTMLTextAreaElement>("textarea");
    box.value = "Add a 6-storey block";
    box.dispatchEvent(new Event("input"));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await tick(20);
    expect(prompts).toEqual([]);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => prompts.length === 1);
    expect(prompts[0]).toBe("Add a 6-storey block");
    expect(box.value).toBe("");
    expect($(".msg.me")!.textContent).toBe("Add a 6-storey block");
  });

  it("live progress, the answer, what changed, and 'Undo this' reverts exactly that request", async () => {
    const { prompts, emit, $ } = setup();
    $<HTMLTextAreaElement>("textarea").value = "add a block";
    $<HTMLButtonElement>(".send").click();
    await until(() => prompts.length === 1);
    expect($(".send")!.classList.contains("stop")).toBe(true);
    emit({ kind: "step", text: "Placing 1 building…" });
    expect($(".work .wrow")!.textContent).toContain("Placing 1 building…");
    gfa = 2200; undoDepth = 2; // the run made two undoable changes
    emit({ kind: "say", text: "Added **Block C**." });
    emit({ kind: "done", text: "Added Block C.", threadId: "T1" });
    await until(() => !!$(".delta .undo"));
    expect($(".msg.ai b")!.textContent).toBe("Block C");
    expect($(".delta")!.textContent).toContain("Floor area +1,200 m²");
    $<HTMLButtonElement>(".delta .undo").click();
    await until(() => !!$(".undone"));
    expect(undoCalls).toEqual([2]);
    expect($(".send")!.classList.contains("stop")).toBe(false);
  });

  it("a question that changes nothing shows no undo", async () => {
    const { prompts, emit, $ } = setup();
    $<HTMLTextAreaElement>("textarea").value = "how big is it?";
    $<HTMLButtonElement>(".send").click();
    await until(() => prompts.length === 1);
    emit({ kind: "done", text: "4,315 m²." });
    await tick(50);
    expect($(".delta")).toBeNull();
  });

  it("Stop cancels the run", async () => {
    const { prompts, cancelled, $ } = setup();
    $<HTMLTextAreaElement>("textarea").value = "long task";
    $<HTMLButtonElement>(".send").click();
    await until(() => prompts.length === 1);
    $<HTMLButtonElement>(".send").click();
    expect(cancelled()).toBe(1);
    expect($(".work")!.textContent).toContain("Stopped");
  });

  it("approval card: Reject resolves false and the buttons go away", async () => {
    const { panel, $ } = setup();
    const p = panel.askApproval("Remove 1 element from the design", "You can undo this afterwards.");
    const reject = Array.from(document.querySelectorAll(".approve button")).find((b) => b.textContent === "Reject") as HTMLButtonElement;
    reject.click();
    expect(await p).toBe(false);
    expect(document.querySelectorAll(".approve button").length).toBe(0);
    expect($(".approve")!.textContent).toContain("nothing was changed");
  });

  it("selection only changes the hint; offline and outdated show plain banners", () => {
    const { panel, $ } = setup();
    panel.setSelection(["root/a"]);
    expect($<HTMLTextAreaElement>("textarea").placeholder).toBe("Ask about the selected building…");
    panel.setConnection("waiting", "Not connected yet — open Codex.");
    expect($("#offline")!.textContent).toBe("Not connected yet — open Codex.");
    panel.setConnection("connected", "Connected");
    expect($("#offline")).toBeNull();
    panel.setOutdated();
    expect($("#outdated")!.textContent).toMatch(/Reload this Forma tab/);
  });

  it("answers are formatted (lists, tables, bold) and model text can never inject HTML", async () => {
    const { prompts, emit, $ } = setup();
    $<HTMLTextAreaElement>("textarea").value = "compare";
    $<HTMLButtonElement>(".send").click();
    await until(() => prompts.length === 1);
    emit({ kind: "say", text: "Two options:\n\n- **A** tall\n- B <img src=x onerror=alert(1)>\n\n| Option | GFA |\n|---|---|\n| A | 4,000 m² |" });
    const ai = $(".msg.ai .md")!;
    expect(ai.querySelectorAll("ul li").length).toBe(2);
    expect(ai.querySelector("li b")!.textContent).toBe("A");
    expect(ai.querySelector("img")).toBeNull();
    expect(ai.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(ai.querySelector("table td.num")!.textContent).toBe("4,000 m²");
  });

  it("a failed request offers Try again, which sends the same request again", async () => {
    const { prompts, emit, $ } = setup();
    $<HTMLTextAreaElement>("textarea").value = "add a block";
    $<HTMLButtonElement>(".send").click();
    await until(() => prompts.length === 1);
    emit({ kind: "error", text: "Forma was not connected.", fix: "Open the panel." });
    await until(() => !!$(".retry"));
    $<HTMLButtonElement>(".retry").click();
    await until(() => prompts.length === 2);
    expect(prompts[1]).toBe("add a block");
  });

  it("the conversation survives a panel reload (Forma reloads it on design-option switch)", async () => {
    const store = memStore();
    const first = setup({ store });
    first.$<HTMLTextAreaElement>("textarea").value = "how big is it?";
    first.$<HTMLButtonElement>(".send").click();
    await until(() => first.prompts.length === 1);
    first.emit({ kind: "say", text: "It is **4,315 m²**." });
    first.emit({ kind: "done", text: "4,315 m².", threadId: "T9" });
    await tick(30);
    const second = setup({ store }); // remount = reload
    expect(second.$(".welcome")).toBeNull();
    expect(second.$(".msg.me")!.textContent).toBe("how big is it?");
    expect(second.$(".msg.ai b")!.textContent).toBe("4,315 m²");
    expect(second.$(".work.finished")!.textContent).toContain("Done");
    expect(second.ctrl.threadId).toBe("T9"); // follow-ups continue the same conversation
    second.$<HTMLButtonElement>(".newchat").click();
    const third = setup({ store });
    expect(third.$(".welcome")).not.toBeNull();
  });

  it("a task still running after a reload is shown live and can be stopped", async () => {
    const { panel, attached, emit, cancelled, $ } = setup();
    panel.resume("run7", "Massing options", ["Copying the design option…"], Date.now() - 5000);
    expect(attached).toEqual(["run7"]);
    expect($(".msg.me")!.textContent).toBe("Massing options");
    expect($(".work .wrow")!.textContent).toContain("Copying the design option…");
    emit({ kind: "step", text: "Placing 4 buildings…" });
    expect($(".work .wrow")!.textContent).toContain("Placing 4 buildings…");
    $<HTMLButtonElement>(".send").click(); // Stop
    expect(cancelled()).toBe(1);
  });

  it("first run: a checklist says what is missing; Send does nothing until Codex is ready", async () => {
    let status = { installed: true, loggedIn: false, text: "Codex is signed out.", fix: "Run codex login." };
    const { prompts, $ } = setup({ check: async () => status });
    await until(() => !$<HTMLElement>(".setup").hidden);
    expect($(".setup")!.textContent).toContain("Run codex login.");
    expect($(".checks .no")!.textContent).toContain("signed in");
    $<HTMLTextAreaElement>("textarea").value = "hi";
    $<HTMLButtonElement>(".send").click();
    await tick(30);
    expect(prompts).toEqual([]);
    status = { installed: true, loggedIn: true, text: "Codex is ready.", fix: undefined as any };
    (Array.from(document.querySelectorAll(".setup .btn")).find((b) => b.textContent === "Check again") as HTMLButtonElement).click();
    await until(() => $<HTMLElement>(".setup").hidden);
  });

  it("view-only and update banners", () => {
    const { panel, $ } = setup();
    panel.setCanEdit(false);
    expect($("#viewonly")!.textContent).toMatch(/View only/);
    panel.setCanEdit(true);
    expect($("#viewonly")).toBeNull();
    let ran = 0;
    panel.setUpdate("0.2.0", () => ran++);
    $<HTMLButtonElement>("#update .btn").click();
    expect(ran).toBe(1);
    expect($("#update")!.textContent).toMatch(/Updating/);
  });
});
