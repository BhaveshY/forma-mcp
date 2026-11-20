// Wire protocol between server hub, relay agents and the in-Forma bridge.
export const PROTOCOL = 2;
export const APP = "forma-mcp";

export type OpError = { message: string; fix?: string };

/** id is globally unique (origin process token + seq) and stable across resends. */
/** tab: pin the request to one Forma window (panel assistant runs); unset = the window the user used last. */
export type Req = { t: "req"; id: string; op: string; args: unknown; write?: boolean; attempt?: number; timeoutMs?: number; tab?: string };
export type Res =
  | { t: "res"; id: string; ok: true; result: unknown }
  | { t: "res"; id: string; ok: false; error: OpError };

export type BridgeInfo = {
  projectId: string;
  projectName?: string;
  proposalId?: string;
  region?: string;
  canEdit?: boolean;
  sdk?: string;
  /** stable per browser tab (survives reloads) */
  tabId?: string;
  /** build id of the panel code */
  build?: string;
};

export type Msg =
  | Req
  | Res
  | { t: "hello"; protocol: number; info: BridgeInfo }
  | { t: "info"; info: Partial<BridgeInfo> }
  | { t: "agents"; n: number } // hub → bridge: number of Codex sessions attached
  // panel AI (runs on the user's Codex subscription; hub spawns `codex exec`)
  | { t: "ai.check"; id: string }
  | { t: "ai.status"; id: string; status: { installed: boolean; loggedIn: boolean; version?: string; text: string; fix?: string } }
  | { t: "ai.run"; runId: string; prompt: string; threadId?: string; title?: string }
  | { t: "ai.cancel"; runId: string }
  | { t: "ai.event"; runId: string; ev: { kind: string; text: string; fix?: string; threadId?: string } }
  | { t: "ai.active"; runId: string; prompt: string; steps: string[]; startedAt: number; tab?: string } // hub → reloaded panel: a task is still running
  | { t: "diag"; id: string } // bridge → hub: diagnostics text for support
  | { t: "diag.res"; id: string; text: string }
  | { t: "update"; version: string; build: string } // hub → bridge: a newer release is available
  | { t: "update.run" } // bridge → hub: install it now
  | { t: "focus" } // bridge → hub: the user is working in this Forma window
  | { t: "outdated" } // hub → bridge: newer forma-mcp installed; this panel must reload
  | { t: "ping" }
  | { t: "pong" };

/** Thrown inside ops; carries a concrete next step for the model. */
export class FormaError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
  }
}

export const NOT_CONNECTED_FIX =
  "Open your Forma project in the browser and open the 'Forma MCP' panel (Extensions). It connects by itself; then retry.";

/** Capped exponential backoff with full jitter. */
export function backoffDelay(attempt: number, minMs = 250, maxMs = 5000): number {
  const cap = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
  return Math.round(minMs / 2 + Math.random() * (cap - minMs / 2));
}
