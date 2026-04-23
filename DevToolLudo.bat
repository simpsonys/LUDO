@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: ============================================================
::  LUDO 개발 도구 - Build / Run / Test / Git
:: ============================================================

:: ---------- 프로젝트 루트 ----------
set "PROJECT_ROOT=%~dp0"
set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"

:: ---------- PowerShell 경로 ----------
set "PS_EXE=powershell"
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
)

:: ---------- 세션 폴더 ----------
set "SESSIONS_DIR=%LOCALAPPDATA%\LUDO\sessions"

:MENU
cls
call :GET_PACKAGE_VERSION
echo ============================================================
echo   LUDO 개발 도구  [v!PKG_VERSION!]
echo   %PROJECT_ROOT%
echo ============================================================
echo.
echo   [ RUN ]
echo   1. Web 개발 서버 실행  (pnpm dev)
echo   2. Desktop 앱 실행     (tauri dev)
echo   3. ASR Python 워커 단독 실행
echo.
echo   [ BUILD ]
echo   4. 의존성 설치         (pnpm install)
echo   5. Web 빌드            (pnpm build)
echo   6. 타입 체크           (pnpm check)
echo   7. Desktop 릴리즈 빌드 (tauri build)
echo   8. Rust 단위 테스트    (cargo test)
echo.
echo   [ PYTHON WORKER ]
echo   9. Python 의존성 설치/업데이트
echo  10. Python 환경 진단
echo.
echo   [ ENVIRONMENT ]
echo  11. 환경 정보 확인
echo  12. GPU Compute Type 설정  (LUDO_GPU_COMPUTE_TYPE)
echo  13. 세션 폴더 열기
echo  14. 오래된 세션 정리
echo.
echo   [ GIT ]
echo  15. 작업 내용 Commit
echo  16. 버전 업 / 태그 생성 / Push
echo  17. 모든 로컬 변경사항 되돌리기
echo.
echo   0. 종료
echo.
echo ============================================================
set /p "CHOICE=선택: "

if "%CHOICE%"=="1"  goto RUN_WEB
if "%CHOICE%"=="2"  goto RUN_DESKTOP
if "%CHOICE%"=="3"  goto RUN_ASR_WORKER
if "%CHOICE%"=="4"  goto BUILD_INSTALL
if "%CHOICE%"=="5"  goto BUILD_WEB
if "%CHOICE%"=="6"  goto BUILD_CHECK
if "%CHOICE%"=="7"  goto BUILD_TAURI
if "%CHOICE%"=="8"  goto BUILD_CARGO_TEST
if "%CHOICE%"=="9"  goto PYTHON_INSTALL
if "%CHOICE%"=="10" goto PYTHON_DIAGNOSE
if "%CHOICE%"=="11" goto ENV_INFO
if "%CHOICE%"=="12" goto ENV_COMPUTE_TYPE
if "%CHOICE%"=="13" goto ENV_SESSIONS_OPEN
if "%CHOICE%"=="14" goto ENV_SESSIONS_CLEAN
if "%CHOICE%"=="15" goto GIT_COMMIT
if "%CHOICE%"=="16" goto GIT_RELEASE
if "%CHOICE%"=="17" goto GIT_REVERT
if "%CHOICE%"=="0"  goto END
echo [!] 잘못된 입력입니다.
timeout /t 2 >nul
goto MENU

