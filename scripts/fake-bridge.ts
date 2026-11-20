declare const __BUILD__: string | undefined;
// Dev tool: a fake Forma (mock SDK) connected to the hub like the real panel.
// Lets you drive forma-mcp from Codex without a Forma project.
//   node build-dev.mjs && FORMA_MCP_PORT=8081 node dist/fake-bridge.cjs
import { WebSocket } from "ws";
import { BridgeClient, type WsLike } from "../src/bridge/client.js";
import { Ops } from "../src/bridge/ops.js";
import { mockForma } from "../test/mockForma.js";

const PORT = Number(process.env.FORMA_MCP_PORT ?? 8081);
const ops = new Ops(mockForma().F);
const c = new BridgeClient({
  url: `ws://127.0.0.1:${PORT}/ws/bridge`,
  connect: (u) => new WebSocket(u, { origin: `http://localhost:${PORT}` }) as unknown as WsLike,
  run: (op, a) => ops.run(op, a),
  info: async () => ({ projectId: "proj", projectName: "Test Site (fake)", canEdit: true, build: typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev" }),
  onLog: (l) => console.error("fake-bridge:", l),
  onState: (s) => console.error("fake-bridge state:", s.text),
});
c.start();
