const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isWin = process.platform === 'win32';

function toWinPath(p) {
  if (isWin) return path.resolve(p);
  return execSync(`wslpath -w '${p}'`, { encoding: 'utf8' }).trim();
}

function toWslPath(p) {
  if (isWin) return path.resolve(p);
  return execSync(`wslpath -u '${p}'`, { encoding: 'utf8' }).trim();
}

function getWinFolder(spec) {
  if (isWin) {
    if (spec.includes('LocalApplicationData')) return process.env.LOCALAPPDATA;
    if (spec.includes('Downloads')) return path.join(process.env.USERPROFILE, 'Downloads');
    return process.env.TEMP;
  }
  try {
    const encoded = Buffer.from(spec, 'utf16le').toString('base64');
    return execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    if (spec.includes('LocalApplicationData')) return 'C:\\Users\\Kailasnath T\\AppData\\Local';
    if (spec.includes('Downloads')) return 'C:\\Users\\Kailasnath T\\Downloads';
    return 'C:\\Users\\Kailasnath T\\AppData\\Local\\Temp';
  }
}

const localAppDataWin = getWinFolder("[Environment]::GetFolderPath('LocalApplicationData')");
const downloadsWin = getWinFolder("Join-Path $env:USERPROFILE 'Downloads'");
const userProfileWin = isWin ? process.env.USERPROFILE : 'C:\\Users\\Kailasnath T';
const localAppDataWsl = toWslPath(localAppDataWin);
const downloadsWsl = toWslPath(downloadsWin);

function findWixDir() {
  if (process.env.WIX_DIR) return process.env.WIX_DIR;
  const candidates = [
    path.join(localAppDataWin, 'Temp', 'wix'),
    'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin',
    'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin',
  ];
  for (const c of candidates) {
    try {
      const p = toWslPath(c);
      if (fs.existsSync(p)) return c;
    } catch {}
  }
  return '';
}

const wixBinWinPath = findWixDir();

// Locate application source (prefer self-contained publish output)
let appSrcWsl = path.resolve(__dirname, '../winui-desktop/TeleDrive.WinUI/publish');
if (!fs.existsSync(path.join(appSrcWsl, 'TeleDrive.WinUI.exe'))) {
  appSrcWsl = path.resolve(__dirname, '../winui-desktop/publish');
}
if (!fs.existsSync(path.join(appSrcWsl, 'TeleDrive.WinUI.exe'))) {
  appSrcWsl = path.resolve(__dirname, '../winui-desktop/TeleDrive.WinUI/bin/x64/Release/net8.0-windows10.0.26100.0/win-x64');
}
if (!fs.existsSync(path.join(appSrcWsl, 'TeleDrive.WinUI.exe'))) {
  appSrcWsl = path.resolve(__dirname, '../TeleDrive-WinUI-win-x64');
}
if (!fs.existsSync(path.join(appSrcWsl, 'TeleDrive.WinUI.exe'))) {
  const desktopApp = isWin
    ? path.join(process.env.USERPROFILE, 'Desktop', 'TeleDrive-WinUI')
    : '/mnt/c/Users/Kailasnath T/Desktop/TeleDrive-WinUI';
  if (fs.existsSync(path.join(desktopApp, 'TeleDrive.WinUI.exe'))) {
    appSrcWsl = desktopApp;
  }
}

if (!fs.existsSync(path.join(appSrcWsl, 'TeleDrive.WinUI.exe'))) {
  console.error(`Cannot find published TeleDrive.WinUI.exe. Looked in: ${appSrcWsl}`);
  process.exit(1);
}

const iconSrcWsl = path.join(appSrcWsl, 'Assets', 'AppIcon.ico');
const winTempWsl = fs.mkdtempSync(path.join(localAppDataWsl, 'Temp', 'teledrive-msi-build-'));
const winTempWinPath = toWinPath(winTempWsl);

console.log(`Building MSI for TeleDrive from: ${appSrcWsl}`);
console.log(`Working directory: ${winTempWsl} (${winTempWinPath})`);

