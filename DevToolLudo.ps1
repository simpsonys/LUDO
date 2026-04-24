<#
.SYNOPSIS
  LUDO Developer Tool
.DESCRIPTION
  A unified workflow script to run, build, test, and manage the LUDO project.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$global:ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$global:SessionsDir = Join-Path $env:LOCALAPPDATA "LUDO\sessions"

function Get-PackageVersion {
    $pkgJsonPath = Join-Path $global:ProjectRoot "package.json"
    if (Test-Path $pkgJsonPath) {
        try {
            $json = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
            return $json.version
        } catch {
            return "unknown"
        }
    }
    return "unknown"
}

function Show-Menu {
    Clear-Host
    $version = Get-PackageVersion
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  LUDO 개발 도구  [v$version]" -ForegroundColor Cyan
    Write-Host "  $global:ProjectRoot" -ForegroundColor Gray
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [ RUN ]" -ForegroundColor Yellow
    Write-Host "  1. Web 개발 서버 실행  (pnpm dev)"
    Write-Host "  2. Desktop 앱 실행     (tauri dev)"
    Write-Host "  3. ASR Python 워커 단독 실행"
    Write-Host ""
    Write-Host "  [ BUILD ]" -ForegroundColor Yellow
    Write-Host "  4. 의존성 설치         (pnpm install)"
    Write-Host "  5. Web 빌드            (pnpm build)"
    Write-Host "  6. 타입 체크           (pnpm check)"
    Write-Host "  7. Desktop 릴리즈 빌드 (tauri build)"
    Write-Host "  8. Rust 단위 테스트    (cargo test)"
    Write-Host ""
    Write-Host "  [ PYTHON WORKER ]" -ForegroundColor Yellow
    Write-Host "  9. Python 의존성 설치/업데이트"
    Write-Host " 10. Python 환경 진단"
    Write-Host ""
    Write-Host "  [ ENVIRONMENT ]" -ForegroundColor Yellow
    Write-Host " 11. 환경 정보 확인"
    Write-Host " 12. GPU Compute Type 설정  (LUDO_GPU_COMPUTE_TYPE)"
    Write-Host " 13. 세션 폴더 열기"
    Write-Host " 14. 오래된 세션 정리"
    Write-Host ""
    Write-Host "  [ GIT ]" -ForegroundColor Yellow
    Write-Host " 15. 작업 내용 Commit"
    Write-Host " 16. 버전 업 / 태그 생성 / Push"
    Write-Host " 17. 모든 로컬 변경사항 되돌리기"
    Write-Host ""
    Write-Host "  0. 종료"
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Run-Web {
    Write-Host "`n[Web 개발 서버] pnpm dev - http://localhost:1420" -ForegroundColor Green
    Write-Host "Ctrl+C 로 종료합니다.`n" -ForegroundColor DarkGray
    Push-Location (Join-Path $global:ProjectRoot "apps\client-tauri")
    try { pnpm dev } finally { Pop-Location }
}

function Run-Desktop {
    Write-Host "`n[Desktop 앱] tauri dev (Rust + React 핫리로드)" -ForegroundColor Green
    Write-Host "첫 실행시 Rust 컴파일로 수 분 소요될 수 있습니다." -ForegroundColor Gray
    Write-Host "Ctrl+C 로 종료합니다.`n" -ForegroundColor DarkGray
    Push-Location (Join-Path $global:ProjectRoot "apps\client-tauri")
    try { pnpm tauri dev } finally { Pop-Location }
}

function Run-AsrWorker {
    Write-Host "`n[ASR Python 워커 단독 실행]`n" -ForegroundColor Green
    Write-Host "실행 모드를 선택하세요:"
    Write-Host "  1. file    - 파일 트랜스크립션 (stdin JSON)"
    Write-Host "  2. mic_stream - 마이크 스트리밍 (stdin/stdout JSON)"
    Write-Host "  q. 취소`n"
    
    $modeInput = Read-Host "모드 선택"
    if ($modeInput -eq 'q') { return }
    $mode = if ([string]::IsNullOrWhiteSpace($modeInput)) { "file" } elseif ($modeInput -eq '2') { "mic_stream" } else { "file" }
    
    $backendInput = Read-Host "백엔드 (local_gpu / local_cpu) [기본: local_gpu]"
    $backend = if ([string]::IsNullOrWhiteSpace($backendInput)) { "local_gpu" } else { $backendInput }
    
    Write-Host "`n환경변수: LUDO_WHISPER_MODEL, LUDO_GPU_COMPUTE_TYPE 현재값 사용" -ForegroundColor Gray
    $ct = if ($env:LUDO_GPU_COMPUTE_TYPE) { $env:LUDO_GPU_COMPUTE_TYPE } else { "(미설정, 기본 float16)" }
    Write-Host "  LUDO_GPU_COMPUTE_TYPE=$ct`n" -ForegroundColor Gray
    
    Push-Location (Join-Path $global:ProjectRoot "services\asr-worker-python")
    try { 
        python -m asr_worker_python.worker --mode $mode --backend $backend
    } finally { Pop-Location }
}

function Build-Install {
    Write-Host "`n[의존성 설치] pnpm install`n" -ForegroundColor Green
    Push-Location $global:ProjectRoot
    try { 
        pnpm install
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] 의존성 설치 완료!" -ForegroundColor Green }
        else { Write-Host "[ERROR] pnpm install 실패!" -ForegroundColor Red }
    } finally { Pop-Location }
}

