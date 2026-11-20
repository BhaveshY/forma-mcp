// Update check: the installer remembers where it was installed from (a shared folder); a newer
// build published there is offered in the panel, and "Update now" runs that folder's installer.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

export type UpdateInfo = { version: string; build: string; source: string };

/** Folder that holds the installed server.js (…\forma-mcp). */
export const installDir = () => process.env.FORMA_MCP_INSTALL_DIR ?? dirname(process.argv[1] ?? ".");

/** Where the installer recorded the release folder it installed from. */
export function sourceDir(dir = installDir()): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as { dir?: string };
    return s.dir && existsSync(join(s.dir, "version.json")) ? s.dir : undefined;
  } catch { return undefined; }
}

const stamp = (b: string) => (/^[0-9a-z]+$/.test(b) ? parseInt(b, 36) : 0);

/** A newer build in the release folder, or undefined. */
export function checkUpdate(build: string, dir = installDir()): UpdateInfo | undefined {
  const src = sourceDir(dir);
  if (!src || build === "dev") return undefined;
  try {
    const v = JSON.parse(readFileSync(join(src, "version.json"), "utf8")) as { version?: string; build?: string };
    if (v.build && stamp(v.build) > stamp(build) && existsSync(join(src, "install.ps1"))) return { version: v.version ?? "?", build: v.build, source: src };
  } catch { /* unreadable share: no update */ }
  return undefined;
}

/** Run the release folder's installer in the background (it restarts the hub itself). */
export function runUpdate(u: UpdateInfo): void {
  const ps = join(u.source, "install.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-Source", join(u.source, "server.js")], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
