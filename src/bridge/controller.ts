// Panel logic, separate from the DOM so it can be tested.
// Direct actions call Forma directly (in this panel) — they never involve Codex or its quota.
export type OpsLike = { run(op: string, args?: Record<string, unknown>): Promise<any> };
export type AiStatus = { installed: boolean; loggedIn: boolean; version?: string; text: string; fix?: string };
export type AiEvent = { kind: "step" | "say" | "done" | "error" | "cancelled"; text: string; fix?: string; threadId?: string };
export type AiLike = {
  check(): Promise<AiStatus>;
  run(prompt: string, threadId: string | undefined, onEvent: (e: AiEvent) => void, title?: string): { cancel(): void };
  /** follow a task that is already running (the panel was reloaded while it ran) */
  attach?(runId: string, onEvent: (e: AiEvent) => void): { cancel(): void };
};

type P = Record<string, any>;

/** Panel reads/undo that run directly in the panel (no AI, no Codex). Everything else Forma shows itself. */
export const DIRECT = {
  metrics: (ops: OpsLike) => ops.run("metrics", {}),
  status: (ops: OpsLike) => ops.run("status", {}),
  undo: (ops: OpsLike, p: P) => ops.run("undo", { steps: p.steps ?? 1 }),
} satisfies Record<string, (ops: OpsLike, p: P) => Promise<any>>;

export type DirectName = keyof typeof DIRECT;

export type Numbers = { gfa?: number; far?: number; coverage?: string; units?: number; footprint?: number };
export const toNumbers = (m: any): Numbers => ({ gfa: num(m?.gfa_m2), far: num(m?.far), coverage: m?.coverage, units: num(m?.units), footprint: num(m?.footprint_m2) });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Plain-language changes between two area summaries, e.g. ["Floor area +1,200 m²", "FAR 1.1 → 1.4"]. */
export function describeChange(a: Numbers, b: Numbers): string[] {
  const out: string[] = [];
  const f = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  if (a.gfa !== undefined && b.gfa !== undefined && Math.abs(b.gfa - a.gfa) >= 1) out.push(`Floor area ${b.gfa > a.gfa ? "+" : "−"}${f(Math.abs(b.gfa - a.gfa))} m²`);
  if (a.far !== undefined && b.far !== undefined && Math.abs(b.far - a.far) >= 0.01) out.push(`FAR ${a.far} → ${b.far}`);
  if (a.coverage && b.coverage && a.coverage !== b.coverage) out.push(`Coverage ${a.coverage} → ${b.coverage}`);
  return out;
}


export class PanelController {
  threadId?: string;
  private running?: { cancel(): void };

  constructor(private ops: OpsLike, private ai: AiLike) {}

  direct(name: DirectName, params: P = {}) {
    return DIRECT[name](this.ops, params);
  }

  get busy() {
    return !!this.running;
  }

  checkAi() {
    return this.ai.check();
  }

  /** Ask the assistant. Follow-ups continue the same conversation until newConversation(). */
  ask(prompt: string, onEvent: (e: AiEvent) => void, title?: string) {
    if (this.running) throw new Error("The assistant is still working.");
    this.running = this.ai.run(prompt, this.threadId, (e) => {
      if (e.threadId) this.threadId = e.threadId;
      if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") this.running = undefined;
      onEvent(e);
    }, title);
  }

  /** Follow a task that was already running when the panel loaded. */
  attach(runId: string, onEvent: (e: AiEvent) => void) {
    if (this.running) throw new Error("The assistant is still working.");
    if (!this.ai.attach) throw new Error("Cannot follow the running task here.");
    this.running = this.ai.attach(runId, (e) => {
      if (e.threadId) this.threadId = e.threadId;
      if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") this.running = undefined;
      onEvent(e);
    });
  }

  stop() {
    this.running?.cancel();
  }

  newConversation() {
    this.threadId = undefined;
  }

}
