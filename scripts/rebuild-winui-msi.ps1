# PowerShell script to cleanly rebuild TeleDrive WinUI and package the MSI installer on Windows
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  TeleDrive v3.0.0 — Native WinUI & MSI Rebuild" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$RepoRoot = (Get-Item "$PSScriptRoot\..").FullName
$Desktop = [Environment]::GetFolderPath('Desktop')
$Downloads = Join-Path $env:USERPROFILE "Downloads"
$PublishDir = Join-Path $RepoRoot "winui-desktop\publish"
$ProjectFile = Join-Path $RepoRoot "winui-desktop\TeleDrive.WinUI\TeleDrive.WinUI.csproj"

# 1. Close running TeleDrive processes to unlock binary files
Write-Host "`n[1/4] Stopping active TeleDrive processes..." -ForegroundColor Yellow
Get-Process -Name "TeleDrive.WinUI", "TeleDriveR", "telegram-bot-api" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# 2. Compile WinUI project
Write-Host "`n[2/4] Compiling TeleDrive WinUI 3 (Release x64, Self-Contained)..." -ForegroundColor Yellow
$dotnet = "C:\Program Files\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }

& $dotnet publish "$ProjectFile" -c Release -p:Platform=x64 --self-contained true -o "$PublishDir"
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[ERROR] dotnet publish failed with exit code $LASTEXITCODE" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
}
Write-Host "✓ WinUI 3 build succeeded." -ForegroundColor Green

# 3. WiX MSI Packaging
Write-Host "`n[3/4] Packaging WiX MSI installer..." -ForegroundColor Yellow
Set-Location "$RepoRoot"

# Run packaging script via Node
& node "$RepoRoot\scripts\build-winui-msi.js"
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[ERROR] WiX MSI generation failed with exit code $LASTEXITCODE" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
}
Write-Host "✓ MSI installer built successfully." -ForegroundColor Green

# 4. Sync distribution targets
Write-Host "`n[4/4] Deploying installer and portable binaries..." -ForegroundColor Yellow

# Copy MSI to Desktop
$sourceMsi = Join-Path $RepoRoot "TeleDrive-Setup.msi"
if (-not (Test-Path $sourceMsi)) {
    $sourceMsi = Join-Path $Downloads "TeleDrive-Setup.msi"
}
if (Test-Path $sourceMsi) {
    Copy-Item -Path $sourceMsi -Destination "$Desktop\TeleDrive-Setup.msi" -Force
    Copy-Item -Path $sourceMsi -Destination "$Downloads\TeleDrive-Setup.msi" -Force
    Write-Host "✓ Desktop installer updated: $Desktop\TeleDrive-Setup.msi" -ForegroundColor Green
}

# Sync Desktop portable folder
$desktopApp = Join-Path $Desktop "TeleDrive-WinUI"
if (Test-Path $desktopApp) {
    Copy-Item -Path "$PublishDir\*" -Destination $desktopApp -Recurse -Force
    Write-Host "✓ Desktop portable updated: $desktopApp" -ForegroundColor Green
}

# Sync AppData installed folder
$appDataDir = "$env:LOCALAPPDATA\Programs\TeleDrive"
if (Test-Path $appDataDir) {
    Copy-Item -Path "$PublishDir\*" -Destination $appDataDir -Recurse -Force
    Write-Host "✓ Installed AppData folder updated: $appDataDir" -ForegroundColor Green
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  REBUILD COMPLETE! Ready to test on Desktop:" -ForegroundColor Green
Write-Host "  MSI: $Desktop\TeleDrive-Setup.msi" -ForegroundColor Green
Write-Host "==========================================================`n" -ForegroundColor Green
