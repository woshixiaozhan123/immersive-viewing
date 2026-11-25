[CmdletBinding()]
param(
    [ValidateSet("ask", "hy-mt2-1.8b", "qwen2.5-3b", "qwen2.5-7b")]
    [string]$Model = "ask",
    [switch]$SkipSubtitles,
    [switch]$HfMirror,
    [double]$IdleMinutes = 30,
    [string[]]$ExtensionIds = @(),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$NativeDir = $PSScriptRoot
$CacheServerDir = Split-Path -Parent $NativeDir
$VenvDir = Join-Path $CacheServerDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$RuntimeDir = Join-Path $CacheServerDir "runtime"
$ModelsDir = Join-Path $RuntimeDir "models"
$LlamaDir = Join-Path $RuntimeDir "llama"
$EnvJsonPath = Join-Path $NativeDir "env.json"
$InstallHostScript = Join-Path $NativeDir "install-host.ps1"

$ModelCatalog = [ordered]@{
    "hy-mt2-1.8b" = @{
        Key   = "hy-mt2-1.8b"
        Repo  = "tencent/Hy-MT2-1.8B-GGUF"
        File  = "Hy-MT2-1.8B-Q4_K_M.gguf"
        Size  = "~1.1 GB"
        Rec   = "8 GB+ 内存 / 纯 CPU 或入门显卡（轻量极速，默认推荐）"
    }
    "qwen2.5-3b" = @{
        Key   = "qwen2.5-3b"
        Repo  = "Qwen/Qwen2.5-3B-Instruct-GGUF"
        File  = "qwen2.5-3b-instruct-q4_k_m.gguf"
        Size  = "~2.0 GB"
        Rec   = "16 GB 内存 + 8 核 CPU 或 4-6 GB+ 独显（日/英理解更稳，进阶首选）"
    }
    "qwen2.5-7b" = @{
        Key   = "qwen2.5-7b"
        Repo  = "bartowski/Qwen2.5-7B-Instruct-GGUF"
        File  = "Qwen2.5-7B-Instruct-Q4_K_M.gguf"
        Size  = "~4.7 GB"
        Rec   = "24 GB+ 内存 + 8 GB+ 独显（译文最自然，高配旗舰）"
    }
}

if ($HfMirror) {
    $env:HF_ENDPOINT = "https://hf-mirror.com"
    Write-Host "[mirror] HF_ENDPOINT=$($env:HF_ENDPOINT)"
}

function Find-SystemPython {
    $cmds = @("py", "python", "python3")
    foreach ($c in $cmds) {
        $found = Get-Command $c -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        try {
            $ver = if ($c -eq "py") { & $c -3 -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null }
                   else { & $c -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null }
            if ($ver -match '^(\d+)\.(\d+)$') {
                $maj = [int]$Matches[1]; $min = [int]$Matches[2]
                if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 10)) {
                    return @{ Cmd = $c; IsPyLauncher = ($c -eq "py"); Version = $ver }
                }
            }
        } catch {}
    }
    return $null
}

function Read-EnvJsonMap {
    $map = @{}
    if (Test-Path $EnvJsonPath) {
        try {
            $raw = Get-Content -Path $EnvJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($raw) {
                foreach ($p in $raw.PSObject.Properties) {
                    $map[$p.Name] = [string]$p.Value
                }
            }
        } catch {}
    }
    return $map
}

function Find-ExistingFile([string[]]$Candidates) {
    foreach ($c in $Candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    return ""
}

function Get-HostRamGB {
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        return [math]::Round(($cs.TotalPhysicalMemory / 1GB), 1)
    } catch {
        return 0
    }
}

function Select-TranslationModel([string]$RequestedModel, [double]$RamGB, [bool]$IsInteractive, [bool]$IsDryRun, [string]$ExistingPath) {
    if ($RequestedModel -ne "ask") {
        return $ModelCatalog[$RequestedModel]
    }
    $recKey = if ($RamGB -ge 22) { "qwen2.5-3b" } elseif ($RamGB -ge 14) { "qwen2.5-3b" } else { "hy-mt2-1.8b" }
    if ($IsDryRun -or -not $IsInteractive) {
        if ($ExistingPath) { return $null }
        return $ModelCatalog[$recKey]
    }

    Write-Host ""
    Write-Host ("请选择本地翻译模型（检测到本机物理内存约 {0} GB）：" -f $RamGB)
    Write-Host "  [1] hy-mt2-1.8b  ($($ModelCatalog['hy-mt2-1.8b'].Size)) - $($ModelCatalog['hy-mt2-1.8b'].Rec)"
    Write-Host "  [2] qwen2.5-3b   ($($ModelCatalog['qwen2.5-3b'].Size)) - $($ModelCatalog['qwen2.5-3b'].Rec)"
    Write-Host "  [3] qwen2.5-7b   ($($ModelCatalog['qwen2.5-7b'].Size)) - $($ModelCatalog['qwen2.5-7b'].Rec)"
    if ($ExistingPath) {
        Write-Host "  [0] 保留当前已配置模型: $ExistingPath"
    }
    $defaultChoice = if ($ExistingPath) { "0" } elseif ($recKey -eq "qwen2.5-3b") { "2" } else { "1" }
    $ans = Read-Host "输入序号 [默认 $defaultChoice]"
    if (-not $ans) { $ans = $defaultChoice }
    switch ($ans.Trim()) {
        "0" { if ($ExistingPath) { return $null } else { return $ModelCatalog[$recKey] } }
        "1" { return $ModelCatalog["hy-mt2-1.8b"] }
        "2" { return $ModelCatalog["qwen2.5-3b"] }
        "3" { return $ModelCatalog["qwen2.5-7b"] }
        default { return $ModelCatalog[$recKey] }
    }
}

