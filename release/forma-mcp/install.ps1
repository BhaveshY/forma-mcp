<#
.SYNOPSIS
  Installs (or updates / uninstalls) the Forma MCP server for OpenAI Codex. Idempotent, unattended.

.DESCRIPTION
  1. Checks Node.js >= 20.
  2. Copies the single-file server to %LOCALAPPDATA%\forma-mcp\server.js.
  3. Registers it with Codex (`codex mcp add`, falling back to editing config.toml) and
     sets startup_timeout_sec / tool_timeout_sec. Backs up config.toml first.
  4. Adds a hidden login autostart for the background hub (skip with -NoAutostart), so the
     Forma panel loads even before Codex is running.
  5. Runs a self-test. Last line of output: FORMA_MCP_INSTALL_OK ... or FORMA_MCP_INSTALL_FAILED ...

  Exit codes: 0 ok · 2 Node.js missing/too old · 3 server.js not found · 4 Codex config failed · 5 self-test failed
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$NoAutostart,
  [int]$Port = 8081,
  [string]$Source,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'forma-mcp'),
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
  [int]$StartupTimeoutSec = 30,
  [int]$ToolTimeoutSec = 600,
  [string]$StartupDir = [Environment]::GetFolderPath("Startup"),
  [string]$StateDir = $(if ($env:FORMA_MCP_HOME) { $env:FORMA_MCP_HOME } else { Join-Path $HOME '.forma-mcp' })
)

$ErrorActionPreference = 'Stop'
$Name = 'forma'
$ServerPath = Join-Path $InstallDir 'server.js'
$AutostartVbs = Join-Path $StartupDir 'forma-mcp-hub.vbs'
$ConfigPath = Join-Path $CodexHome 'config.toml'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Say($m) { Write-Host "[forma-mcp] $m" }

