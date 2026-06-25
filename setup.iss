[Setup]
AppName=Donation Action Hub
AppVersion=1.0
DefaultDirName={autopf}\DonationActionHub
DefaultGroupName=Donation Action Hub
OutputDir=Output
OutputBaseFilename=DonationActionHub_Setup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
SetupIconFile=compiler:SetupClassicIcon.ico

[Files]
; Копируем все нужные файлы проекта
Source: "*"; DestDir: "{app}"; Excludes: "node_modules\*,Output\*,*.git\*,config.json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "config.example.json"; DestDir: "{app}"; DestName: "config.json"; Flags: ignoreversion

[Icons]
Name: "{group}\Donation Action Hub"; Filename: "{app}\run.bat"
Name: "{autodesktop}\Donation Action Hub"; Filename: "{app}\run.bat"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"

[Run]
; Выполняем npm install после установки (требуется установленный Node.js в системе)
Filename: "cmd.exe"; Parameters: "/c npm install"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated
; Предлагаем запустить программу после завершения установки
Filename: "{app}\run.bat"; Description: "Запустить Donation Action Hub"; Flags: postinstall shellexec
