// Stand-in for the Codex CLI. Replays JSONL recorded from real `codex exec --json` runs.
//   FAKE_CODEX_SCENARIO = fixture name (codex-success | codex-auth-expired | ...) or "slow"
//   FAKE_CODEX_LOGIN    = "in" (default) | "out"
//   FAKE_CODEX_LOG      = file to append {argv, stdin} as JSON lines
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

if (argv[0] === "--version") {
  console.log("codex-cli 0.167.1");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (process.env.FAKE_CODEX_HOME_ERROR) { console.error(process.env.FAKE_CODEX_HOME_ERROR); process.exit(1); }
  if ((process.env.FAKE_CODEX_LOGIN ?? "in") === "in") { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.log("Not logged in");
  process.exit(1);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", async () => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, stdin, pid: process.pid }) + "\n");
  const scenario = process.env.FAKE_CODEX_SCENARIO ?? "codex-success";
  if (scenario === "slow") {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "slow-thread" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    console.log(JSON.stringify({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "forma", tool: "forma_create", arguments: { items: [{}, {}, {}] }, status: "in_progress" } }));
    setInterval(() => {}, 1000); // hang until killed
    return;
  }
  const lines = readFileSync(join(here, "fixtures", `${scenario}.jsonl`), "utf8").trim().split("\n");
  for (const l of lines) {
    process.stdout.write(l + "\n");
    await new Promise((r) => setTimeout(r, 5));
  }
  process.exit(scenario.includes("expired") ? 1 : 0);
});
