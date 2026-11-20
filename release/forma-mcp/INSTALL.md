# Install forma-mcp for Codex (agent runbook)

These are deterministic, unattended steps for Windows. Every step is idempotent: re-running any of them is safe.
The installer never prompts for input. The last line it prints is one of the following:

- `FORMA_MCP_INSTALL_OK ...`
- `FORMA_MCP_INSTALL_FAILED code=N reason="..."`
- `FORMA_MCP_UNINSTALL_OK`

## 0. Prerequisites check

Run these checks and stop at the first failure:

```powershell
node --version            # must print v20.x or newer
codex --version           # should print codex-cli 0.167 or newer (optional for install, required for panel AI tasks)
codex login status        # should print "Logged in using ChatGPT"
```

| Check fails | Fix |
|---|---|
| `node` not found or version below 20 | Run `winget install OpenJS.NodeJS.LTS --silent`. Then open a new shell. |
| `codex` not found | Install the Codex CLI. The installer still works: it falls back to writing `config.toml`. |
| not logged in | The user must sign in once by running `codex login` (a browser opens). An agent cannot do this for them. |

Note: `codex login status` can report "Logged in" even when the saved session has expired. If a Codex run then fails with *"refresh token … sign in again"*, the user must run `codex logout` followed by `codex login`. The Forma panel detects this case and shows the same fix.

## 1. Install or update

Run this from the release folder, which holds `server.js`, `install.ps1`, `install.cmd` and this file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

To build from source first, run `npm ci; npm run release`, then run the command above inside `release\forma-mcp\`.

The installer does the following:

1. Copies `server.js` to `%LOCALAPPDATA%\forma-mcp\server.js`. This is a single self-contained file; no `node_modules` is needed.
2. Registers the server with Codex as `[mcp_servers.forma]`, using `codex mcp add` or, as a fallback, `~/.codex/config.toml` (or `$CODEX_HOME`). It sets `startup_timeout_sec = 30` and `tool_timeout_sec = 600`, and backs up the config to `config.toml.forma-mcp-<timestamp>.bak` before writing.
3. Adds a hidden login autostart for the background hub at `shell:startup\forma-mcp-hub.vbs`, and starts the hub now. With the hub running, the Forma panel works even before Codex is open. To skip this step, add `-NoAutostart`.
4. Runs a self-test.

Options:

| Option | Effect |
|---|---|
| `-NoAutostart` | Don't add the login autostart. The user must then open Codex before loading the Forma panel. |
| `-Port 8081` | Port of the hub and panel. If you change it, the Forma extension URL must match. |
| `-InstallDir <dir>` | Install location. Default: `%LOCALAPPDATA%\forma-mcp`. |
| `-CodexHome <dir>` | Codex config folder. Default: `$CODEX_HOME`, or `~\.codex`. |
| `-Source <file>` | The `server.js` to install. Default: the one next to the script, or `dist\server.js`. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 2 | Node missing or too old |
| 3 | `server.js` not found |
| 4 | Codex config update failed |
| 5 | Self-test failed |

## 2. Verify

```powershell
codex mcp get forma                                              # shows command + args with ...\forma-mcp\server.js
node "$env:LOCALAPPDATA\forma-mcp\server.js" --selftest          # {"ok":true,...,"hub":"running",...}
```

`"hub":"running"` means the panel URL is being served. With `-NoAutostart`, the hub only runs while a Codex session is open. Restart Codex afterwards so it picks up the new server.

## 3. One-time Forma setup (the user does this; it needs their Autodesk login)

The extension already exists: **Forma MCP**, ID `b673af74-97c8-4023-9c43-9f8a105d8644`. It was created with the Publisher Agreement accepted, and its left-panel view points to `http://localhost:8081/`.

1. In the project, open Extensions (the puzzle icon) → **Add extension** → gear menu → **Find extension by ID**, enter the ID, then **Add** → **Agree**.
2. Open **Forma MCP** in the Extensions list.

Who can install it is set at App Store → gear menu → **Manage extensions** → Forma MCP → *Who are allowed to use the extension*. Right now only the demo site is allowed and only its owner can see it. To roll it out to the office:

- Add each site's id (`pro_…`) under *Only specific projects*.
- Or, so colleagues can install it, change *Owner* to an Autodesk Platform Services app; Forma requires this before an extension can be shared.

The panel's address is always `http://localhost:8081/` on each person's own computer, so every user needs this installer.

The status line at the top of the panel shows one of these states:

