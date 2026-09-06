; packaging/installer/ultrarag.iss — Inno Setup 脚本（产物为 FirmDeck）
; 由 build_windows.ps1 调用：ISCC.exe packaging\installer\ultrarag.iss
; VERSION 通过环境变量传入（GetEnv）

[Setup]
AppId=FirmDeck
AppName=FirmDeck
AppVersion={#GetEnv('VERSION')}
AppVerName=FirmDeck {#GetEnv('VERSION')}
AppPublisher=FirmDeck
DefaultDirName={autopf}\FirmDeck
DefaultGroupName=FirmDeck
OutputDir=..\out
OutputBaseFilename=FirmDeck-setup
SetupIconFile=..\assets\firmdeck.ico
UninstallDisplayIcon={app}\firmdeck.exe
UninstallDisplayName=FirmDeck
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64os
PrivilegesRequired=lowest
WizardStyle=modern
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=no
DisableReadyPage=no
VersionInfoVersion={#GetEnv('WINDOWS_VERSION_INFO_VERSION')}
VersionInfoProductName=FirmDeck
VersionInfoProductVersion={#GetEnv('WINDOWS_VERSION_INFO_VERSION')}
VersionInfoCompany=FirmDeck
VersionInfoDescription=FirmDeck Installer
#if GetEnv('WINDOWS_SIGN_ENABLED') == '1'
SignTool=firmdeck
SignedUninstaller=yes
#endif

[Files]
; PyInstaller onedir 产物整体安装
Source: "..\out\firmdeck\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Dirs]
; The dedicated SRT account must be able to launch bundled runtimes.
Name: "{app}"; Permissions: users-readexec

[Registry]
Root: HKCU; Subkey: "Software\Classes\firmdeck"; ValueType: string; ValueData: "URL:FirmDeck Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\firmdeck"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\firmdeck\DefaultIcon"; ValueType: string; ValueData: "{app}\firmdeck.exe,0"
Root: HKCU; Subkey: "Software\Classes\firmdeck\shell\open\command"; ValueType: string; ValueData: """{app}\firmdeck.exe"" ""%1"""

[Icons]
Name: "{group}\FirmDeck"; Filename: "{app}\firmdeck.exe"; AppUserModelID: "ai.firmdeck.desktop"
Name: "{autodesktop}\FirmDeck"; Filename: "{app}\firmdeck.exe"; AppUserModelID: "ai.firmdeck.desktop"

[Run]
Filename: "{app}\firmdeck.exe"; Description: "启动 FirmDeck"; Flags: postinstall nowait skipifsilent