function Build-Web {
    Write-Host "`n[Web 빌드] pnpm build`n" -ForegroundColor Green
    Push-Location $global:ProjectRoot
    try { 
        pnpm build
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] Web 빌드 완료!" -ForegroundColor Green }
        else { Write-Host "[ERROR] Web 빌드 실패!" -ForegroundColor Red }
    } finally { Pop-Location }
}

function Build-Check {
    Write-Host "`n[타입 체크] pnpm check`n" -ForegroundColor Green
    Push-Location $global:ProjectRoot
    try { 
        pnpm check
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] 타입 체크 통과!" -ForegroundColor Green }
        else { Write-Host "[ERROR] 타입 체크 실패! 위 오류를 확인하세요." -ForegroundColor Red }
    } finally { Pop-Location }
}

function Build-Tauri {
    Write-Host "`n[Desktop 릴리즈 빌드] pnpm tauri build" -ForegroundColor Green
    Write-Host "Rust 컴파일이 포함되어 상당한 시간이 소요됩니다.`n" -ForegroundColor Gray
    Push-Location (Join-Path $global:ProjectRoot "apps\client-tauri")
    try { 
        pnpm tauri build
        if ($LASTEXITCODE -eq 0) { 
            Write-Host "[OK] Tauri 릴리즈 빌드 완료!" -ForegroundColor Green 
            Write-Host "결과물: apps\client-tauri\src-tauri\target\release\bundle\" -ForegroundColor Gray
        }
        else { Write-Host "[ERROR] Tauri 빌드 실패!" -ForegroundColor Red }
    } finally { Pop-Location }
}

function Build-CargoTest {
    Write-Host "`n[Rust 단위 테스트] cargo test`n" -ForegroundColor Green
    Push-Location (Join-Path $global:ProjectRoot "apps\client-tauri\src-tauri")
    try { 
        cargo test
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] 모든 Rust 테스트 통과!" -ForegroundColor Green }
        else { Write-Host "[ERROR] 일부 Rust 테스트 실패!" -ForegroundColor Red }
    } finally { Pop-Location }
}

function Python-Install {
    Write-Host "`n[Python 의존성 설치/업데이트]" -ForegroundColor Green
    Write-Host "services\asr-worker-python 의 pyproject.toml 기준으로 설치합니다.`n" -ForegroundColor Gray
    Push-Location (Join-Path $global:ProjectRoot "services\asr-worker-python")
    try { 
        & pip install -e ".[gpu]"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "`n[!] GPU 설치 실패. CPU 전용으로 재시도합니다..." -ForegroundColor Yellow
            & pip install -e .
        }
    } finally { Pop-Location }
}