// Stage files into local Windows Temp folder for fast, reliable WiX linking (bypasses UNC share limits)
const stageAppWsl = path.join(winTempWsl, 'app');
console.log(`Staging application files into: ${stageAppWsl}...`);
fs.cpSync(appSrcWsl, stageAppWsl, { recursive: true });

function sanitizeId(str) {
  return 'c_' + str.replace(/[^a-zA-Z0-9_]/g, '_').slice(-60);
}

let compCounter = 0;
const components = [];
const dirMap = new Map(); // relDir -> dirId

function walk(currentDir, relDir = '') {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const ent of entries) {
    const fullPath = path.join(currentDir, ent.name);
    const entRel = relDir ? `${relDir}\\${ent.name}` : ent.name;

    if (ent.isDirectory()) {
      if (!dirMap.has(entRel)) {
        const dId = sanitizeId(`d_${entRel}_${++compCounter}`);
        dirMap.set(entRel, { id: dId, name: ent.name, parentRel: relDir });
      }
      walk(fullPath, entRel);
    } else {
      const fId = sanitizeId(`f_${entRel}_${++compCounter}`);
      const cId = sanitizeId(`comp_${entRel}_${compCounter}`);
      const parentDirId = relDir ? dirMap.get(relDir).id : 'INSTALLFOLDER';
      const isMain = ent.name.toLowerCase() === 'teledrive.winui.exe';

      components.push({
        fileId: fId,
        compId: cId,
        srcPath: fullPath,
        fileName: ent.name,
        dirId: parentDirId,
        isMain,
      });
    }
  }
}

walk(stageAppWsl);
console.log(`Indexed ${components.length} files across ${dirMap.size} subdirectories.`);

// Copy icon to temp for WiX
const tempIconPath = path.join(winTempWsl, 'icon.ico');
if (fs.existsSync(iconSrcWsl)) {
  fs.copyFileSync(iconSrcWsl, tempIconPath);
}

// Build directory XML hierarchy
function buildDirectoryXml(parentRel = '') {
  let xml = '';
  for (const [rDir, info] of dirMap.entries()) {
    if (info.parentRel === parentRel) {
      xml += `<Directory Id="${info.id}" Name="${info.name}">\n`;
      xml += buildDirectoryXml(rDir);
      xml += `</Directory>\n`;
    }
  }
  return xml;
}

const dirTreeXml = buildDirectoryXml('');

// Build Components XML
let compXml = '';
for (const c of components) {
  const winSrc = toWinPath(c.srcPath);
  compXml += `
    <DirectoryRef Id="${c.dirId}">
      <Component Id="${c.compId}" Guid="*">
        <File Id="${c.fileId}" Source="${winSrc}" KeyPath="yes" />
      </Component>
    </DirectoryRef>`;
}

const pkgVersion = (() => {
  try {
    return require(path.resolve(__dirname, '../package.json')).version || '3.0.0';
  } catch {
    return '3.0.0';
  }
})();