$ramGB = Get-HostRamGB
$isInteractive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

Write-Host "=== 沉浸式观影 · 本地服务一键部署 ==="
Write-Host "  CacheServer : $CacheServerDir"
Write-Host "  SystemRAM   : $ramGB GB | ModelParam: $Model | SkipSubtitles: $SkipSubtitles | DryRun: $DryRun"

# Step 1: Python & venv
if (Test-Path $VenvPython) {
    Write-Host "[1/5] 复用已有 Python 虚拟环境: $VenvPython"
} else {
    $sysPy = Find-SystemPython
    if (-not $sysPy) {
        throw "未找到 Python 3.10+。请先安装 Python 3.10+（https://www.python.org/downloads/）。"
    }
    if ($DryRun) {
        Write-Host "[1/5] [DryRun] 将使用 $($sysPy.Cmd) (Python $($sysPy.Version)) 创建虚拟环境: $VenvDir"
    } else {
        Write-Host "[1/5] 正在创建虚拟环境 (Python $($sysPy.Version))..."
        if ($sysPy.IsPyLauncher) {
            & $sysPy.Cmd -3 -m venv $VenvDir
        } else {
            & $sysPy.Cmd -m venv $VenvDir
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) {
            throw "创建虚拟环境失败。"
        }
    }
}

# Step 2: Python dependencies
$reqBase = Join-Path $CacheServerDir "requirements.txt"
$reqSubs = Join-Path $CacheServerDir "requirements-subtitles.txt"
if ($DryRun) {
    Write-Host "[2/5] [DryRun] 将安装基础依赖 ($reqBase)"
    if (-not $SkipSubtitles) {
        Write-Host "      [DryRun] 将安装字幕依赖 ($reqSubs) 及 huggingface_hub"
    }
} else {
    Write-Host "[2/5] 正在检查并安装 Python 依赖..."
    & $VenvPython -m pip install -r $reqBase
    if ($LASTEXITCODE -ne 0) { throw "安装基础依赖失败。" }
    if (-not $SkipSubtitles) {
        & $VenvPython -m pip install -r $reqSubs huggingface_hub
        if ($LASTEXITCODE -ne 0) { throw "安装字幕依赖失败。" }
    }
}

$existingEnv = Read-EnvJsonMap
$resolvedLlama = ""
$resolvedModel = ""