function Python-Diagnose {
    Write-Host "`n[Python 환경 진단]`n" -ForegroundColor Green
    
    Write-Host "--- Python 버전 ---" -ForegroundColor Cyan
    python --version; Write-Host ""
    
    Write-Host "--- pip 버전 ---" -ForegroundColor Cyan
    pip --version; Write-Host ""
    
    Write-Host "--- CUDA 사용 가능 여부 ---" -ForegroundColor Cyan
    $cudaScript = "import torch; print('torch:', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('CUDA version:', torch.version.cuda if torch.cuda.is_available() else 'N/A')"
    & python -c $cudaScript 2>$null
    if ($LASTEXITCODE -ne 0) {
        & python -c "import ctranslate2; print('ctranslate2:', ctranslate2.__version__); devs=ctranslate2.get_cuda_device_count(); print('CUDA devices:', devs)" 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Host "[!] torch 및 ctranslate2 확인 실패 - 설치 상태를 점검하세요." -ForegroundColor Yellow }
    }
    Write-Host ""
    
    Write-Host "--- faster_whisper 설치 여부 ---" -ForegroundColor Cyan
    & python -c "import faster_whisper; print('faster_whisper: OK', faster_whisper.__version__)" 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "[!] faster_whisper 미설치" -ForegroundColor Yellow }
    Write-Host ""
    
    Write-Host "--- asr_worker_python 패키지 ---" -ForegroundColor Cyan
    & python -c "import asr_worker_python; print('asr_worker_python: OK')" 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "[!] asr_worker_python 미설치 - 메뉴 9번으로 설치하세요." -ForegroundColor Yellow }
    Write-Host ""
    
    Write-Host "--- 환경변수 ---" -ForegroundColor Cyan
    Write-Host "LUDO_WHISPER_MODEL=$($env:LUDO_WHISPER_MODEL ?? '(미설정, 기본 small)')"
    Write-Host "LUDO_GPU_COMPUTE_TYPE=$($env:LUDO_GPU_COMPUTE_TYPE ?? '(미설정, 기본 float16)')"
    Write-Host "LUDO_ASR_LANGUAGE=$($env:LUDO_ASR_LANGUAGE ?? '(미설정, 기본 auto)')"
    Write-Host ""
}

function Env-Info {
    Write-Host "`n[환경 정보]`n" -ForegroundColor Green
    
    Write-Host "--- 프로젝트 ---" -ForegroundColor Cyan
    Write-Host "PROJECT_ROOT: $global:ProjectRoot"
    Write-Host "SESSIONS_DIR: $global:SessionsDir`n"
    
    Write-Host "--- Node / pnpm ---" -ForegroundColor Cyan
    try { node --version } catch { Write-Host "[!] node 미설치" -ForegroundColor Yellow }
    try { pnpm --version } catch { Write-Host "[!] pnpm 미설치" -ForegroundColor Yellow }
    Write-Host ""
    
    Write-Host "--- Rust / Cargo ---" -ForegroundColor Cyan
    try { rustc --version } catch { Write-Host "[!] rustc 미설치" -ForegroundColor Yellow }
    try { cargo --version } catch { Write-Host "[!] cargo 미설치" -ForegroundColor Yellow }
    Write-Host ""
    
    Write-Host "--- Python ---" -ForegroundColor Cyan
    try { python --version } catch { Write-Host "[!] python 미설치" -ForegroundColor Yellow }
    Write-Host ""
    
    Write-Host "--- LUDO 환경변수 ---" -ForegroundColor Cyan
    Write-Host "LUDO_WHISPER_MODEL=$($env:LUDO_WHISPER_MODEL ?? '(미설정)')"
    Write-Host "LUDO_GPU_COMPUTE_TYPE=$($env:LUDO_GPU_COMPUTE_TYPE ?? '(미설정)')"
    Write-Host "LUDO_ASR_LANGUAGE=$($env:LUDO_ASR_LANGUAGE ?? '(미설정)')`n"
    
    Write-Host "--- 패키지 버전 ---" -ForegroundColor Cyan
    Write-Host "package.json: $(Get-PackageVersion)`n"
}

function Env-ComputeType {
    Write-Host "`n[GPU Compute Type 설정]" -ForegroundColor Green
    Write-Host "현재 세션에서만 유효합니다. 영구 설정은 시스템 환경변수를 사용하세요.`n" -ForegroundColor Gray
    
    Write-Host "현재 값: $($env:LUDO_GPU_COMPUTE_TYPE ?? '(미설정 - 기본값 float16 사용)')`n"
    
    Write-Host "선택 가능한 값:"
    Write-Host "  1. float16       - 품질 우선 (RTX GPU 기본값)"
    Write-Host "  2. int8_float16  - 속도 우선 (혼합 정밀도)"
    Write-Host "  3. int8          - CPU 전용"
    Write-Host "  c. 직접 입력"
    Write-Host "  q. 취소`n"
    
    $choice = Read-Host "선택"
    
    if ($choice -eq 'q') { return }
    $newCt = $null
    if ($choice -eq '1') { $newCt = "float16" }
    elseif ($choice -eq '2') { $newCt = "int8_float16" }
    elseif ($choice -eq '3') { $newCt = "int8" }
    elseif ($choice -eq 'c') { $newCt = Read-Host "compute_type 값 입력" }
    
    if ($newCt) {
        $env:LUDO_GPU_COMPUTE_TYPE = $newCt
        Write-Host "`n[OK] LUDO_GPU_COMPUTE_TYPE=$newCt (현재 세션 적용)`n" -ForegroundColor Green
    } else {
        Write-Host "`n[!] 변경하지 않았습니다.`n" -ForegroundColor Yellow
    }
}

