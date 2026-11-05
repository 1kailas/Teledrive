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
  const encoded = Buffer.from(spec, 'utf16le').toString('base64');
  const win = execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8' }).trim();
  return win;
}

const localAppDataWin = getWinFolder("[Environment]::GetFolderPath('LocalApplicationData')");
const downloadsWin = getWinFolder("Join-Path $env:USERPROFILE 'Downloads'");
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
let appSrcWsl = path.resolve(__dirname, '../winui-desktop/publish');
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

const candleExe = wixBinWinPath ? `& '${wixBinWinPath}\\candle.exe'` : 'candle.exe';
const lightExe = wixBinWinPath ? `& '${wixBinWinPath}\\light.exe'` : 'light.exe';

console.log('Compiling WiX manifest with candle.exe...');
const candleCmd = isWin
  ? `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; ${candleExe} -arch x64 -ext WixUIExtension teledrive.wxs"`
  : `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; ${candleExe} -arch x64 -ext WixUIExtension teledrive.wxs" < /dev/null`;
execSync(candleCmd, { stdio: 'inherit' });

console.log('Linking MSI package with light.exe...');
const lightCmd = isWin
  ? `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; ${lightExe} -spdb -sval -ext WixUIExtension -out TeleDrive-Setup.msi teledrive.wixobj"`
  : `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; ${lightExe} -spdb -sval -ext WixUIExtension -out TeleDrive-Setup.msi teledrive.wixobj" < /dev/null`;
execSync(lightCmd, { stdio: 'inherit' });

const msiPath = path.join(winTempWsl, 'TeleDrive-Setup.msi');
if (!fs.existsSync(msiPath)) {
  console.error('Failed to produce TeleDrive-Setup.msi');
  process.exit(1);
}

const stat = fs.statSync(msiPath);
console.log(`\n🎉 Successfully built TeleDrive-Setup.msi (${(stat.size / (1024 * 1024)).toFixed(2)} MB)!`);

// Copy to user's Downloads directory and clean old files
const userDownloadsWsl = downloadsWsl;
const targetMsiInDownloads = path.join(userDownloadsWsl, 'TeleDrive-Setup.msi');

// Clean duplicate stale files in Downloads
try { fs.rmSync(path.join(userDownloadsWsl, 'TeleDrive-Setup (1).msi'), { force: true }); } catch {}
try { fs.rmSync(path.join(userDownloadsWsl, 'TeleDriveR-Setup.msi'), { force: true }); } catch {}
try { fs.rmSync(path.join(userDownloadsWsl, 'TeleDrive (WinUI 3).lnk'), { force: true }); } catch {}

fs.copyFileSync(msiPath, targetMsiInDownloads);
console.log(`Copied fresh installer to: ${targetMsiInDownloads}`);

// Also copy to workspace root
fs.copyFileSync(msiPath, path.resolve(__dirname, '../TeleDrive-Setup.msi'));
console.log(`Copied installer to workspace root: TeleDrive-Setup.msi`);
