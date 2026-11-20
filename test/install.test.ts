// Installer on a clean, throw-away profile: every location is a temp folder, so the real
// Codex config, autostart and hub are never touched. Windows only; needs `npm run release`.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REL = resolve(__dirname, "..", "release", "forma-mcp");
const run = process.platform === "win32" && existsSync(join(REL, "server.js")) && existsSync(join(REL, "version.json"));

function ps(args: string[], env: Record<string, string>) {
  try {
    return { code: 0, out: execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REL, "install.ps1"), ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000, windowsHide: true }) };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe.skipIf(!run)("installer (fresh profile)", () => {
  it("installs, records the update source, keeps the user's other Codex settings, and uninstalls cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "fmcp-inst-"));
    const d = { inst: join(root, "LocalAppData", "forma-mcp"), codex: join(root, "codex"), startup: join(root, "Startup"), state: join(root, "state") };
    mkdirSync(d.codex, { recursive: true });
    mkdirSync(d.startup, { recursive: true });
    const userCfg = 'model = "gpt-6.1-sol"\n\n[mcp_servers.other]\ncommand = "other.exe"\n';
    writeFileSync(join(d.codex, "config.toml"), userCfg);
    const port = String(27000 + Math.floor(Math.random() * 2000));
    const common = ["-InstallDir", d.inst, "-CodexHome", d.codex, "-StartupDir", d.startup, "-StateDir", d.state, "-Port", port];

    const a = ps([...common, "-NoAutostart"], { CODEX_HOME: d.codex });
    expect(a.out).toMatch(/FORMA_MCP_INSTALL_OK version=0\.1\.0/);
    expect(a.code).toBe(0);
    expect(existsSync(join(d.inst, "server.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(d.inst, "source.json"), "utf8")).dir.toLowerCase()).toBe(REL.toLowerCase());
    const cfg = readFileSync(join(d.codex, "config.toml"), "utf8");
    expect(cfg).toContain('model = "gpt-6.1-sol"');
    expect(cfg).toContain("[mcp_servers.other]");
    expect(cfg).toContain("[mcp_servers.forma]");
    expect(cfg).toContain(`FORMA_MCP_PORT = '${port}'`);
    expect(cfg).toContain('[mcp_servers.forma.tools.forma_edit]');

    // running it again (an update) changes nothing else and does not duplicate the entry
    const b = ps([...common, "-NoAutostart"], { CODEX_HOME: d.codex });
    expect(b.code).toBe(0);
    expect(readFileSync(join(d.codex, "config.toml"), "utf8").match(/\[mcp_servers\.forma\]/g)).toHaveLength(1);

    const u = ps([...common, "-Uninstall"], { CODEX_HOME: d.codex });
    expect(u.out).toMatch(/FORMA_MCP_UNINSTALL_OK/);
    expect(existsSync(d.inst)).toBe(false);
    const after = readFileSync(join(d.codex, "config.toml"), "utf8");
    expect(after).not.toContain("mcp_servers.forma");
    expect(after).toContain("[mcp_servers.other]");
    expect(after).toContain('model = "gpt-6.1-sol"');
  }, 240000);
});