function Env-SessionsOpen {
    Write-Host "`n[세션 폴더 열기] $global:SessionsDir`n" -ForegroundColor Green
    if (-not (Test-Path $global:SessionsDir)) {
        Write-Host "[!] 세션 폴더가 없습니다. 아직 세션을 실행하지 않은 경우 정상입니다.`n" -ForegroundColor Yellow
    } else {
        Invoke-Item $global:SessionsDir
        Write-Host "[OK] 탐색기로 열었습니다.`n" -ForegroundColor Green
    }
}

function Env-SessionsClean {
    Write-Host "`n[오래된 세션 정리]" -ForegroundColor Green
    Write-Host "세션 폴더: $global:SessionsDir`n" -ForegroundColor Gray
    
    if (-not (Test-Path $global:SessionsDir)) {
        Write-Host "[!] 세션 폴더가 없습니다.`n" -ForegroundColor Yellow
        return
    }
    
    Write-Host "몇 일 이전 세션을 삭제할지 입력하세요."
    $daysInput = Read-Host "일 수 [기본: 30]"
    $days = if ([string]::IsNullOrWhiteSpace($daysInput)) { 30 } else { [int]$daysInput }
    
    Write-Host "`n[!] $days 일 이전 세션 폴더를 삭제합니다." -ForegroundColor Red
    $confirm = Read-Host "계속하려면 'Y' 입력"
    
    if ($confirm -eq 'Y') {
        Get-ChildItem -Path $global:SessionsDir -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$days) } | ForEach-Object {
            Remove-Item $_.FullName -Recurse -Force
            Write-Host "[삭제] $($_.Name)" -ForegroundColor DarkGray
        }
        Write-Host "`n[OK] 정리 완료.`n" -ForegroundColor Green
    } else {
        Write-Host "`n[!] 취소되었습니다.`n" -ForegroundColor Yellow
    }
}

function Save-HistorySnapshot {
    $historyPath = Join-Path $global:ProjectRoot "history.md"

    if (-not (Test-Path $historyPath)) {
        Write-Host "[INFO] history.md 없음, 아카이브 건너뜀." -ForegroundColor Gray
        return
    }

    $aiHistoryDir = Join-Path $global:ProjectRoot "AIHistory"
    if (-not (Test-Path $aiHistoryDir)) {
        New-Item -ItemType Directory -Path $aiHistoryDir -Force | Out-Null
    }

    # Derive slug from first content line of "## Current Goal" section
    $lines = Get-Content $historyPath
    $slug = "worklog"
    $inGoal = $false
    foreach ($line in $lines) {
        if ($line -match '^##\s*Current Goal') {
            $inGoal = $true
            continue
        }
        if ($inGoal) {
            if ($line -match '^#') { break }
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $raw = $line.Trim() -replace '[^\w\s-]', '' -replace '\s+', '-'
            $candidate = ($raw.ToLower() -replace '[^a-z0-9-]', '').Trim('-')
            if ($candidate.Length -gt 30) { $candidate = $candidate.Substring(0, 30).TrimEnd('-') }
            if (-not [string]::IsNullOrEmpty($candidate)) { $slug = $candidate }
            break
        }
    }

    $ts = (Get-Date).ToString("yyyyMMdd_HHmm")
    $archiveName = "${ts}_${slug}.md"
    $archivePath = Join-Path $aiHistoryDir $archiveName

    Copy-Item $historyPath $archivePath
    Write-Host "[INFO] history.md 아카이브 → AIHistory\$archiveName" -ForegroundColor Gray
}

