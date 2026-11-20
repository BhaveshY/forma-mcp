// Dev CLI: call one forma-mcp tool through a real MCP client.
//   node scripts/call.mjs <tool> '<json args>' [image-out.jpg]
// Env passes through (FORMA_MCP_PORT, FORMA_MCP_ONLY_PROPOSAL, ...).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const [tool, json = "{}", imgOut] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env: process.env, stderr: "ignore" });
const client = new Client({ name: "call", version: "0" });
await client.connect(transport);
const t0 = Date.now();
const r = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 600000 });
const ms = Date.now() - t0;
for (const c of r.content) {
  if (c.type === "text") console.log(c.text);
  else if (c.type === "image") {
    const f = imgOut ?? "capture.jpg";
    writeFileSync(f, Buffer.from(c.data, "base64"));
    console.log(`[image ${c.mimeType} -> ${f}]`);
  }
}
console.log(`-- ${tool} ${r.isError ? "ERROR " : ""}${ms} ms`);
await client.close();
