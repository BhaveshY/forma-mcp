// Dev: run one panel assistant task (same runner, model and sandbox as the panel) against live Forma.
import { join } from "node:path";
import { ExecRunner, wrapPrompt } from "../src/server/codex.js";
const prompt = process.argv[2] ?? "Check the design: max height 25 m, FAR 2.5, at least 5 m from the site boundary. Do not change anything.";
const r = new ExecRunner({ serverPath: process.env.FORMA_MCP_SERVER_PATH ?? join(process.env.LOCALAPPDATA!, "forma-mcp", "server.js") });
console.log(JSON.stringify(await r.check()));
const t0 = Date.now();
const h = r.start({
  prompt: wrapPrompt(prompt),
  onEvent: (e) => {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${e.kind}: ${e.text}`);
    if (e.kind === "error") process.exitCode = 1;
  },
});
await h.done;
