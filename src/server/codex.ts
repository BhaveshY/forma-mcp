// Runs AI tasks on the user's own Codex (ChatGPT) subscription via the locally installed,
// logged-in Codex CLI. No API keys, no hosted backend. Behind an interface so a
// `codex app-server` runner can replace `codex exec --json` later.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { log } from "./log.js";

export type AiEvent =
  | { kind: "step"; text: string }
  | { kind: "say"; text: string }
  | { kind: "done"; text: string; threadId?: string; usage?: Record<string, number> }
  | { kind: "error"; text: string; fix?: string; threadId?: string }
  | { kind: "cancelled"; text: string };

export type RunOptions = {
  prompt: string;
  threadId?: string; // continue a conversation (codex exec resume)
  env?: Record<string, string>; // extra env for the forma MCP server Codex starts
  onEvent: (e: AiEvent) => void;
};

export interface RunHandle {
  cancel(): void;
  done: Promise<void>;
}

export interface CodexRunner {
  check(): Promise<CodexStatus>;
  start(opts: RunOptions): RunHandle;
}

export type CodexStatus = { installed: boolean; loggedIn: boolean; version?: string; text: string; fix?: string };

export const SIGN_IN_FIX =
  "Codex needs you to sign in again. Ask your coding agent to run step 0 of INSTALL.md, or run `codex logout` and then `codex login` in a terminal.";
const INSTALL_FIX = "The Codex app is not installed on this computer. Ask your coding agent to follow INSTALL.md (step 0) to install and sign in to Codex.";

