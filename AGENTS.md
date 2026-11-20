# Install Forma MCP on Windows

Follow these steps when the user asks you to install this repository. Work from the root of the local checkout on the Windows PC where they use Forma. The prebuilt installer registers Forma MCP in Codex. Claude Code can run this setup, and the Forma panel uses the Codex CLI for its assistant.

## 1. Check prerequisites

1. Run `node -v`. If Node.js is missing or below v20, run `winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`. Refresh the shell's PATH and rerun `node -v` in a fresh shell.
2. Run `codex --version` and `codex login status`. If the CLI is missing, install it with `npm.cmd install -g @openai/codex@latest`, refresh PATH, and check again. If the user is signed out, continue installing the local helper and tell them to run `codex login` and complete the browser sign-in before using the panel assistant. See [INSTALL.md](INSTALL.md) for prerequisite details.

## 2. Run the installer and verify it

From the repository root, run:

```cmd
cmd /c release\forma-mcp\install.cmd
```

Require exit code 0 and a final `FORMA_MCP_INSTALL_OK` line. Then run this GET in PowerShell:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8081/health' -TimeoutSec 5
```

Confirm the response has `app = forma-mcp`. If you need to verify registration, run `codex mcp get forma` and check that it points to the installed `server.js`.

To update later, run `git pull` in the checkout and rerun the same installer and checks. The running helper hands over automatically. Reload any open Forma tab when prompted, then restart Codex to load the updated tools.

## 3. Tell the user what to do in Forma

After the local checks, give the user these steps in plain words:

1. In your Forma project, open **Extensions** (the puzzle icon) > **Add extension** > the **gear icon** > **Find extension by ID**. Paste `b673af74-97c8-4023-9c43-9f8a105d8644`, choose **Add**, and accept the agreement if prompted.
2. Open **Forma MCP** from the Extensions list. If you can't find it, ask the extension owner to share it with your Autodesk account and give it access to your project if needed.
3. Restart Codex. If you haven't signed in to the Codex CLI yet, run `codex login` and complete the browser sign-in.

Only the user should do the Forma steps and sign in. During setup, keep Forma project data untouched and let the installer manage `~/.codex/config.toml`.

## Troubleshoot

In Command Prompt, run:

```cmd
node "%LOCALAPPDATA%\forma-mcp\server.js" --diagnose
```

- If the helper is down or the panel won't load, rerun the installer with autostart enabled, verify `/health`, and reload the panel. If installed with `-NoAutostart`, open Codex to start the helper.
- If port 8081 belongs to another app, identify the conflict and have the user free the port. The shared extension points to port 8081.
- If the panel says Codex is missing, check that `codex --version` works in a fresh shell, then reload the panel. If a Codex run reports an expired refresh token even though login status looks good, ask the user to run `codex logout` and then `codex login`.
- For stdout capture with PowerShell `Start-Process -RedirectStandardOutput`, use `-PassThru` and call `.WaitForExit()` on the returned process. `Start-Process -Wait` waits for the process tree, which includes the persistent hub.
- If installation fails, report the exit code and the `FORMA_MCP_INSTALL_FAILED` line. See [INSTALL.md](INSTALL.md) for exit codes and support details. The log is at `%LOCALAPPDATA%\forma-mcp\logs\forma-mcp.log`.
