// Produces ONE self-contained file: dist/server.js (MCP server + hub + embedded bridge page).
// Runs with `node server.js` on any machine with Node >= 20; no node_modules needed.
import { build } from "esbuild";
import { readdirSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// One id per build: panels report it, so an outdated panel (old code still loaded) is detected.
const BUILD = Date.now().toString(36);
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/bridge", { recursive: true });

// 1) bridge bundle (browser), kept in memory and also written for the dev/test fallback
const bridge = await build({
  entryPoints: ["src/bridge/main.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  write: false,
  outfile: "dist/bridge/bridge.js",
  define: { __BUILD__: JSON.stringify(BUILD) },
});
const bridgeJs = bridge.outputFiles[0].text;
const html = readFileSync("src/bridge/index.html", "utf8").replace("./bridge.js", `./bridge.js?v=${BUILD}`);
writeFileSync("dist/bridge/bridge.js", bridgeJs);
copyFileSync("src/bridge/index.html", "dist/bridge/index.html");

const assets = {
  "/": { type: "text/html; charset=utf-8", body: html },
  "/bridge.js": { type: "text/javascript; charset=utf-8", body: bridgeJs },
};

// 2) server bundle (node, CommonJS so a lone server.js runs without a package.json)
await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  legalComments: "none",
  // optional native speedups of `ws`; it falls back to JS when they are absent
  external: ["bufferutil", "utf-8-validate"],
  define: {
    __BRIDGE_ASSETS__: JSON.stringify(assets),
    __VERSION__: JSON.stringify(pkg.version),
    __BUILD__: JSON.stringify(BUILD),
  },
  banner: { js: "#!/usr/bin/env node" },
});

await build({ entryPoints: ["scripts/fake-bridge.ts"], outfile: "dist/fake-bridge.cjs", bundle: true, platform: "node", format: "cjs", logLevel: "error", define: { __BUILD__: JSON.stringify(BUILD) } });

// dist/ lives inside a "type":"module" package; mark it CommonJS for local runs.
writeFileSync("dist/package.json", JSON.stringify({ type: "commonjs" }) + "\n");

const kb = (f) => Math.round(readFileSync(f).length / 1024);
console.log(`build ${BUILD} · built dist/server.js (${kb("dist/server.js")} KB, bridge ${Math.round(bridgeJs.length / 1024)} KB embedded) v${pkg.version}`);

// `npm run release`: a folder an agent (or a person) can install from.
if (process.argv.includes("--release")) {
  // Empty the folder instead of deleting it: on Windows an open Explorer/viewer locks the directory itself.
  mkdirSync("release/forma-mcp", { recursive: true });
  for (const f of readdirSync("release/forma-mcp")) rmSync(`release/forma-mcp/${f}`, { recursive: true, force: true });
  for (const [from, to] of [["dist/server.js", "server.js"], ["install.ps1", "install.ps1"], ["install.cmd", "install.cmd"], ["INSTALL.md", "INSTALL.md"], ["README.md", "README.md"]])
    copyFileSync(from, `release/forma-mcp/${to}`);
  // Installed panels compare this with their own build to offer "Update now".
  writeFileSync("release/forma-mcp/version.json", JSON.stringify({ version: pkg.version, build: BUILD }) + "\n");
  console.log("release/forma-mcp ready");
}