:: ----------------------------------------------------------
:RUN_WEB
:: ----------------------------------------------------------
echo.
echo [Web 개발 서버] pnpm dev - http://localhost:1420
echo Ctrl+C 로 종료합니다.
echo.
cd /d "!PROJECT_ROOT!\apps\client-tauri"
pnpm dev
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:RUN_DESKTOP
:: ----------------------------------------------------------
echo.
echo [Desktop 앱] tauri dev (Rust + React 핫리로드)
echo 첫 실행시 Rust 컴파일로 수 분 소요될 수 있습니다.
echo Ctrl+C 로 종료합니다.
echo.
cd /d "!PROJECT_ROOT!\apps\client-tauri"
pnpm tauri dev
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:RUN_ASR_WORKER
:: ----------------------------------------------------------
echo.
echo [ASR Python 워커 단독 실행]
echo.
echo 실행 모드를 선택하세요:
echo   1. file    - 파일 트랜스크립션 (stdin JSON)
echo   2. mic_stream - 마이크 스트리밍 (stdin/stdout JSON)
echo   q. 취소
echo.
set /p "WORKER_MODE=모드 선택: "
if /i "!WORKER_MODE!"=="q" goto MENU
if "!WORKER_MODE!"=="" set "WORKER_MODE=file"

set "WORKER_BACKEND=local_gpu"
set /p "WORKER_BACKEND=백엔드 ^(local_gpu / local_cpu^) [기본: local_gpu]: "
if "!WORKER_BACKEND!"=="" set "WORKER_BACKEND=local_gpu"