# Run a native exe without PowerShell 5.1 turning its stderr warnings into terminating errors.
# Returns combined output as text; exit code is in $LASTEXITCODE.
function Invoke-Native([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $exe @argv 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $prev }
  return ($out -join "`n")
}
# Double-clicked: keep the window open so the result can be read. Agents capture output, so this is skipped.
function Hold { try { if (-not [Console]::IsOutputRedirected -and -not [Console]::IsInputRedirected -and $env:FORMA_MCP_NOPAUSE -ne "1") { Write-Host "Press any key to close (closes by itself in 60 s)..."; $t = [DateTime]::Now.AddSeconds(60); while ([DateTime]::Now -lt $t) { if ([Console]::KeyAvailable) { [void][Console]::ReadKey($true); break }; Start-Sleep -Milliseconds 200 } } } catch {} }
function Fail($code, $m) { Write-Host "[forma-mcp] ERROR: $m"; Write-Host "FORMA_MCP_INSTALL_FAILED code=$code reason=`"$m`""; Hold; exit $code }

function TomlStr([string]$s) {
  if ($s -notmatch "'") { return "'$s'" }                       # literal string: no escaping needed
  return '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"'
}

# Remove [mcp_servers.forma] and all [mcp_servers.forma.*] sub-tables; keep everything else byte-for-byte.
function Remove-FormaSection([string]$text) {
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$') {
      $hdr = $Matches[1].Trim()
      $skip = ($hdr -eq "mcp_servers.$Name" -or $hdr.StartsWith("mcp_servers.$Name."))
    }
    if (-not $skip) { $out.Add($line) }
  }
  return (($out -join "`n").TrimEnd() + "`n")
}

function Write-Config([string]$text) {
  if (Test-Path $ConfigPath) {
    $bak = "$ConfigPath.forma-mcp-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    Copy-Item $ConfigPath $bak -Force
  }
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
  [IO.File]::WriteAllText($ConfigPath, $text, $Utf8NoBom)
}

function Stop-Hub {
  # Only the background hub started by autostart; Codex-owned servers exit with Codex.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ServerPath*" -and $_.CommandLine -like '*--hub*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Say "stopped background hub (pid $($_.ProcessId))" } catch {} }
}

$codex = Get-Command codex -ErrorAction SilentlyContinue

# ---------------- uninstall ----------------
if ($Uninstall) {
  Stop-Hub
  if (Test-Path $AutostartVbs) { Remove-Item $AutostartVbs -Force; Say 'removed login autostart' }
  if ($codex) { $env:CODEX_HOME = $CodexHome; Invoke-Native $codex.Source @("mcp", "remove", $Name) | Out-Null }
  if (Test-Path $ConfigPath) {
    $t = [IO.File]::ReadAllText($ConfigPath)
    $n = Remove-FormaSection $t
    if ($n.TrimEnd() -ne $t.TrimEnd()) { Write-Config $n; Say "removed [mcp_servers.$Name] from $ConfigPath" }
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Say "removed $InstallDir (server, logs)" }
  if (Test-Path $StateDir) { Remove-Item $StateDir -Recurse -Force; Say "removed $StateDir (connection key)" }
  Write-Host "FORMA_MCP_UNINSTALL_OK"
  exit 0
}

# ---------------- 1. prerequisites ----------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 2 'Node.js is not installed. Install the LTS version from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again.' }
$nodeVer = (Invoke-Native $node.Source @("--version")).Trim().TrimStart([char]118)
if ([int]($nodeVer.Split('.')[0]) -lt 20) { Fail 2 "Node.js $nodeVer is too old; version 20 or newer is required." }
# A versioned install path (winget portable, nvm, fnm, volta) changes on every Node upgrade:
# reference plain "node" from PATH there, so upgrades never break the Codex entry.
$NodeCmd = if ($node.Source -match '(?i)node-v\d|\\nvm|\\fnm|\\volta|\\\.nvs') { 'node' } else { $node.Source }
Say "Node.js $nodeVer at $($node.Source) (configured as: $NodeCmd)"

# ---------------- 2. copy server ----------------
if (-not $Source) {
  $Source = @((Join-Path $PSScriptRoot 'server.js'), (Join-Path $PSScriptRoot 'dist\server.js')) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Source -or -not (Test-Path $Source)) { Fail 3 'server.js not found next to install.ps1 (or in dist\). Build it with: npm run build' }
Stop-Hub
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ((Resolve-Path $Source).Path -ne $ServerPath) { Copy-Item $Source $ServerPath -Force }
$Version = (Invoke-Native $node.Source @($ServerPath, "--version")).Trim()
Say "installed server v$Version -> $ServerPath"
# Remember the release folder (e.g. a shared drive) so the panel can offer newer builds published there.
$SourceDir = Split-Path -Parent (Resolve-Path $Source).Path
$SourceJson = Join-Path $InstallDir 'source.json'
if ((Test-Path (Join-Path $SourceDir 'version.json')) -and ($SourceDir -ne (Resolve-Path $InstallDir).Path)) {
  [IO.File]::WriteAllText($SourceJson, (@{ dir = $SourceDir } | ConvertTo-Json -Compress), $Utf8NoBom)
  Say "updates: will check $SourceDir"
} elseif (Test-Path $SourceJson) { Remove-Item $SourceJson -Force }
foreach ($doc in 'INSTALL.md', 'README.md') {
  $p = Join-Path $PSScriptRoot $doc
  if ((Test-Path $p) -and ((Resolve-Path $p).Path -ne (Join-Path $InstallDir $doc))) { Copy-Item $p (Join-Path $InstallDir $doc) -Force }
}

# ---------------- 3. register with Codex ----------------
try {
  $usedCli = $false
  if ($codex) {
    $env:CODEX_HOME = $CodexHome
    Invoke-Native $codex.Source @("mcp", "remove", $Name) | Out-Null
    $addOut = Invoke-Native $codex.Source @("mcp", "add", $Name, "--", $NodeCmd, $ServerPath)
    $usedCli = ($LASTEXITCODE -eq 0)
    if (-not $usedCli) { Say 'codex mcp add failed; writing config.toml directly' }
  } else {
    Say 'codex CLI not on PATH; writing config.toml directly'
  }
  # Normalise the section either way so timeouts and the port are always set.
  $t = if (Test-Path $ConfigPath) { [IO.File]::ReadAllText($ConfigPath) } else { '' }
  $section = @(
    "[mcp_servers.$Name]",
    "command = $(TomlStr $NodeCmd)",
    "args = [$(TomlStr $ServerPath)]",
    "startup_timeout_sec = $StartupTimeoutSec",
    "tool_timeout_sec = $ToolTimeoutSec"
  )
  if ($Port -ne 8081) { $section += @("", "[mcp_servers.$Name.env]", "FORMA_MCP_PORT = '$Port'") }
  # forma_edit (move/remove/rename/undo) is undoable and lock-guarded; without this, Codex's
  # approval_policy = "never" silently rejects it. forma_script keeps Codex's default (blocked/asks).
  $section += @("", "[mcp_servers.$Name.tools.forma_edit]", 'approval_mode = "approve"')
  $new = (Remove-FormaSection $t).TrimEnd() + "`n`n" + ($section -join "`n") + "`n"
  if ($new.Trim() -ne $t.Trim()) { Write-Config $new.TrimStart() }
  Say "registered with Codex ($(if ($usedCli) { 'codex mcp add' } else { 'config.toml' })) in $ConfigPath"
} catch {
  Fail 4 "could not update Codex config: $($_.Exception.Message)"
}

# ---------------- 4. login autostart for the background hub ----------------
if ($NoAutostart) {
  if (Test-Path $AutostartVbs) { Remove-Item $AutostartVbs -Force }
  Say 'autostart skipped (-NoAutostart): open Codex before loading the Forma panel'
} else {
  $portEnv = if ($Port -ne 8081) { "sh.Environment(`"PROCESS`")(`"FORMA_MCP_PORT`") = `"$Port`"`r`n" } else { '' }
  $vbs = "Set sh = CreateObject(`"WScript.Shell`")`r`n$portEnv" + "sh.Run `"`"`"$NodeCmd`"`" `"`"$ServerPath`"`" --hub`", 0, False`r`n"
  [IO.File]::WriteAllText($AutostartVbs, $vbs, [Text.Encoding]::ASCII)
  # Windows can pass unrelated inheritable handles to a detached child, including the
  # installer's capture pipe. Create the supervisor with handle inheritance disabled.
  $env:FORMA_MCP_PORT = "$Port"
  try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class FormaHubLaunch {
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedData, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string currentDirectory, ref StartupInfo startup, out ProcessInformation process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static void Start(string node, string server) {
        const uint CreateNoWindow = 0x08000000;
        var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)) };
        var command = new StringBuilder("\"" + node + "\" \"" + server + "\" --hub");
        ProcessInformation process;
        if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, CreateNoWindow,
                           IntPtr.Zero, null, ref startup, out process)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CloseHandle(process.Thread);
        CloseHandle(process.Process);
    }
}
'@
    [FormaHubLaunch]::Start($node.Source, $ServerPath)
  } catch {
    Fail 5 "could not launch the background hub: $($_.Exception.Message)"
  }
  Say "login autostart installed ($AutostartVbs) and background hub started"
}

# ---------------- 5. verify ----------------
$env:FORMA_MCP_PORT = "$Port"
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  $json = (Invoke-Native $node.Source @($ServerPath, "--selftest")).Trim()
  if ($LASTEXITCODE -eq 0 -and ($NoAutostart -or $json -match '"hub":"running"')) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}
Say "self-test: $json"
if (-not $ok) { Fail 5 "self-test failed: $json" }
if ($codex) {
  $got = Invoke-Native $codex.Source @("mcp", "get", $Name)
  if ($got -notmatch [regex]::Escape($ServerPath)) { Say "warning: 'codex mcp get $Name' did not show the server path" }
}

Write-Host ''
Write-Host 'Next (one time, in Forma): Extensions > Add extension > gear > Find extension by ID'
Write-Host '  b673af74-97c8-4023-9c43-9f8a105d8644  (Forma MCP), then open it from the Extensions list.'
Write-Host 'Restart Codex so it loads the new server.'
Write-Host "FORMA_MCP_INSTALL_OK version=$Version path=`"$ServerPath`" config=`"$ConfigPath`" port=$Port autostart=$(-not $NoAutostart)"
Hold
exit 0