/** argv prefix used to run codex. FORMA_MCP_CODEX can override (JSON array or a path). */
export function resolveCodex(): { cmd: string; pre: string[]; shell: boolean } | undefined {
  const o = process.env.FORMA_MCP_CODEX;
  if (o) {
    if (o.trim().startsWith("[")) {
      const [cmd, ...pre] = JSON.parse(o) as string[];
      return { cmd, pre, shell: false };
    }
    return { cmd: o, pre: [], shell: /\.(cmd|bat)$/i.test(o) };
  }
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
  // Windows installs of the Codex app put the CLI here even when it is not on PATH.
  if (process.platform === "win32" && process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"));
  for (const n of names)
    for (const d of dirs) {
      const p = join(d, n);
      if (existsSync(p)) return { cmd: p, pre: [], shell: /\.(cmd|bat)$/i.test(p) };
    }
  return undefined;
}

function looksLikeAuthError(s: string) {
  return /refresh token|sign in again|log ?in again|not logged in|unauthori[sz]ed|401|authentication|login required/i.test(s);
}

/** Plain-language progress for a forma tool call (architect-facing, no jargon). */
export function describeTool(tool: string, args: Record<string, any> = {}): string {
  switch (tool) {
    case "forma_status": return "Looking at the project…";
    case "forma_find": return args.inside ? "Checking whether the spot is free…" : "Looking through the buildings…";
    case "forma_read": return "Reading details…";
    case "forma_metrics": return "Calculating areas and FAR…";
    case "forma_check": return "Checking the planning rules…";
    case "forma_report": return "Writing the design report…";
    case "forma_create": {
      const n = Array.isArray(args.items) ? args.items.length : 1;
      const what = n === 1 ? "1 building" : `${n} buildings`;
      return args.preview ? `Checking the design for ${what}…` : `Placing ${what}…`;
    }
    case "forma_edit":
      if (args.undo) return "Undoing the last change…";
      if (Array.isArray(args.ops) && args.ops.some((o: any) => o?.op === "remove")) return "Removing buildings…";
      return "Adjusting buildings…";
    case "forma_view": return args.action === "capture" ? "Taking a picture…" : "Changing the view…";
    case "forma_analysis": return args.action === "sun" ? "Starting a sun study…" : args.action === "noise" ? "Starting a noise study…" : "Reading analysis results…";
    case "forma_site": return args.action === "switch" ? "Switching design option…" : args.action === "duplicate" ? "Copying the design option…" : "Reading the site…";
    case "forma_script": return "Running an advanced step…";
    default: return "Working…";
  }
}

/** Translate one `codex exec --json` JSONL event into panel events. Pure; unit-tested with real recordings. */
export function mapEvent(e: any, st: { threadId?: string; failed?: boolean; last?: string }): AiEvent[] {
  switch (e?.type) {
    case "thread.started":
      st.threadId = e.thread_id;
      return [];
    case "item.started":
      if (e.item?.type === "mcp_tool_call") return [{ kind: "step", text: describeTool(e.item.tool, e.item.arguments) }];
      return [];
    case "item.completed": {
      const it = e.item ?? {};
      if (it.type === "agent_message" && it.text) {
        st.last = it.text;
        return [{ kind: "say", text: it.text }];
      }
      if (it.type === "mcp_tool_call" && it.status === "failed") {
        const msg = it.error?.message ?? (it.result?.content?.[0]?.text as string | undefined) ?? "a step failed";
        if (/requires approval/i.test(msg)) return [{ kind: "step", text: "A step needed your approval and was skipped." }];
        if (/not connected/i.test(msg)) return [{ kind: "step", text: "Forma was not connected for a moment." }];
        return [{ kind: "step", text: "One step did not work; the assistant is adjusting." }];
      }
      if (it.type === "todo_list" && Array.isArray(it.items)) {
        const open = it.items.find((x: any) => !x.completed);
        return open ? [{ kind: "step", text: String(open.text) }] : [];
      }
      return [];
    }
    case "turn.completed":
      return [{ kind: "done", text: st.last ?? "Done.", threadId: st.threadId, usage: e.usage }];
    case "turn.failed":
    case "error": {
      if (st.failed) return [];
      st.failed = true;
      const msg = e.error?.message ?? e.message ?? "Codex stopped unexpectedly.";
      if (looksLikeAuthError(msg)) return [{ kind: "error", text: "Codex is signed out.", fix: SIGN_IN_FIX, threadId: st.threadId }];
      return [{ kind: "error", text: msg, threadId: st.threadId }];
    }
    default:
      return [];
  }
}

export type ExecRunnerOptions = {
  /** absolute path to forma-mcp server.js (what Codex should start as its MCP server) */
  serverPath: string;
  /** node executable to run server.js with */
  nodePath?: string;
  /** working directory for Codex runs (no project files; keeps context small) */
  workDir?: string;
  /** Codex model for panel runs. Default gpt-6.1-sol (env FORMA_MCP_CODEX_MODEL). */
  model?: string;
  /** Reasoning effort. Default "medium" (env FORMA_MCP_CODEX_EFFORT). */
  effort?: string;
  /** Codex service tier: "priority" = Fast mode (env FORMA_MCP_CODEX_TIER). */
  tier?: string;
};

/** `codex exec --json` runner. Every run loads ONLY the forma MCP server (fast, few tokens). */
export class ExecRunner implements CodexRunner {
  private statusCache?: { at: number; s: CodexStatus };
  constructor(private o: ExecRunnerOptions) {}

  async check(): Promise<CodexStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 30000) return this.statusCache.s;
    const c = resolveCodex();
    let s: CodexStatus;
    if (!c) s = { installed: false, loggedIn: false, text: "Codex is not installed.", fix: INSTALL_FIX };
    else {
      const run = (args: string[]) => spawnSync(c.cmd, [...c.pre, ...args], { encoding: "utf8", shell: c.shell, timeout: 15000, windowsHide: true });
      const v = run(["--version"]);
      const version = (v.stdout ?? "").split(/\r?\n/).find((l) => /codex/i.test(l))?.trim();
      const l = run(["login", "status"]);
      const out = `${l.stdout ?? ""}\n${l.stderr ?? ""}`;
      const homeError = [out, v.stdout ?? "", v.stderr ?? ""].join("\n").split(/\r?\n/)
        .find((line) => /error finding (?:the )?codex home|could not find (?:the )?(?:codex )?home directory/i.test(line));
      const loggedIn = l.status === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
      if (homeError) {
        s = {
          installed: true, loggedIn: false, version,
          text: `Codex can't find its home folder.\n${homeError.trim()}`,
          fix: "Check that the USERPROFILE and CODEX_HOME environment variables, if set, each point to an existing folder.",
        };
      } else {
        s = v.status === 0
          ? { installed: true, loggedIn, version, text: loggedIn ? "Codex is ready." : "Codex is signed out.", fix: loggedIn ? undefined : SIGN_IN_FIX }
          : { installed: false, loggedIn: false, text: "Codex could not be started.", fix: INSTALL_FIX };
      }
    }
    this.statusCache = { at: Date.now(), s };
    return s;
  }

  /** Args for one turn; exported via buildArgs for tests. */
  buildArgs(opts: { threadId?: string; env?: Record<string, string> }): string[] {
    const node = this.o.nodePath ?? process.execPath;
    const toml = (s: string) => JSON.stringify(s); // TOML basic strings accept JSON escaping
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${toml(v)}`).join(",");
    const cfg = [
      `mcp_servers.forma.command=${toml(node)}`,
      `mcp_servers.forma.args=[${toml(this.o.serverPath)}]`,
      `mcp_servers.forma.startup_timeout_sec=30`,
      `mcp_servers.forma.tool_timeout_sec=600`,
      // The panel shows its own Approve/Reject for risky steps, so Codex must not block them.
      `mcp_servers.forma.default_tools_approval_mode="approve"`,
      // Panel users are not developers: no free-form scripts in panel runs (geometry tools cover the tasks).
      `mcp_servers.forma.disabled_tools=["forma_script"]`,
      ...(env ? [`mcp_servers.forma.env={${env}}`] : []),
    ].flatMap((c) => ["-c", c]);
    // --ignore-user-config skips the user's global model settings, so pin them here.
    const model = this.o.model ?? process.env.FORMA_MCP_CODEX_MODEL ?? "gpt-6.1-sol";
    const effort = this.o.effort ?? process.env.FORMA_MCP_CODEX_EFFORT ?? "medium";
    const tier = this.o.tier ?? process.env.FORMA_MCP_CODEX_TIER ?? "priority";
    const modelCfg = [`model=${toml(model)}`, `model_reasoning_effort=${toml(effort)}`, `service_tier=${toml(tier)}`].flatMap((c) => ["-c", c]);
    const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", ...cfg, ...modelCfg];
    return opts.threadId
      ? ["exec", "resume", ...common, "-c", 'sandbox_mode="read-only"', opts.threadId, "-"]
      : ["exec", ...common, "-s", "read-only", "-"];
  }

  start(opts: RunOptions): RunHandle {
    const c = resolveCodex();
    let cancel = () => {};
    const st: { threadId?: string; failed?: boolean; last?: string; ended?: boolean } = { threadId: opts.threadId };
    const emit = (e: AiEvent) => {
      if (st.ended) return;
      if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") st.ended = true;
      opts.onEvent(e);
    };
    const done = new Promise<void>((resolve) => {
      if (!c) {
        emit({ kind: "error", text: "Codex is not installed.", fix: INSTALL_FIX });
        return resolve();
      }
      const cwd = this.o.workDir ?? join(process.env.LOCALAPPDATA ?? homedir(), "forma-mcp", "runs");
      try { mkdirSync(cwd, { recursive: true }); } catch { /* best effort */ }
      emit({ kind: "step", text: opts.threadId ? "Continuing the conversation…" : "Starting the assistant…" });
      const child = spawn(c.cmd, [...c.pre, ...this.buildArgs(opts)], { cwd, shell: c.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      let gaveUp = false;
      cancel = () => {
        if (cancellationTimer) return;
        cancellationTimer = setTimeout(() => {
          gaveUp = true;
          log("warn", `Codex process ${child.pid} did not close after cancellation.`);
          resolve();
          emit({
            kind: "error", text: "Forma MCP could not confirm that Codex stopped.",
            fix: "Check your Forma project before retrying. If Codex is still running, close it or ask your IT team for help.",
          });
        }, 5000);
        if (child.exitCode === null && child.signalCode === null) killTree(child);
      };
      child.stdin!.end(opts.prompt);
      let stderr = "";
      child.stderr!.on("data", (d) => { stderr = (stderr + String(d)).slice(-4000); });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (cancellationTimer) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        for (const e of mapEvent(ev, st)) emit(e);
      });
      child.on("error", (err) => {
        if (!cancellationTimer) emit({ kind: "error", text: `Codex could not start: ${err.message}`, fix: INSTALL_FIX });
      });
      child.on("close", (code) => {
        cancel = () => {};
        if (cancellationTimer) {
          clearTimeout(cancellationTimer);
          if (!gaveUp) emit({ kind: "cancelled", text: "Stopped." });
        }
        else if (!st.ended) {
          const tail = stderr.split(/\r?\n/).filter((l) => l && !/^WARNING/.test(l)).slice(-3).join(" ");
          if (looksLikeAuthError(tail)) emit({ kind: "error", text: "Codex is signed out.", fix: SIGN_IN_FIX, threadId: st.threadId });
          else emit({ kind: "error", text: code === 0 ? "The assistant finished without an answer." : `Codex stopped (code ${code}). ${tail}`.trim(), threadId: st.threadId });
        }
        resolve();
      });
    });
    return { done, cancel: () => cancel() };
  }
}

/** Codex starts its own MCP child processes; kill the whole tree. */
function killTree(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 });
    if (result.status === 0) return;
    log("warn", `taskkill failed for Codex process ${child.pid} (${result.error?.message ?? `exit code ${result.status ?? result.signal}`}). Trying to stop Codex directly.`);
  }
  try { child.kill("SIGTERM"); } catch { /* close or the cancellation deadline will finish the run */ }
}

/** Wraps every request: short, jargon-free answers; forma tools only. */
export function wrapPrompt(userText: string): string {
  return [
    "You are helping an architect in Autodesk Forma. Use ONLY the forma tools (no shell, no files).",
    "Units are metres and m²; XY are local site coordinates. Use preview:true before large changes.",
    "Keep tool output small (use limit, fields). Do not leave test geometry behind unless asked.",
    "To make a building taller or lower use forma_edit op:'floors' (floors or add); 'Building N' names repeat, so identify buildings by path.",
    "Names like Building A refer to the labels shown in checks and reports. Resolve them with forma_find before asking the user to clarify.",
    "When placing or moving buildings, preview first, then verify setbacks and spacing with forma_check (minSetback and minSpacing) before reporting success. If a building cannot fit, explain the measured free space and leave it unplaced.",
    "Planning limits (height, floors, FAR, coverage, distances): check with forma_check. Reports: forma_report, then say where the files were saved.",
    "Abstandsflächen / setback areas map to forma_check rules.abstand. If the federal state is unknown, ask for it. If still unspecified, use MBO and say so.",
    "German planning limits in forma_check: GRZ → maxGrz, GFZ → maxGfz, Vollgeschosse → maxFullStoreys, Baufenster → insideZone.",
    "For GRZ, GRZ II or GFZ without limits use forma_report germanFigures:true. Before claiming the report contains figures, check the tool result lists them.",
    "To replace a building outline use forma_edit op:'footprint' with its polygon and preview first. To change floors at the same time, include floors and optionally floorHeight or total height in that edit.",
    "How much can we build / maximale Bebaubarkeit / Kubatur → forma_check action:capacity. Use any given height or storey limits. If absent, run with the default search and report its assumptions. Vacant previews assume existing buildings are removed. Use add to build alongside existing buildings and only set create:true when asked to place a block.",
    "For capacity placement, carry the preview's mode, rules, floorHeight, targetUse and inventory scope through to create. Use Forma's default metrics inventory unless the user explicitly asks to count the uncounted buildings. Mention the buildings listed as not counted in your answer. An optional includeContext:true run can be shown as a labelled sensitivity check. Base the requested placement on its original inventory scope.",
    "Final answer: short, plain language for an architect — no code, no paths, no tool names.",
    "",
    userText,
  ].join("\n");
}