function Git-Commit {
    Write-Host "`n[작업 내용 Commit]" -ForegroundColor Green
    Write-Host "변경된 모든 파일을 스테이징합니다 (git add .)." -ForegroundColor Gray
    & git -C $global:ProjectRoot add .
    Write-Host ""
    
    $suggestedFile = Join-Path $global:ProjectRoot "SuggestedCommit.txt"
    $defaultMsg = if (Test-Path $suggestedFile) { Get-Content $suggestedFile -Raw } else { $null }
    
    if ($defaultMsg) {
        Write-Host "[AI 제안 메시지]: $defaultMsg" -ForegroundColor Cyan
        Write-Host "커밋 메시지를 직접 입력하거나, Enter 시 제안 메시지를 사용하세요. (q 입력 시 취소)"
    } else {
        Write-Host "커밋 메시지를 입력하세요. (q 입력 시 취소)"
    }
    
    $userInput = Read-Host "입력"
    
    if ($userInput -eq 'q') {
        Write-Host "[!] 커밋이 취소되었습니다.`n" -ForegroundColor Yellow
        return
    }
    
    $commitMsg = if ([string]::IsNullOrWhiteSpace($userInput)) { $defaultMsg } else { $userInput }
    
    if ([string]::IsNullOrWhiteSpace($commitMsg)) {
        Write-Host "[!] 커밋 메시지가 필요합니다.`n" -ForegroundColor Red
        return
    }
    
    $cleanMsg = $commitMsg -replace '\[Suggested Commit\] ', '' -replace 'git commit -m ', '' -replace '"', ''
    $cleanMsg = $cleanMsg.Trim()

    Save-HistorySnapshot
    & git -C $global:ProjectRoot commit -m $cleanMsg
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 커밋 실패! (변경사항 없거나 git 오류)`n" -ForegroundColor Red
    } else {
        Write-Host "[OK] 커밋 완료!" -ForegroundColor Green
        if (Test-Path $suggestedFile) {
            Clear-Content $suggestedFile
            Write-Host "[INFO] SuggestedCommit.txt 내용을 지웠습니다.`n" -ForegroundColor Gray
        }
    }
}

function Git-Release {
    Write-Host "`n[버전 업 / 태그 생성 / Push]" -ForegroundColor Green
    
    $pkgVer = Get-PackageVersion
    if ($pkgVer -eq "unknown") {
        Write-Host "[ERROR] package.json 에서 버전을 읽을 수 없습니다.`n" -ForegroundColor Red
        return
    }
    
    $parts = $pkgVer -split '\.'
    $autoVersion = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
    $tagTs = (Get-Date).ToString("yyMMddHHmmss")
    $defaultTag = "v${autoVersion}_$tagTs"
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "  현재 버전: $pkgVer" -ForegroundColor Cyan
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    $userVerInput = Read-Host "새 버전 입력 [엔터 시 기본값: $autoVersion]"
    $userVer = if ([string]::IsNullOrWhiteSpace($userVerInput)) { $autoVersion } else { $userVerInput }
    
    Write-Host ""
    $tagNameInput = Read-Host "태그명 입력 [엔터 시 기본값: $defaultTag / q 취소]"
    if ($tagNameInput -eq 'q') {
        Write-Host "[!] 취소되었습니다.`n" -ForegroundColor Yellow
        return
    }
    $tagName = if ([string]::IsNullOrWhiteSpace($tagNameInput)) { $defaultTag } else { $tagNameInput }
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "[1/5] 버전 파일 업데이트 중... [$pkgVer -> $userVer]"
    Write-Host "      - package.json"
    Write-Host "      - apps\client-tauri\src-tauri\Cargo.toml"
    Write-Host "      - apps\client-tauri\src-tauri\tauri.conf.json"
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    # package.json
    $pkgJsonPath = Join-Path $global:ProjectRoot "package.json"
    $text = Get-Content $pkgJsonPath -Raw
    $text = $text -replace '("version"\s*:\s*")[^"]*(")', "`${1}$userVer`$2"
    [System.IO.File]::WriteAllText($pkgJsonPath, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[OK] package.json updated" -ForegroundColor Green
    
    # Cargo.toml
    $cargoTomlPath = Join-Path $global:ProjectRoot "apps\client-tauri\src-tauri\Cargo.toml"
    $lines = Get-Content $cargoTomlPath
    $replaced = $false
    $out = foreach ($line in $lines) {
        if (-not $replaced -and $line -match '^version\s*=\s*"[^"]*"') {
            $replaced = $true
            "version = `"$userVer`""
        } else {
            $line
        }
    }
    [System.IO.File]::WriteAllText($cargoTomlPath, ($out -join "`r`n") + "`r`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "[OK] Cargo.toml updated" -ForegroundColor Green
    
    # tauri.conf.json
    $tauriConfPath = Join-Path $global:ProjectRoot "apps\client-tauri\src-tauri\tauri.conf.json"
    if (Test-Path $tauriConfPath) {
        $text = Get-Content $tauriConfPath -Raw
        $text = $text -replace '("version"\s*:\s*")[^"]*(")', "`${1}$userVer`$2"
        [System.IO.File]::WriteAllText($tauriConfPath, $text, [System.Text.UTF8Encoding]::new($false))
        Write-Host "[OK] tauri.conf.json updated" -ForegroundColor Green
    }
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "[2/5] 타입 체크 (pnpm check)..."
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    Push-Location $global:ProjectRoot
    try { pnpm check } finally { Pop-Location }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n[!] 타입 체크 실패. 계속 진행하시겠습니까?" -ForegroundColor Yellow
        $forceCont = Read-Host "계속 진행: Y / 중단: 그 외 입력"
        if ($forceCont -ne 'Y') {
            Write-Host "[!] 버전 업이 취소되었습니다. 버전 파일은 이미 수정되었습니다.`n" -ForegroundColor Red
            return
        }
    }
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "[3/5] 버전 파일 커밋 중..."
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    & git -C $global:ProjectRoot add $pkgJsonPath $cargoTomlPath $tauriConfPath
    Save-HistorySnapshot
    & git -C $global:ProjectRoot commit -m "chore: bump version to $userVer [$tagName]"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] 커밋할 내용 없거나 실패 - 이미 최신 상태일 수 있습니다." -ForegroundColor Yellow
    }
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "[4/5] 원격 저장소 Push 중... [git push origin main]"
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    & git -C $global:ProjectRoot push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Push 실패! 위 오류 로그를 확인하세요.`n" -ForegroundColor Red
        return
    }
    
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "[5/5] 태그 생성 및 Push 중... [$tagName]"
    Write-Host "============================================================`n" -ForegroundColor Cyan
    
    & git -C $global:ProjectRoot tag $tagName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 태그 [$tagName] 생성 실패! 이미 존재하는 태그일 수 있습니다.`n" -ForegroundColor Red
        return
    }
    & git -C $global:ProjectRoot push origin $tagName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 태그 Push 실패!`n" -ForegroundColor Red
        return
    }
    
    Write-Host "`n[OK] 버전 [$userVer] 업데이트 및 태그 [$tagName] 배포 완료!`n" -ForegroundColor Green
}