| Panel says | Meaning |
|---|---|
| **Connected** (optionally "· Codex chats: N") | Everything works: the panel's buttons, and Codex chats can use Forma. |
| **Reconnecting…** | The connection dropped briefly. It recovers by itself; no action needed. |
| **Not connected yet …** | The background service isn't running. Re-run the installer (autostart on) or open Codex. The panel reconnects by itself. |
| The page doesn't load | Same cause. Start the service, then reload the panel. |

Above the message box, a yellow note appears only when Codex can't be used:

| Note says | Fix |
|---|---|
| Codex is not installed | Install the Codex CLI (step 0), then reload the panel. |
| Codex is signed out | The user runs `codex logout`, then `codex login`, in a terminal. |

## 3a. What the panel's assistant uses

Assistant tasks run `codex exec` locally on the user's own ChatGPT/Codex subscription. No API key is involved, and nothing leaves the machine except Codex's own traffic.

| Setting | Default | Override (environment variable for the hub) |
|---|---|---|
| Model | `gpt-6.1-sol` | `FORMA_MCP_CODEX_MODEL` |
| Reasoning effort | `medium` | `FORMA_MCP_CODEX_EFFORT` |
| Speed tier | `priority` (Codex's "Fast") | `FORMA_MCP_CODEX_TIER` (`default` for normal speed) |
| Codex executable | found on PATH | `FORMA_MCP_CODEX` (full path) |

Panel runs ignore the user's own `config.toml` (`--ignore-user-config`). They load only the forma server, so they start quickly and use few tokens. Within a panel run:

- `forma_script` (raw JavaScript) is switched off.
- Removing elements or deleting a design option shows **Approve / Reject** buttons in the panel. Nothing is removed until the user clicks Approve. If the user rejects, the assistant is told not to retry.

Fast mode uses up the Codex usage allowance faster. Set `FORMA_MCP_CODEX_TIER=default` if the allowance runs low.

## 3b. Why `forma_edit` is pre-approved in Codex chats

The installer adds `[mcp_servers.forma.tools.forma_edit] approval_mode = "approve"`. Codex marks `forma_edit` as destructive because it can remove elements. Without this setting, Codex refuses to call `forma_edit` at all when its approval policy is `never`. Every edit is still one undo step (`forma_edit {"undo":1}` or the panel's Undo button).

## 4. Update

Re-run step 1 with the new release. The background hub is restarted and the Forma panel asks for a reload to get the new version, even while Codex is open (an older helper inside a running Codex session hands the connection to the new one). Codex sessions use the new tools the next time they start.

**For a team:** put the release folder (`server.js`, `install.ps1`, `install.cmd`, `version.json`, the docs) on a shared drive and install from there. The installer remembers that folder in `%LOCALAPPDATA%\forma-mcp\source.json`. The helper checks it at start and every 6 hours. When a newer build is published there, the panel shows **Update now**, which runs that folder's installer. Publishing an update = replacing the folder's files with a new `npm run release`.

## 4a. Support and logs

- Log file: `%LOCALAPPDATA%\forma-mcp\logs\forma-mcp.log` (1 MB, one older copy kept). It records connections, task start/end with duration and errors. It never records prompts, answers or design data.
- In the panel: ⋯ → **Copy diagnostics**. From a terminal: `node "%LOCALAPPDATA%\forma-mcp\server.js" --diagnose` (also saves a copy in the temp folder).
- The background helper restarts itself if it crashes (at most 5 times a minute, then once a minute).
- A panel task that runs longer than 20 minutes is stopped (`FORMA_MCP_RUN_TIMEOUT_MS`).

## 4b. Security of the local helper

- It listens on `127.0.0.1` only and answers only requests addressed to `localhost`/`127.0.0.1` (blocks DNS-rebinding pages).
- The panel page can be embedded only by Forma (`*.autodeskforma.eu`, `*.autodeskforma.com`, `*.autodesk.com`). Override with `FORMA_MCP_FRAME_ANCESTORS` if Autodesk changes domains. Verified live: inside Forma the panel connects; embedded in another site it does not.
- Panel connections must come from the panel page itself; Codex sessions use a random key stored in `%USERPROFILE%\.forma-mcp\token`.
- Panel tasks run Codex read-only (no shell, no file writes) with only the forma tools; `forma_script` is disabled there.

## 5. Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Uninstalling stops the background hub, removes the autostart and the `[mcp_servers.forma]` entry (after a backup), and deletes `%LOCALAPPDATA%\forma-mcp` (server, logs) and `%USERPROFILE%\.forma-mcp` (connection key). Your other Codex settings are kept (tested on a clean temporary profile). The Forma extension has to be removed in Forma by the user.