const wxs = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Product Id="*" 
           Name="TeleDrive" 
           Language="1033" 
           Version="${pkgVersion}" 
           Manufacturer="TeleDrive" 
           UpgradeCode="7b2a5c9e-1d3f-4e6a-8b0c-9d2e4f6a8b0c">

    <Package InstallerVersion="301" 
             Compressed="yes" 
             InstallScope="perUser" 
             Comments="TeleDrive - Native Windows Cloud File Storage Client" />

    <MajorUpgrade DowngradeErrorMessage="A newer version of TeleDrive is already installed." AllowSameVersionUpgrades="yes" />
    <MediaTemplate EmbedCab="yes" />

    <Icon Id="TeleDriveIcon" SourceFile="icon.ico" />
    <Property Id="ARPPRODUCTICON" Value="TeleDriveIcon" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ProgramsFolder" Name="Programs">
          <Directory Id="INSTALLFOLDER" Name="TeleDrive">
            ${dirTreeXml}
          </Directory>
        </Directory>
      </Directory>

      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="TeleDrive" />
      </Directory>

      <Directory Id="DesktopFolder" Name="Desktop" />
      <Directory Id="SendToFolder" Name="SendTo" />
    </Directory>

    <DirectoryRef Id="ApplicationProgramsFolder">
      <Component Id="C_StartMenuShortcut" Guid="*">
        <Shortcut Id="S_StartMenu"
                  Name="TeleDrive"
                  Description="TeleDrive - Native Windows Cloud File Storage"
                  Target="[INSTALLFOLDER]TeleDrive.WinUI.exe"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="TeleDriveIcon" />
        <RemoveFolder Id="CleanUpStartMenu" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\TeleDrive" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="DesktopFolder">
      <Component Id="C_DesktopShortcut" Guid="*">
        <Shortcut Id="S_Desktop"
                  Name="TeleDrive"
                  Description="TeleDrive - Native Windows Cloud File Storage"
                  Target="[INSTALLFOLDER]TeleDrive.WinUI.exe"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="TeleDriveIcon" />
        <RegistryValue Root="HKCU" Key="Software\\TeleDrive" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="SendToFolder">
      <Component Id="C_SendToShortcut" Guid="*">
        <Shortcut Id="S_SendTo"
                  Name="TeleDrive"
                  Description="Upload to TeleDrive Cloud Storage"
                  Target="[INSTALLFOLDER]TeleDrive.WinUI.exe"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="TeleDriveIcon" />
        <RegistryValue Root="HKCU" Key="Software\\TeleDrive" Name="SendToShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="INSTALLFOLDER">
      <Component Id="C_ShellIntegration" Guid="*">
        <!-- File Context Menu: Right click any file -> Upload to TeleDrive -->
        <RegistryValue Root="HKCU" Key="Software\\Classes\\*\\shell\\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" KeyPath="yes" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\*\\shell\\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\*\\shell\\TeleDriveUpload\\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%1&quot;" />

        <!-- Folder Context Menu: Right click any folder -> Upload to TeleDrive -->
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\shell\\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\shell\\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\shell\\TeleDriveUpload\\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%1&quot;" />

        <!-- Directory Background Context Menu: Right click inside a folder -> Upload to TeleDrive -->
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\Background\\shell\\TeleDriveUpload" Type="string" Value="Upload to TeleDrive" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\Background\\shell\\TeleDriveUpload" Name="Icon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\Directory\\Background\\shell\\TeleDriveUpload\\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; --upload &quot;%V&quot;" />

        <!-- URI Scheme: teledrive:// -->
        <RegistryValue Root="HKCU" Key="Software\\Classes\\teledrive" Type="string" Value="URL:TeleDrive Protocol" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\teledrive" Name="URL Protocol" Type="string" Value="" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\teledrive\\DefaultIcon" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot;,0" />
        <RegistryValue Root="HKCU" Key="Software\\Classes\\teledrive\\shell\\open\\command" Type="string" Value="&quot;[INSTALLFOLDER]TeleDrive.WinUI.exe&quot; &quot;%1&quot;" />
      </Component>
    </DirectoryRef>

    ${compXml}

    <Feature Id="MainFeature" Title="TeleDrive Application" Level="1">
      <ComponentRef Id="C_StartMenuShortcut" />
      <ComponentRef Id="C_DesktopShortcut" />
      <ComponentRef Id="C_SendToShortcut" />
      <ComponentRef Id="C_ShellIntegration" />
      ${components.map((c) => `<ComponentRef Id="${c.compId}" />`).join('\n      ')}
    </Feature>

    <UIRef Id="WixUI_InstallDir" />
  </Product>
