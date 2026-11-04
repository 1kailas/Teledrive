const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let exeSrc = path.resolve(__dirname, '../target/x86_64-pc-windows-gnu/release/TeleDriveR.exe');
if (!fs.existsSync(exeSrc)) {
  exeSrc = path.resolve(__dirname, '../target/x86_64-pc-windows-gnu/release/teledrive-rust.exe');
}
const iconSrc = path.resolve(__dirname, '../resources/icon.ico');
const botApiSrc = path.resolve(__dirname, '../resources/bot-api');
const botApiFiles = ['telegram-bot-api.exe', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'z.dll'];

// Derive the Windows-side paths at runtime — no user profile is hardcoded.
// A powershell one-liner resolves a Windows path; wslpath converts it back to
// the WSL mount point for fs operations.
function winFolderPath(spec) {
  // -EncodedCommand avoids the outer shell expanding $vars inside the command.
  const encoded = Buffer.from(spec, 'utf16le').toString('base64');
  const win = execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8' }).trim();
  return { win, wsl: execSync(`wslpath -u '${win}'`, { encoding: 'utf8' }).trim() };
}
const localAppData = winFolderPath("[Environment]::GetFolderPath('LocalApplicationData')");
const desktop = winFolderPath("[Environment]::GetFolderPath('Desktop')");
const downloads = winFolderPath("Join-Path $env:USERPROFILE 'Downloads'");

const winTemp = fs.mkdtempSync(path.join(localAppData.wsl, 'Temp', 'teledrive-rust-msi-build-'));
const winTempWinPath = execSync(`wslpath -w '${winTemp}'`, { encoding: 'utf8' }).trim();
// WiX tools (candle.exe/light.exe); override with WIX_DIR for other machines.
const wixBinWinPath = process.env.WIX_DIR || `${localAppData.win}\\Temp\\wix`;

// Always remove the unique build dir, success or failure.
function cleanupBuildDir() {
  try { fs.rmSync(winTemp, { recursive: true, force: true }); } catch (e) {
    console.warn(`Warning: could not remove build dir ${winTemp}: ${e.message}`);
  }
}
process.on('exit', cleanupBuildDir);

console.log('1. Preparing Native Rust build directory...');
fs.mkdirSync(path.join(winTemp, 'app'), { recursive: true });
fs.mkdirSync(path.join(winTemp, 'app', 'bot-api'), { recursive: true });

console.log('2. Copying native Rust binary payload...');
if (!fs.existsSync(exeSrc)) {
  console.error(`Error: Native executable not found at ${exeSrc}`);
  process.exit(1);
}
fs.copyFileSync(exeSrc, path.join(winTemp, 'app', 'TeleDriveR.exe'));
fs.copyFileSync(iconSrc, path.join(winTemp, 'icon.ico'));
for (const name of botApiFiles) {
  const source = path.join(botApiSrc, name);
  if (!fs.existsSync(source)) throw new Error(`Bundled Bot API payload missing: ${name}`);
  fs.copyFileSync(source, path.join(winTemp, 'app', 'bot-api', name));
}

console.log('3. Generating WiX manifest for Native Rust application (TeleDriveR)...');
const wxs = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Product Id="*" 
           Name="TeleDriveR" 
           Language="1033" 
           Version="3.1.7" 
           Manufacturer="TeleDrive" 
           UpgradeCode="c8e5f2a1-8d4b-4a73-9e12-4f3a7b8c9d0e">

    <Package InstallerVersion="200" 
             Compressed="yes" 
             InstallScope="perUser" 
             Comments="TeleDriveR - Native Windows Cloud File Explorer" />

    <MajorUpgrade DowngradeErrorMessage="A newer version of TeleDriveR is already installed." AllowSameVersionUpgrades="yes" />
    <MediaTemplate EmbedCab="yes" />

    <Icon Id="TeleDriveIcon" SourceFile="icon.ico" />
    <Property Id="ARPPRODUCTICON" Value="TeleDriveIcon" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ProgramsFolder" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="TeleDriveR">
          <Directory Id="BOTAPIFOLDER" Name="bot-api" />
        </Directory>
        </Directory>
      </Directory>

      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="TeleDriveR" />
      </Directory>

      <Directory Id="DesktopFolder" Name="Desktop" />
    </Directory>

    <DirectoryRef Id="ApplicationProgramsFolder">
      <Component Id="ApplicationShortcutStartMenu" Guid="*">
        <Shortcut Id="ApplicationStartMenuShortcut"
                  Name="TeleDriveR"
                  Description="TeleDriveR - Native Cloud File Explorer"
                  Target="[INSTALLFOLDER]TeleDriveR.exe"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="TeleDriveIcon" />
        <RemoveFolder Id="CleanUpStartMenu" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\TeleDriveR" Name="installed" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="DesktopFolder">
      <Component Id="ApplicationShortcutDesktop" Guid="*">
        <Shortcut Id="ApplicationDesktopShortcut"
                  Name="TeleDriveR"
                  Description="TeleDriveR - Native Cloud File Explorer"
                  Target="[INSTALLFOLDER]TeleDriveR.exe"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="TeleDriveIcon" />
        <RegistryValue Root="HKCU" Key="Software\\TeleDriveR" Name="desktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <ComponentGroup Id="ProductComponents">
      <Component Id="C_MainExe" Guid="*" Directory="INSTALLFOLDER">
        <File Id="F_MainExe" Source="app\\TeleDriveR.exe" KeyPath="yes" />
      </Component>
      <Component Id="C_BotApi" Guid="*" Directory="BOTAPIFOLDER">
        <File Id="F_BotApi" Source="app\\bot-api\\telegram-bot-api.exe" KeyPath="yes" />
      </Component>
      <Component Id="C_Crypto" Guid="*" Directory="BOTAPIFOLDER">
        <File Id="F_Crypto" Source="app\\bot-api\\libcrypto-3-x64.dll" KeyPath="yes" />
      </Component>
      <Component Id="C_SSL" Guid="*" Directory="BOTAPIFOLDER">
        <File Id="F_SSL" Source="app\\bot-api\\libssl-3-x64.dll" KeyPath="yes" />
      </Component>
      <Component Id="C_Zlib" Guid="*" Directory="BOTAPIFOLDER">
        <File Id="F_Zlib" Source="app\\bot-api\\z.dll" KeyPath="yes" />
      </Component>
    </ComponentGroup>

    <Feature Id="ProductFeature" Title="TeleDriveR Native" Level="1">
      <ComponentGroupRef Id="ProductComponents" />
      <ComponentRef Id="ApplicationShortcutStartMenu" />
      <ComponentRef Id="ApplicationShortcutDesktop" />
    </Feature>

    <UIRef Id="WixUI_InstallDir" />
  </Product>
