[CmdletBinding()]
param(
    [string[]]$ExtensionIds = @(),
    [string]$LlamaBin = "",
    [string]$LlamaGpuBin = "",
    [string]$MtModel = "",
    [double]$IdleMinutes = 30,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$HostName = "com.realtime_beauty.cache_host"
$NativeDir = $PSScriptRoot
$CacheServerDir = Split-Path -Parent $NativeDir
$RepoRoot = (Resolve-Path (Split-Path -Parent $CacheServerDir)).Path
$RunCmdPath = (Resolve-Path (Join-Path $NativeDir "run-host.cmd")).Path
$ManifestPath = Join-Path $NativeDir "$HostName.json"
$EnvJsonPath = Join-Path $NativeDir "env.json"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$RegRoots = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
    foreach ($key in $RegRoots) {
        if (Test-Path $key) {
            Remove-Item -Path $key -Force -Recurse
            Write-Host "Removed registry key: $key"
        }
    }
    Write-Host "Uninstall complete."
    exit 0
}

function Normalize-PathStr([string]$p) {
    if (-not $p) { return "" }
    return $p.TrimEnd('\', '/').ToLowerInvariant()
}

function Discover-ExtensionIds([string]$TargetRepoRoot) {
    $targetNorm = Normalize-PathStr $TargetRepoRoot
    $userDataRoots = @(
        "$env:LOCALAPPDATA\Google\Chrome\User Data",
        "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
        "$env:LOCALAPPDATA\Chromium\User Data",
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
        "$env:LOCALAPPDATA\Citro Labs\ego lite\User Data"
    )
    $found = New-Object System.Collections.Generic.HashSet[string]
    foreach ($root in $userDataRoots) {
        if (-not (Test-Path $root)) { continue }
        $profiles = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "Default" -or $_.Name -like "Profile *" }
        foreach ($prof in $profiles) {
            foreach ($prefName in @("Secure Preferences", "Preferences")) {
                $prefPath = Join-Path $prof.FullName $prefName
                if (-not (Test-Path $prefPath)) { continue }
                try {
                    $raw = Get-Content -Path $prefPath -Raw -Encoding UTF8 -ErrorAction Stop
                    if ($raw -notmatch "web-video-beauty") { continue }
                    $json = $raw | ConvertFrom-Json
                    $settings = $json.extensions.settings
                    if (-not $settings) { continue }
                    foreach ($prop in $settings.PSObject.Properties) {
                        $extPath = [string]$prop.Value.path
                        if ($extPath -and (Normalize-PathStr $extPath) -eq $targetNorm) {
                            [void]$found.Add($prop.Name)
                        }
                    }
                } catch {
                    # ignore unreadable or malformed profile files
                }
            }
        }
    }
    return @($found)
}