echo.
echo 환경변수: LUDO_WHISPER_MODEL, LUDO_GPU_COMPUTE_TYPE 현재값 사용
if defined LUDO_GPU_COMPUTE_TYPE (
    echo   LUDO_GPU_COMPUTE_TYPE=!LUDO_GPU_COMPUTE_TYPE!
) else (
    echo   LUDO_GPU_COMPUTE_TYPE=^(미설정, 기본 float16^)
)
echo.
cd /d "!PROJECT_ROOT!\services\asr-worker-python"
python -m asr_worker_python.worker
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:BUILD_INSTALL
:: ----------------------------------------------------------
echo.
echo [의존성 설치] pnpm install
echo.
cd /d "!PROJECT_ROOT!"
pnpm install
if errorlevel 1 (
    echo [ERROR] pnpm install 실패!
) else (
    echo [OK] 의존성 설치 완료!
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:BUILD_WEB
:: ----------------------------------------------------------
echo.
echo [Web 빌드] pnpm build
echo.
cd /d "!PROJECT_ROOT!"
pnpm build
if errorlevel 1 (
    echo [ERROR] Web 빌드 실패!
) else (
    echo [OK] Web 빌드 완료!
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:BUILD_CHECK
:: ----------------------------------------------------------
echo.
echo [타입 체크] pnpm check
echo.
cd /d "!PROJECT_ROOT!"
pnpm check
if errorlevel 1 (
    echo [ERROR] 타입 체크 실패! 위 오류를 확인하세요.
) else (
    echo [OK] 타입 체크 통과!
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:BUILD_TAURI
:: ----------------------------------------------------------
echo.
echo [Desktop 릴리즈 빌드] pnpm tauri build
echo Rust 컴파일이 포함되어 상당한 시간이 소요됩니다.
echo.
cd /d "!PROJECT_ROOT!\apps\client-tauri"
pnpm tauri build
if errorlevel 1 (
    echo [ERROR] Tauri 빌드 실패!
) else (
    echo [OK] Tauri 릴리즈 빌드 완료!
    echo 결과물: apps\client-tauri\src-tauri\target\release\bundle\
)
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:BUILD_CARGO_TEST
:: ----------------------------------------------------------
echo.
echo [Rust 단위 테스트] cargo test
echo.
cd /d "!PROJECT_ROOT!\apps\client-tauri\src-tauri"
cargo test
if errorlevel 1 (
    echo [ERROR] 일부 Rust 테스트 실패!
) else (
    echo [OK] 모든 Rust 테스트 통과!
)
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:PYTHON_INSTALL
:: ----------------------------------------------------------
echo.
echo [Python 의존성 설치/업데이트]
echo services\asr-worker-python 의 pyproject.toml 기준으로 설치합니다.
echo.
cd /d "!PROJECT_ROOT!\services\asr-worker-python"
pip install -e ".[gpu]"
if errorlevel 1 (
    echo.
    echo [!] GPU 설치 실패. CPU 전용으로 재시도합니다...
    pip install -e .
)
cd /d "!PROJECT_ROOT!"
echo.
pause
goto MENU

:: ----------------------------------------------------------
:PYTHON_DIAGNOSE
:: ----------------------------------------------------------
echo.
echo [Python 환경 진단]
echo.
echo --- Python 버전 ---
python --version
echo.
echo --- pip 버전 ---
pip --version
echo.
echo --- CUDA 사용 가능 여부 ---
python -c "import torch; print('torch:', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('CUDA version:', torch.version.cuda if torch.cuda.is_available() else 'N/A')" 2>nul
if errorlevel 1 (
    python -c "import ctranslate2; print('ctranslate2:', ctranslate2.__version__); devs=ctranslate2.get_cuda_device_count(); print('CUDA devices:', devs)" 2>nul
    if errorlevel 1 echo [!] torch 및 ctranslate2 확인 실패 - 설치 상태를 점검하세요.
)
echo.
echo --- faster-whisper 설치 여부 ---
python -c "import faster_whisper; print('faster_whisper: OK', faster_whisper.__version__)" 2>nul
if errorlevel 1 echo [!] faster_whisper 미설치
echo.
echo --- asr_worker_python 패키지 ---
python -c "import asr_worker_python; print('asr_worker_python: OK')" 2>nul
if errorlevel 1 echo [!] asr_worker_python 미설치 - 메뉴 9번으로 설치하세요.
echo.
echo --- 환경변수 ---
if defined LUDO_WHISPER_MODEL (
    echo LUDO_WHISPER_MODEL=!LUDO_WHISPER_MODEL!
) else (
    echo LUDO_WHISPER_MODEL=^(미설정, 기본 small^)
)
if defined LUDO_GPU_COMPUTE_TYPE (
    echo LUDO_GPU_COMPUTE_TYPE=!LUDO_GPU_COMPUTE_TYPE!
) else (
    echo LUDO_GPU_COMPUTE_TYPE=^(미설정, 기본 float16^)
)
if defined LUDO_ASR_LANGUAGE (
    echo LUDO_ASR_LANGUAGE=!LUDO_ASR_LANGUAGE!
) else (
    echo LUDO_ASR_LANGUAGE=^(미설정, 기본 auto^)
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:ENV_INFO
:: ----------------------------------------------------------
echo.
echo [환경 정보]
echo.
echo --- 프로젝트 ---
echo PROJECT_ROOT: !PROJECT_ROOT!
echo SESSIONS_DIR: !SESSIONS_DIR!
echo.
echo --- Node / pnpm ---
node --version 2>nul || echo [!] node 미설치
pnpm --version 2>nul || echo [!] pnpm 미설치
echo.
echo --- Rust / Cargo ---
rustc --version 2>nul || echo [!] rustc 미설치
cargo --version 2>nul || echo [!] cargo 미설치
echo.
echo --- Python ---
python --version 2>nul || echo [!] python 미설치
echo.
echo --- LUDO 환경변수 ---
if defined LUDO_WHISPER_MODEL (echo LUDO_WHISPER_MODEL=!LUDO_WHISPER_MODEL!) else (echo LUDO_WHISPER_MODEL=^(미설정^))
if defined LUDO_GPU_COMPUTE_TYPE (echo LUDO_GPU_COMPUTE_TYPE=!LUDO_GPU_COMPUTE_TYPE!) else (echo LUDO_GPU_COMPUTE_TYPE=^(미설정^))
if defined LUDO_ASR_LANGUAGE (echo LUDO_ASR_LANGUAGE=!LUDO_ASR_LANGUAGE!) else (echo LUDO_ASR_LANGUAGE=^(미설정^))
echo.
echo --- 패키지 버전 ---
call :GET_PACKAGE_VERSION
echo package.json: !PKG_VERSION!
echo.
pause
goto MENU

:: ----------------------------------------------------------
:ENV_COMPUTE_TYPE
:: ----------------------------------------------------------
echo.
echo [GPU Compute Type 설정]
echo 현재 세션에서만 유효합니다. 영구 설정은 시스템 환경변수를 사용하세요.
echo.
if defined LUDO_GPU_COMPUTE_TYPE (
    echo 현재 값: !LUDO_GPU_COMPUTE_TYPE!
) else (
    echo 현재 값: ^(미설정 - 기본값 float16 사용^)
)
echo.
echo 선택 가능한 값:
echo   1. float16       - 품질 우선 ^(RTX GPU 기본값^)
echo   2. int8_float16  - 속도 우선 ^(혼합 정밀도^)
echo   3. int8          - CPU 전용
echo   c. 직접 입력
echo   q. 취소
echo.
set /p "CT_CHOICE=선택: "

if /i "!CT_CHOICE!"=="q" goto MENU
if "!CT_CHOICE!"=="1" set "NEW_CT=float16"
if "!CT_CHOICE!"=="2" set "NEW_CT=int8_float16"
if "!CT_CHOICE!"=="3" set "NEW_CT=int8"
if /i "!CT_CHOICE!"=="c" (
    set /p "NEW_CT=compute_type 값 입력: "
)

if defined NEW_CT (
    set "LUDO_GPU_COMPUTE_TYPE=!NEW_CT!"
    echo.
    echo [OK] LUDO_GPU_COMPUTE_TYPE=!NEW_CT! ^(현재 세션 적용^)
) else (
    echo [!] 변경하지 않았습니다.
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:ENV_SESSIONS_OPEN
:: ----------------------------------------------------------
echo.
echo [세션 폴더 열기] !SESSIONS_DIR!
echo.
if not exist "!SESSIONS_DIR!" (
    echo [!] 세션 폴더가 없습니다. 아직 세션을 실행하지 않은 경우 정상입니다.
) else (
    explorer "!SESSIONS_DIR!"
    echo [OK] 탐색기로 열었습니다.
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:ENV_SESSIONS_CLEAN
:: ----------------------------------------------------------
echo.
echo [오래된 세션 정리]
echo 세션 폴더: !SESSIONS_DIR!
echo.
if not exist "!SESSIONS_DIR!" (
    echo [!] 세션 폴더가 없습니다.
    pause
    goto MENU
)

echo 몇 일 이전 세션을 삭제할지 입력하세요.
set /p "DAYS_OLD=일 수 [기본: 30]: "
if "!DAYS_OLD!"=="" set "DAYS_OLD=30"

echo.
echo [!] !DAYS_OLD!일 이전 세션 폴더를 삭제합니다.
set /p "CONFIRM=계속하려면 'Y' 입력: "
if /i "!CONFIRM!"=="Y" (
    "!PS_EXE!" -NoProfile -Command ^
        "Get-ChildItem -Path '!SESSIONS_DIR!' -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-!DAYS_OLD!) } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force; Write-Host ('[삭제]', $_.Name) }"
    echo.
    echo [OK] 정리 완료.
) else (
    echo [!] 취소되었습니다.
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:GIT_COMMIT
:: ----------------------------------------------------------
echo.
echo [작업 내용 Commit]
echo 변경된 모든 파일을 스테이징합니다 (git add .).
git -C "!PROJECT_ROOT!" add .
echo.

set "DEFAULT_MSG="
if exist "!PROJECT_ROOT!\SuggestedCommit.txt" (
    for /f "usebackq delims=" %%i in ("!PROJECT_ROOT!\SuggestedCommit.txt") do set "DEFAULT_MSG=%%i"
)

if defined DEFAULT_MSG (
    echo [AI 제안 메시지]: !DEFAULT_MSG!
    echo 커밋 메시지를 직접 입력하거나, Enter 시 제안 메시지를 사용하세요. ^(q 입력 시 취소^)
) else (
    echo 커밋 메시지를 입력하세요. ^(q 입력 시 취소^)
)

set "USER_INPUT="
set /p "USER_INPUT=입력: "

if /i "!USER_INPUT!"=="q" (
    echo [!] 커밋이 취소되었습니다.
    pause
    goto MENU
)

set "COMMIT_MSG="
if not defined USER_INPUT (
    if defined DEFAULT_MSG (
        set "COMMIT_MSG=!DEFAULT_MSG!"
    ) else (
        echo [!] 커밋 메시지가 필요합니다.
        pause
        goto MENU
    )
) else (
    set "COMMIT_MSG=!USER_INPUT!"
)

set "CLEAN_MSG=!COMMIT_MSG:[Suggested Commit] =!"
set "CLEAN_MSG=!CLEAN_MSG:git commit -m =!"
set "CLEAN_MSG=!CLEAN_MSG:"=!"

git -C "!PROJECT_ROOT!" commit -m "!CLEAN_MSG!"
if errorlevel 1 (
    echo [ERROR] 커밋 실패! ^(변경사항 없거나 git 오류^)
) else (
    echo [OK] 커밋 완료!
    if exist "!PROJECT_ROOT!\SuggestedCommit.txt" (
        break > "!PROJECT_ROOT!\SuggestedCommit.txt"
        echo [INFO] SuggestedCommit.txt 내용을 지웠습니다.
    )
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:GIT_RELEASE
:: ----------------------------------------------------------
echo.
echo [버전 업 / 태그 생성 / Push]

:: 현재 버전 읽기
call :GET_PACKAGE_VERSION
if "!PKG_VERSION!"=="" (
    echo [ERROR] package.json 에서 버전을 읽을 수 없습니다.
    pause
    goto MENU
)

:: Patch 자동 증가
for /f "tokens=1,2,3 delims=." %%a in ("!PKG_VERSION!") do (
    set "V1=%%a"
    set "V2=%%b"
    set "V3=%%c"
)
set /a V3_NEW=V3 + 1
set "AUTO_VERSION=!V1!.!V2!.!V3_NEW!"

:: 타임스탬프 (태그용)
set "YY=%date:~2,2%"
set "MM=%date:~5,2%"
set "DD=%date:~8,2%"
set "HH=%time:~0,2%"
if "%HH:~0,1%"==" " set "HH=0%HH:~1,1%"
set "MIN=%time:~3,2%"
set "SEC=%time:~6,2%"
set "TAG_TS=!YY!!MM!!DD!!HH!!MIN!!SEC!"

set "DEFAULT_TAG=v!AUTO_VERSION!_!TAG_TS!"

echo.
echo ============================================================
echo   현재 버전: !PKG_VERSION!
echo ============================================================
echo.
set /p "USER_VERSION=새 버전 입력 [엔터 시 기본값: !AUTO_VERSION!]: "
if "!USER_VERSION!"=="" set "USER_VERSION=!AUTO_VERSION!"

echo.
set /p "TAG_NAME=태그명 입력 [엔터 시 기본값: !DEFAULT_TAG! / q 취소]: "
if /i "!TAG_NAME!"=="q" (
    echo [!] 취소되었습니다.
    pause
    goto MENU
)
if "!TAG_NAME!"=="" set "TAG_NAME=!DEFAULT_TAG!"

echo.
echo ============================================================
echo [1/5] 버전 파일 업데이트 중... [!PKG_VERSION! -^> !USER_VERSION!]
echo       - package.json
echo       - apps\client-tauri\src-tauri\Cargo.toml
echo       - apps\client-tauri\src-tauri\tauri.conf.json
echo ============================================================

:: PowerShell 스크립트를 임시 파일로 작성 후 실행
set "PS_SCRIPT=%TEMP%\ludo_version_bump.ps1"
set "PKG_JSON=!PROJECT_ROOT!\package.json"
set "CARGO_TOML=!PROJECT_ROOT!\apps\client-tauri\src-tauri\Cargo.toml"
set "TAURI_CONF=!PROJECT_ROOT!\apps\client-tauri\src-tauri\tauri.conf.json"

echo $dq = [char]34 > "!PS_SCRIPT!"
echo $newVer = '!USER_VERSION!' >> "!PS_SCRIPT!"
echo. >> "!PS_SCRIPT!"
echo # --- package.json --- >> "!PS_SCRIPT!"
echo $path = '!PKG_JSON!' >> "!PS_SCRIPT!"
echo $text = Get-Content -Path $path -Raw >> "!PS_SCRIPT!"
echo $text = $text -replace ^('"version"\s*:\s*"[^"]*"'^), ^('"version": "' + $newVer + '"'^) >> "!PS_SCRIPT!"
echo [System.IO.File]::WriteAllText^($path, $text, ^(New-Object System.Text.UTF8Encoding^($false^)^)^) >> "!PS_SCRIPT!"
echo Write-Host '[OK] package.json updated' >> "!PS_SCRIPT!"
echo. >> "!PS_SCRIPT!"
echo # --- Cargo.toml ^(first version = line only, in [package] section^) --- >> "!PS_SCRIPT!"
echo $path = '!CARGO_TOML!' >> "!PS_SCRIPT!"
echo $lines = Get-Content -Path $path >> "!PS_SCRIPT!"
echo $replaced = $false >> "!PS_SCRIPT!"
echo $out = $lines ^| ForEach-Object ^{ >> "!PS_SCRIPT!"
echo     if ^(-not $replaced -and $_ -match '^version\s*=\s*"[^"]*"'^) ^{ >> "!PS_SCRIPT!"
echo         $replaced = $true >> "!PS_SCRIPT!"
echo         'version = "' + $newVer + '"' >> "!PS_SCRIPT!"
echo     ^} else ^{ $_ ^} >> "!PS_SCRIPT!"
echo ^} >> "!PS_SCRIPT!"
echo [System.IO.File]::WriteAllText^($path, ^($out -join "`r`n"^) + "`r`n", ^(New-Object System.Text.UTF8Encoding^($false^)^)^) >> "!PS_SCRIPT!"
echo Write-Host '[OK] Cargo.toml updated' >> "!PS_SCRIPT!"
echo. >> "!PS_SCRIPT!"
echo # --- tauri.conf.json ^(optional, skip if missing^) --- >> "!PS_SCRIPT!"
echo $path = '!TAURI_CONF!' >> "!PS_SCRIPT!"
echo if ^(Test-Path $path^) ^{ >> "!PS_SCRIPT!"
echo     $text = Get-Content -Path $path -Raw >> "!PS_SCRIPT!"
echo     $text = $text -replace ^('"version"\s*:\s*"[^"]*"'^), ^('"version": "' + $newVer + '"'^) >> "!PS_SCRIPT!"
echo     [System.IO.File]::WriteAllText^($path, $text, ^(New-Object System.Text.UTF8Encoding^($false^)^)^) >> "!PS_SCRIPT!"
echo     Write-Host '[OK] tauri.conf.json updated' >> "!PS_SCRIPT!"
echo ^} else ^{ Write-Host '[SKIP] tauri.conf.json not found' ^} >> "!PS_SCRIPT!"

"!PS_EXE!" -ExecutionPolicy Bypass -File "!PS_SCRIPT!"
if errorlevel 1 (
    echo [ERROR] 버전 파일 업데이트 실패!
    if exist "!PS_SCRIPT!" del "!PS_SCRIPT!"
    pause
    goto MENU
)
if exist "!PS_SCRIPT!" del "!PS_SCRIPT!"

echo.
echo ============================================================
echo [2/5] 타입 체크 (pnpm check)...
echo ============================================================
cd /d "!PROJECT_ROOT!"
pnpm check
if errorlevel 1 (
    echo.
    echo [!] 타입 체크 실패. 계속 진행하시겠습니까?
    set /p "FORCE_CONT=계속 진행: Y / 중단: 그 외 입력: "
    if /i not "!FORCE_CONT!"=="Y" (
        echo [!] 버전 업이 취소되었습니다. 버전 파일은 이미 수정되었습니다.
        pause
        goto MENU
    )
)

echo.
echo ============================================================
echo [3/5] 버전 파일 커밋 중...
echo ============================================================
git -C "!PROJECT_ROOT!" add "!PKG_JSON!" "!CARGO_TOML!" "!TAURI_CONF!"
git -C "!PROJECT_ROOT!" commit -m "chore: bump version to !USER_VERSION! [!TAG_NAME!]"
if errorlevel 1 (
    echo [!] 커밋할 내용 없거나 실패 - 이미 최신 상태일 수 있습니다.
)

echo.
echo ============================================================
echo [4/5] 원격 저장소 Push 중... [git push origin main]
echo ============================================================
git -C "!PROJECT_ROOT!" push origin main
if errorlevel 1 (
    echo [ERROR] Push 실패! 위 오류 로그를 확인하세요.
    pause
    goto MENU
)

echo.
echo ============================================================
echo [5/5] 태그 생성 및 Push 중... [!TAG_NAME!]
echo ============================================================
git -C "!PROJECT_ROOT!" tag !TAG_NAME!
if errorlevel 1 (
    echo [ERROR] 태그 [!TAG_NAME!] 생성 실패! 이미 존재하는 태그일 수 있습니다.
    pause
    goto MENU
)
git -C "!PROJECT_ROOT!" push origin !TAG_NAME!
if errorlevel 1 (
    echo [ERROR] 태그 Push 실패!
    pause
    goto MENU
)

echo.
echo [OK] 버전 [!USER_VERSION!] 업데이트 및 태그 [!TAG_NAME!] 배포 완료!
echo.
pause
goto MENU

:: ----------------------------------------------------------
:GIT_REVERT
:: ----------------------------------------------------------
echo.
echo [위험: 모든 로컬 변경사항 되돌리기]
echo 커밋하지 않은 모든 변경사항이 영구적으로 삭제됩니다.
echo 정말로 마지막 커밋 상태로 되돌리시겠습니까?
echo.
set /p "CONFIRM=진행하려면 'Y' 입력 ^(그 외 취소^): "

if /i "!CONFIRM!"=="Y" (
    echo.
    git -C "!PROJECT_ROOT!" reset --hard HEAD
    git -C "!PROJECT_ROOT!" clean -fd
    echo.
    echo [OK] 모든 로컬 변경사항이 초기화되었습니다.
) else (
    echo.
    echo [!] 취소되었습니다.
)
echo.
pause
goto MENU

:: ----------------------------------------------------------
:END
:: ----------------------------------------------------------
echo.
echo 종료합니다.
endlocal
exit /b 0

:: ============================================================
:: 서브루틴: package.json 에서 버전 추출
:: ============================================================
:GET_PACKAGE_VERSION
set "PKG_VERSION="
set "VER_TMP=%TEMP%\ludo_ver_tmp.txt"
"!PS_EXE!" -NoProfile -Command "try{(Get-Content '!PROJECT_ROOT!\package.json' -Raw | ConvertFrom-Json).version}catch{''}" > "!VER_TMP!" 2>nul
if exist "!VER_TMP!" (
    for /f "usebackq delims=" %%V in ("!VER_TMP!") do (
        if not defined PKG_VERSION set "PKG_VERSION=%%V"
    )
    del "!VER_TMP!" >nul 2>&1
)
exit /b 0