</Wix>`;

fs.writeFileSync(path.join(winTemp, 'teledrive.wxs'), wxs, 'utf-8');

console.log('4. Running WiX Compiler (candle.exe)...');
const candleCmd = `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; & '${wixBinWinPath}\\candle.exe' -arch x64 -ext WixUIExtension teledrive.wxs" < /dev/null`;
execSync(candleCmd, { stdio: 'inherit' });

console.log('5. Running WiX Linker (light.exe)...');
const lightCmd = `powershell.exe -NoProfile -Command "Set-Location '${winTempWinPath}'; & '${wixBinWinPath}\\light.exe' -spdb -sval -ext WixUIExtension -out TeleDriveR-Setup.msi teledrive.wixobj" < /dev/null`;
execSync(lightCmd, { stdio: 'inherit' });

const msiPath = path.join(winTemp, 'TeleDriveR-Setup.msi');
if (fs.existsSync(msiPath)) {
  const stat = fs.statSync(msiPath);
  console.log(`\n🎉 SUCCESS! Generated Native MSI Installer: ${msiPath} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);

  const releaseDir = path.resolve(__dirname, '../release');
  fs.mkdirSync(releaseDir, { recursive: true });

  // Delivery destinations: release dir, Desktop, Downloads, workspace root.
  // TELEDRIVE_MSI_COPY_DIRS (os.pathsep-separated) overrides Desktop/Downloads.
  const userDirs = process.env.TELEDRIVE_MSI_COPY_DIRS
    ? process.env.TELEDRIVE_MSI_COPY_DIRS.split(path.delimiter).map(d => ({ label: d, wsl: d }))
    : [{ label: 'Desktop', wsl: desktop.wsl }, { label: 'Downloads', wsl: downloads.wsl }];

  const destRelease = path.join(releaseDir, 'TeleDriveR-Setup.msi');
  const destRoot = path.resolve(__dirname, '../../TeleDriveR-Setup.msi');
  const delivered = [];

  fs.copyFileSync(msiPath, destRelease);
  delivered.push(['Rust Desktop Release', destRelease]);
  fs.copyFileSync(msiPath, destRoot);
  delivered.push(['Workspace Root', destRoot]);

  for (const d of userDirs) {
    const dest = path.join(d.wsl, 'TeleDriveR-Setup.msi');
    if (!fs.existsSync(d.wsl)) {
      console.warn(`Warning: ${d.label} (${d.wsl}) not found — skipping copy.`);
      continue;
    }
    fs.copyFileSync(msiPath, dest);
    delivered.push([`Windows ${d.label}`, dest]);
    // Also copy to TeleDrive-Setup.msi so existing references always have the newest package
    try { fs.copyFileSync(msiPath, path.join(d.wsl, 'TeleDrive-Setup.msi')); } catch {}
  }
  try { fs.copyFileSync(msiPath, path.resolve(__dirname, '../../TeleDrive-Setup.msi')); } catch {}

  console.log(`Delivered to:`);
  for (const [label, p] of delivered) console.log(` - ${label}: ${p}`);
} else {
  console.error('Failed: TeleDriveR-Setup.msi was not produced.');
  process.exit(1);
}