function Git-Revert {
    Write-Host "`n[위험: 모든 로컬 변경사항 되돌리기]" -ForegroundColor Red
    Write-Host "커밋하지 않은 모든 변경사항이 영구적으로 삭제됩니다." -ForegroundColor Red
    Write-Host "정말로 마지막 커밋 상태로 되돌리시겠습니까?`n" -ForegroundColor Red
    
    $confirm = Read-Host "진행하려면 'Y' 입력 (그 외 취소)"
    
    if ($confirm -eq 'Y') {
        Write-Host ""
        & git -C $global:ProjectRoot reset --hard HEAD
        & git -C $global:ProjectRoot clean -fd
        Write-Host "`n[OK] 모든 로컬 변경사항이 초기화되었습니다.`n" -ForegroundColor Green
    } else {
        Write-Host "`n[!] 취소되었습니다.`n" -ForegroundColor Yellow
    }
}

# Main Loop
while ($true) {
    Show-Menu
    $choice = Read-Host "선택"
    
    switch ($choice) {
        '1'  { Run-Web }
        '2'  { Run-Desktop }
        '3'  { Run-AsrWorker }
        '4'  { Build-Install }
        '5'  { Build-Web }
        '6'  { Build-Check }
        '7'  { Build-Tauri }
        '8'  { Build-CargoTest }
        '9'  { Python-Install }
        '10' { Python-Diagnose }
        '11' { Env-Info }
        '12' { Env-ComputeType }
        '13' { Env-SessionsOpen }
        '14' { Env-SessionsClean }
        '15' { Git-Commit }
        '16' { Git-Release }
        '17' { Git-Revert }
        '0'  { break }
        default {
            Write-Host "[!] 잘못된 입력입니다." -ForegroundColor Red
            Start-Sleep -Seconds 2
            continue
        }
    }
    
    if ($choice -ne '0') {
        Write-Host "계속하려면 아무 키나 누르세요..." -ForegroundColor Gray
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    }
}

Write-Host "종료합니다." -ForegroundColor Cyan
