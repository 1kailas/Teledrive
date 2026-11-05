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

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    & node "$RepoRoot\scripts\build-winui-msi.js"
} else {
    Write-Host "Node not detected on Windows host path; running native WiX compilation..." -ForegroundColor Yellow
    
    # Locate WiX binaries
    $wixCandidates = @(
        (Join-Path $env:LOCALAPPDATA "Temp\wix"),
        "C:\Program Files (x86)\WiX Toolset v3.14\bin",
        "C:\Program Files (x86)\WiX Toolset v3.11\bin"
    )
    $wixDir = $wixCandidates | Where-Object { Test-Path (Join-Path $_ "candle.exe") } | Select-Object -First 1
    if (-not $wixDir) {
        Write-Host "`n[ERROR] Could not locate WiX Toolset (candle.exe)." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }

    # Generate WiX staging in temp
    $buildTemp = Join-Path $env:LOCALAPPDATA "Temp\teledrive-msi-build-$(Get-Random)"
    New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
    $stageApp = Join-Path $buildTemp "app"
    Copy-Item -Path $PublishDir -Destination $stageApp -Recurse -Force
    $iconPath = Join-Path $stageApp "Assets\AppIcon.ico"
    if (Test-Path $iconPath) { Copy-Item -Path $iconPath -Destination (Join-Path $buildTemp "icon.ico") -Force }

    # Walk files to build components
    $compCounter = 0
    $compXml = New-Object System.Text.StringBuilder
    $compRefs = New-Object System.Text.StringBuilder
    $dirTree = New-Object System.Collections.Generic.Dictionary[string, string] # relDir -> dirId
    $dirXml = New-Object System.Text.StringBuilder

    function SanitizeId($str) {
        return "c_" + ($str -replace "[^a-zA-Z0-9_]", "_")
    }

    $allFiles = Get-ChildItem -Path $stageApp -Recurse -File
    foreach ($file in $allFiles) {
        $relPath = $file.FullName.Substring($stageApp.Length).TrimStart('\')
        $relDir = [System.IO.Path]::GetDirectoryName($relPath)
        
        $dirId = "INSTALLFOLDER"
        if (-not [string]::IsNullOrEmpty($relDir)) {
            $parts = $relDir.Split('\')
            $currRel = ""
            $parentDirId = "INSTALLFOLDER"
            for ($i = 0; $i -lt $parts.Length; $i++) {
                $currRel = if ($i -eq 0) { $parts[$i] } else { "$currRel\$($parts[$i])" }
                if (-not $dirTree.ContainsKey($currRel)) {
                    $newDirId = "d_" + (SanitizeId $currRel).Substring(0, [Math]::Min(50, (SanitizeId $currRel).Length)) + "_$i"
                    $dirTree[$currRel] = $newDirId
                    [void]$dirXml.AppendLine("<DirectoryRef Id=""$parentDirId""><Directory Id=""$newDirId"" Name=""$($parts[$i])"" /></DirectoryRef>")
                }
                $parentDirId = $dirTree[$currRel]
            }
            $dirId = $parentDirId
        }

        $compCounter++
        $compId = "cmp_$compCounter"
        $fileId = "fil_$compCounter"
        $filePath = $file.FullName

        [void]$compXml.AppendLine("<DirectoryRef Id=""$dirId""><Component Id=""$compId"" Guid=""*""><File Id=""$fileId"" Source=""$filePath"" KeyPath=""yes"" /></Component></DirectoryRef>")
        [void]$compRefs.AppendLine("<ComponentRef Id=""$compId"" />")
    }

    $wxs = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Product Id="*" Name="TeleDrive" Language="1033" Version="3.0.0" Manufacturer="TeleDrive" UpgradeCode="7b2a5c9e-1d3f-4e6a-8b0c-9d2e4f6a8b0c">
    <Package InstallerVersion="301" Compressed="yes" InstallScope="perUser" Comments="TeleDrive - Native Windows Cloud File Storage Client" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of TeleDrive is already installed." AllowSameVersionUpgrades="yes" />
    <MediaTemplate EmbedCab="yes" />
    <Icon Id="TeleDriveIcon" SourceFile="icon.ico" />
    <Property Id="ARPPRODUCTICON" Value="TeleDriveIcon" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ProgramsFolder" Name="Programs">
          <Directory Id="INSTALLFOLDER" Name="TeleDrive" />
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder"><Directory Id="ApplicationProgramsFolder" Name="TeleDrive" /></Directory>
      <Directory Id="DesktopFolder" Name="Desktop" />
      <Directory Id="SendToFolder" Name="SendTo" />
    </Directory>
    $($dirXml.ToString())
    <DirectoryRef Id="ApplicationProgramsFolder">
      <Component Id="C_StartMenuShortcut" Guid="*">
        <Shortcut Id="S_StartMenu" Name="TeleDrive" Description="TeleDrive - Native Windows Cloud File Storage" Target="[INSTALLFOLDER]TeleDrive.WinUI.exe" WorkingDirectory="INSTALLFOLDER" Icon="TeleDriveIcon" />
        <RemoveFolder Id="CleanUpStartMenu" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\TeleDrive" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="DesktopFolder">
      <Component Id="C_DesktopShortcut" Guid="*">
        <Shortcut Id="S_Desktop" Name="TeleDrive" Description="TeleDrive - Native Windows Cloud File Storage" Target="[INSTALLFOLDER]TeleDrive.WinUI.exe" WorkingDirectory="INSTALLFOLDER" Icon="TeleDriveIcon" />
        <RegistryValue Root="HKCU" Key="Software\TeleDrive" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="SendToFolder">
      <Component Id="C_SendToShortcut" Guid="*">
        <Shortcut Id="S_SendTo" Name="TeleDrive" Description="Upload to TeleDrive Cloud Storage" Target="[INSTALLFOLDER]TeleDrive.WinUI.exe" WorkingDirectory="INSTALLFOLDER" Icon="TeleDriveIcon" />
        <RegistryValue Root="HKCU" Key="Software\TeleDrive" Name="SendToShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="INSTALLFOLDER">
      <Component Id="C_ShellIntegration" Guid="*">
        <RegistryValue Root="HKCU" Key="Software\Classes\*\shell\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" KeyPath="yes" />
        <RegistryValue Root="HKCU" Key="Software\Classes\*\shell\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\*\shell\TeleDriveUpload\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%1&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\shell\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\shell\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\shell\TeleDriveUpload\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%1&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\Background\shell\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\Background\shell\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\Directory\Background\shell\TeleDriveUpload\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%V&quot;" />
        <RegistryValue Root="HKCU" Key="Software\Classes\teledrive" Type="string" Value="URL:TeleDrive Protocol" />
        <RegistryValue Root="HKCU" Key="Software\Classes\teledrive" Name="URL Protocol" Type="string" Value="" />
        <RegistryValue Root="HKCU" Key="Software\Classes\teledrive\DefaultIcon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;,0" />
        <RegistryValue Root="HKCU" Key="Software\Classes\teledrive\shell\open\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; &quot;%1&quot;" />
      </Component>
    </DirectoryRef>
    $($compXml.ToString())
    <Feature Id="MainFeature" Title="TeleDrive Application" Level="1">
      <ComponentRef Id="C_StartMenuShortcut" />
      <ComponentRef Id="C_DesktopShortcut" />
      <ComponentRef Id="C_SendToShortcut" />
      <ComponentRef Id="C_ShellIntegration" />
      $($compRefs.ToString())
    </Feature>
    <UIRef Id="WixUI_InstallDir" />
  </Product>
</Wix>
"@

    $wxsPath = Join-Path $buildTemp "teledrive.wxs"
    [System.IO.File]::WriteAllText($wxsPath, $wxs, [System.Text.Encoding]::UTF8)

    Set-Location $buildTemp
    & "$wixDir\candle.exe" -arch x64 -ext WixUIExtension teledrive.wxs
    & "$wixDir\light.exe" -spdb -sval -ext WixUIExtension -out "$RepoRoot\TeleDrive-Setup.msi" teledrive.wixobj
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[ERROR] WiX MSI generation failed with exit code $LASTEXITCODE" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
}
Write-Host "✓ MSI installer built successfully." -ForegroundColor Green

# 4. Sync distribution targets
Write-Host "`n[4/4] Deploying installer and portable binaries..." -ForegroundColor Yellow

# Copy MSI to Desktop and Downloads
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