</Wix>`;

const wxsFile = path.join(winTempWsl, 'teledrive.wxs');
fs.writeFileSync(wxsFile, wxs, 'utf8');

const candleExePath = (wixBinWinPath ? `${wixBinWinPath}\\candle.exe` : 'candle.exe').replace(/\//g, '\\');
const lightExePath = (wixBinWinPath ? `${wixBinWinPath}\\light.exe` : 'light.exe').replace(/\//g, '\\');
const desktopPathWin = path.join(userProfileWin || 'C:\\Users\\Kailasnath T', 'Desktop').replace(/\//g, '\\');
const desktopPathWsl = isWin ? desktopPathWin : toWslPath(desktopPathWin);
const winTempWinNormalized = winTempWinPath.replace(/\//g, '\\');
const downloadsWinNormalized = downloadsWin.replace(/\//g, '\\');

// Create native Windows batch script that packages the MSI directly
const batchContent = `@echo off
setlocal enabledelayedexpansion
title TeleDrive MSI Builder

echo ========================================================
echo   TeleDrive v3.0.0 - Building MSI Installer
echo ========================================================
echo.

cd /d "${winTempWinNormalized}"

echo [1/2] Compiling WiX manifest (candle.exe)...
"${candleExePath}" -arch x64 -ext WixUIExtension teledrive.wxs
if errorlevel 1 (
    echo.
    echo [ERROR] candle.exe failed.
    pause
    exit /b 1
)

echo [2/2] Linking MSI installer (light.exe)...
"${lightExePath}" -spdb -sval -ext WixUIExtension -out "${winTempWinNormalized}\\TeleDrive-Setup.msi" teledrive.wixobj
if errorlevel 1 (
    echo.
    echo [ERROR] light.exe failed.
    pause
    exit /b 1
)

echo.
echo Copying MSI to Desktop and Downloads...
copy /Y "${winTempWinNormalized}\\TeleDrive-Setup.msi" "${desktopPathWin}\\TeleDrive-Setup.msi"
copy /Y "${winTempWinNormalized}\\TeleDrive-Setup.msi" "${downloadsWinNormalized}\\TeleDrive-Setup.msi"

echo.
echo ========================================================
echo   SUCCESS! TeleDrive-Setup.msi created on Desktop!
echo   Location: ${desktopPathWin}\\TeleDrive-Setup.msi
echo ========================================================
echo.
`;

const batchFileWsl = path.join(winTempWsl, 'build-msi.cmd');
fs.writeFileSync(batchFileWsl, batchContent, 'utf8');

// Also update the Desktop Rebuild launcher to directly run this self-contained script
const desktopCmd = path.join(desktopPathWsl, 'Rebuild-TeleDrive-MSI.cmd');
fs.writeFileSync(desktopCmd, batchContent, 'utf8');
console.log(`Generated build script at: ${desktopCmd}`);

console.log('Attempting WiX compilation via Windows interop...');
let buildSucceeded = false;
try {
  const runCmd = isWin
    ? `cmd.exe /c "${path.join(winTempWinPath, 'build-msi.cmd')}"`
    : `cmd.exe /c "${path.join(winTempWinPath, 'build-msi.cmd')}" < /dev/null`;
  execSync(runCmd, { stdio: 'inherit', timeout: 180000 });
  buildSucceeded = true;
} catch (err) {
  console.log(`\nNotice: Direct execution from WSL could not connect to Windows host (${err.message}).`);
  console.log(`The standalone WiX build batch has been placed directly on your Desktop:\n  -> ${desktopCmd}`);
}

const msiPath = path.join(winTempWsl, 'TeleDrive-Setup.msi');
if (fs.existsSync(msiPath)) {
  const stat = fs.statSync(msiPath);
  console.log(`\n🎉 Successfully built TeleDrive-Setup.msi (${(stat.size / (1024 * 1024)).toFixed(2)} MB)!`);

  // Refresh the current installer without removing unrelated downloads.
  const userDownloadsWsl = downloadsWsl;
  const targetMsiInDownloads = path.join(userDownloadsWsl, 'TeleDrive-Setup.msi');

  fs.copyFileSync(msiPath, targetMsiInDownloads);
  fs.copyFileSync(msiPath, path.join(desktopPathWsl, 'TeleDrive-Setup.msi'));
  fs.copyFileSync(msiPath, path.resolve(__dirname, '../TeleDrive-Setup.msi'));
  console.log(`Copied fresh installer to Desktop and Downloads!`);
}