if (-not $SkipSubtitles) {
    # Step 3: Whisper small + selectable GGUF translation model
    $whisperCached = Get-ChildItem -Path "$env:USERPROFILE\.cache\huggingface\hub" -Directory -Filter "models--Systran--faster-whisper-small" -ErrorAction SilentlyContinue | Select-Object -First 1
    $whisperReady = [bool]($env:RB_SUBS_WHISPER_DIR -and (Test-Path $env:RB_SUBS_WHISPER_DIR)) -or [bool]$whisperCached
    if ($whisperReady) {
        Write-Host "[3/5] 检测到本机已存在 Whisper small 模型，跳过下载。"
    } elseif ($DryRun) {
        Write-Host "[3/5] [DryRun] 将从 HuggingFace 下载 Systran/faster-whisper-small"
    } else {
        Write-Host "[3/5] 正在下载 Whisper small (Systran/faster-whisper-small)..."
        & $VenvPython -c "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"
        if ($LASTEXITCODE -ne 0) { throw "下载 Whisper small 失败，国内网络可尝试加 -HfMirror。" }
    }

    $currentExistingModel = Find-ExistingFile @(
        $existingEnv["RB_SUBS_MT_MODEL"],
        $env:RB_SUBS_MT_MODEL
    )
    $selectedModel = Select-TranslationModel -RequestedModel $Model -RamGB $ramGB -IsInteractive $isInteractive -IsDryRun ([bool]$DryRun) -ExistingPath $currentExistingModel

    if ($null -eq $selectedModel -and $currentExistingModel) {
        $resolvedModel = $currentExistingModel
        Write-Host "[3/5] 保留已有翻译模型: $resolvedModel"
    } else {
        $targetFile = Join-Path $ModelsDir $selectedModel.File
        if (Test-Path -LiteralPath $targetFile -PathType Leaf) {
            $resolvedModel = (Resolve-Path -LiteralPath $targetFile).Path
            Write-Host "[3/5] 检测到目标模型已存在 ($($selectedModel.Key)): $resolvedModel"
        } elseif ($DryRun) {
            $resolvedModel = $targetFile
            Write-Host "[3/5] [DryRun] 将下载 $($selectedModel.Key): $($selectedModel.Repo)/$($selectedModel.File) ($($selectedModel.Size)) -> $targetFile"
        } else {
            New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
            Write-Host "[3/5] 正在下载翻译模型 $($selectedModel.Key) ($($selectedModel.File), $($selectedModel.Size))..."
            $dlModel = & $VenvPython -c "from huggingface_hub import hf_hub_download; print(hf_hub_download('$($selectedModel.Repo)', '$($selectedModel.File)', local_dir=r'$ModelsDir'))"
            if ($LASTEXITCODE -ne 0) { throw "下载翻译模型失败，国内网络可尝试加 -HfMirror。" }
            $resolvedModel = ($dlModel | Select-Object -Last 1).Trim()
        }
    }

    # Step 4: llama-server (Vulkan preferred, CPU fallback)
    $llamaCandidates = @(
        $existingEnv["RB_SUBS_LLAMA_GPU_BIN"],
        $existingEnv["RB_SUBS_LLAMA_BIN"],
        $env:RB_SUBS_LLAMA_GPU_BIN,
        $env:RB_SUBS_LLAMA_BIN,
        (Join-Path $LlamaDir "llama-server.exe")
    )
    $resolvedLlama = Find-ExistingFile $llamaCandidates
    if ($resolvedLlama) {
        Write-Host "[4/5] 检测到本机已有 llama-server: $resolvedLlama"
    } elseif ($DryRun) {
        Write-Host "[4/5] [DryRun] 将从 ggml-org/llama.cpp Releases 下载 Windows Vulkan 版 llama-server 到 $LlamaDir"
    } else {
        New-Item -ItemType Directory -Path $LlamaDir -Force | Out-Null
        Write-Host "[4/5] 正在查询 ggml-org/llama.cpp 最新 Windows 发布包..."
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent" = "immersive-cinema-setup" } -TimeoutSec 20
        $asset = $rel.assets | Where-Object { $_.name -match 'bin-win-vulkan-x64\.zip$' } | Select-Object -First 1
        if (-not $asset) {
            $asset = $rel.assets | Where-Object { $_.name -match 'bin-win-(avx2|cpu)-x64\.zip$' } | Select-Object -First 1
        }
        if (-not $asset) {
            throw "未在 llama.cpp 最新 Release 找到 Windows x64 压缩包，请手动下载并配置 RB_SUBS_LLAMA_BIN。"
        }
        $zipPath = Join-Path $RuntimeDir $asset.name
        Write-Host "      正在下载 $($asset.name)..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -TimeoutSec 300
        Expand-Archive -Path $zipPath -DestinationPath $LlamaDir -Force
        Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
        $exe = Get-ChildItem -Path $LlamaDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
        if (-not $exe) { throw "解压后未找到 llama-server.exe。" }
        $resolvedLlama = $exe.FullName
        Write-Host "      已部署 llama-server: $resolvedLlama"
    }
} else {
    Write-Host "[3/5] 已跳过字幕模型下载 (-SkipSubtitles)。"
    Write-Host "[4/5] 已跳过 llama-server 下载 (-SkipSubtitles)。"
}

# Step 5: Register Native Messaging host
if ($DryRun) {
    Write-Host "[5/5] [DryRun] 将调用 $InstallHostScript 注册 Native Messaging (IdleMinutes=$IdleMinutes, MtModel=$resolvedModel)"
} else {
    Write-Host "[5/5] 正在注册浏览器 Native Messaging 按需自动启动..."
    $hostArgs = @{ IdleMinutes = $IdleMinutes }
    if ($ExtensionIds.Count -gt 0) { $hostArgs["ExtensionIds"] = $ExtensionIds }
    if ($resolvedLlama) { $hostArgs["LlamaBin"] = $resolvedLlama }
    if ($resolvedModel) { $hostArgs["MtModel"] = $resolvedModel }
    & $InstallHostScript @hostArgs
    if ($LASTEXITCODE -ne 0) { throw "注册 Native Messaging 失败。" }
}

Write-Host ""
Write-Host "=== 完成！ ==="
Write-Host "1. 请在浏览器扩展管理页（chrome://extensions 或 ego://extensions）点击「沉浸式观影」的刷新按钮。"
Write-Host "2. 平时后台 0 常驻进程；当你在网页开启「本站缓存」或「本地字幕」时会自动后台启动，30 分钟无操作自动退出。"
Write-Host "3. 以后想切换翻译模型（如 Hy-MT2-1.8B / Qwen2.5-3B / Qwen2.5-7B），随时重跑并加 -Model <型号> 即可。"