function First-ExistingFile([string[]]$Candidates) {
    foreach ($c in $Candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    return ""
}

$resolvedIds = New-Object System.Collections.Generic.List[string]
foreach ($id in $ExtensionIds) {
    $clean = ($id -replace '[^a-pA-P]', '').ToLowerInvariant()
    if ($clean.Length -eq 32 -and -not $resolvedIds.Contains($clean)) {
        $resolvedIds.Add($clean)
    }
}
if ($resolvedIds.Count -eq 0) {
    foreach ($id in (Discover-ExtensionIds $RepoRoot)) {
        if (-not $resolvedIds.Contains($id)) {
            $resolvedIds.Add($id)
        }
    }
}
if ($resolvedIds.Count -eq 0) {
    throw "No loaded extension ID found for '$RepoRoot'. Load the unpacked extension in Chrome/ego first, or pass -ExtensionIds <32-char-id>."
}

$existingEnv = @{}
if (Test-Path $EnvJsonPath) {
    try {
        $parsed = Get-Content -Path $EnvJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($parsed) {
            foreach ($prop in $parsed.PSObject.Properties) {
                $existingEnv[$prop.Name] = [string]$prop.Value
            }
        }
    } catch {}
}

$benchDirs = New-Object System.Collections.Generic.List[string]
$cursor = $RepoRoot
for ($depth = 0; $depth -lt 5 -and $cursor; $depth++) {
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
    $directBench = Join-Path $cursor "work\bench"
    if (Test-Path $directBench) {
        [void]$benchDirs.Add($directBench)
    }
    foreach ($sub in (Get-ChildItem -Path $cursor -Directory -ErrorAction SilentlyContinue)) {
        $subBench = Join-Path $sub.FullName "work\bench"
        if (Test-Path $subBench) {
            [void]$benchDirs.Add($subBench)
        }
        foreach ($sub2 in (Get-ChildItem -Path $sub.FullName -Directory -ErrorAction SilentlyContinue)) {
            $sub2Bench = Join-Path $sub2.FullName "work\bench"
            if (Test-Path $sub2Bench) {
                [void]$benchDirs.Add($sub2Bench)
            }
        }
    }
}

$runtimeLlama = Join-Path $CacheServerDir "runtime\llama\llama-server.exe"
$runtimeModels = @(
    (Join-Path $CacheServerDir "runtime\models\Hy-MT2-1.8B-Q4_K_M.gguf"),
    (Join-Path $CacheServerDir "runtime\models\qwen2.5-3b-instruct-q4_k_m.gguf"),
    (Join-Path $CacheServerDir "runtime\models\Qwen2.5-7B-Instruct-Q4_K_M.gguf")
)

$llamaCandidates = @($LlamaBin, $existingEnv["RB_SUBS_LLAMA_BIN"], $env:RB_SUBS_LLAMA_BIN, $runtimeLlama, "C:\tools\llama.cpp\llama-server.exe")
$llamaGpuCandidates = @($LlamaGpuBin, $existingEnv["RB_SUBS_LLAMA_GPU_BIN"], $env:RB_SUBS_LLAMA_GPU_BIN, $runtimeLlama)
$mtModelCandidates = @($MtModel, $existingEnv["RB_SUBS_MT_MODEL"], $env:RB_SUBS_MT_MODEL) + $runtimeModels + @("C:\models\Hy-MT2-1.8B-Q4_K_M.gguf")
foreach ($bd in $benchDirs) {
    $llamaCandidates += (Join-Path $bd "engine\llama-server.exe")
    $llamaGpuCandidates += (Join-Path $bd "engine-vulkan\llama-server.exe")
    $mtModelCandidates += (Join-Path $bd "models\Hy-MT2-1.8B-Q4_K_M.gguf")
}

$finalLlama = First-ExistingFile $llamaCandidates
$finalLlamaGpu = First-ExistingFile $llamaGpuCandidates
$finalMtModel = First-ExistingFile $mtModelCandidates

$envPayload = [ordered]@{
    RB_IDLE_SHUTDOWN_MIN = [string]$IdleMinutes
}
if ($finalLlama) { $envPayload["RB_SUBS_LLAMA_BIN"] = $finalLlama }
if ($finalLlamaGpu) { $envPayload["RB_SUBS_LLAMA_GPU_BIN"] = $finalLlamaGpu }
if ($finalMtModel) { $envPayload["RB_SUBS_MT_MODEL"] = $finalMtModel }

$envJsonText = ($envPayload | ConvertTo-Json -Depth 4) + "`r`n"
[System.IO.File]::WriteAllText($EnvJsonPath, $envJsonText, $Utf8NoBom)

$allowedOrigins = @($resolvedIds | ForEach-Object { "chrome-extension://$_/" })
$manifestObj = [ordered]@{
    name            = $HostName
    description     = "On-demand local cache server launcher for Realtime Beauty MV3"
    path            = $RunCmdPath
    type            = "stdio"
    allowed_origins = $allowedOrigins
}
$manifestText = ($manifestObj | ConvertTo-Json -Depth 4) + "`r`n"
[System.IO.File]::WriteAllText($ManifestPath, $manifestText, $Utf8NoBom)

foreach ($key in $RegRoots) {
    if (-not (Test-Path $key)) {
        New-Item -Path $key -Force | Out-Null
    }
    Set-ItemProperty -Path $key -Name "(Default)" -Value $ManifestPath
}

Write-Host "Native Messaging Host installed successfully."
Write-Host "  Host Name       : $HostName"
Write-Host "  Manifest        : $ManifestPath"
Write-Host "  Launcher        : $RunCmdPath"
Write-Host "  Allowed Origins : $($allowedOrigins -join ', ')"
Write-Host "  Env Config      : $EnvJsonPath"
Write-Host "    RB_IDLE_SHUTDOWN_MIN : $($envPayload['RB_IDLE_SHUTDOWN_MIN'])"
Write-Host "    RB_SUBS_LLAMA_BIN    : $(if ($finalLlama) { $finalLlama } else { '(not found)' })"
Write-Host "    RB_SUBS_LLAMA_GPU_BIN: $(if ($finalLlamaGpu) { $finalLlamaGpu } else { '(not found)' })"
Write-Host "    RB_SUBS_MT_MODEL     : $(if ($finalMtModel) { $finalMtModel } else { '(not found)' })"
Write-Host "  Registry Keys   :"
foreach ($key in $RegRoots) {
    Write-Host "    $key"
}
