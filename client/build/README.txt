Voxara — Windows
================

"Windows protected your PC"
---------------------------
You will most likely see a blue SmartScreen box the first time you run Voxara.
This is expected. It is not a virus warning — it means the app is not signed
with a paid Microsoft-recognised code-signing certificate, so Windows has no
reputation record for it. Every unsigned app gets this.

To run it anyway:

    Click "More info"  ->  "Run anyway"

To avoid the prompt entirely, clear the "downloaded from the internet" mark on
the ZIP BEFORE you extract it. In PowerShell, in the folder you saved it to:

    Unblock-File .\Voxara-1.7.4-x64.zip
    Expand-Archive .\Voxara-1.7.4-x64.zip -DestinationPath .\Voxara

Order matters: that mark is copied to every file inside when you extract, and
removing it afterwards means unblocking each file. Do the ZIP first and the
extracted Voxara.exe starts with no warning at all.

Before trusting any build, check it is the one that was published. Compare the
output of:

    Get-FileHash .\Voxara-1.7.4-x64.zip -Algorithm SHA256

against the SHA-256 shown by the server that gave you the download.

Running it
----------
Double-click Voxara.exe. That is all — nothing needs installing.

Run "Install Voxara.cmd" once if you would like Start-menu and desktop
shortcuts. It does not copy or move anything; Voxara keeps running from this
folder. To uninstall, delete the shortcuts and this folder.

Connecting
----------
Nothing to configure. Voxara connects to its server automatically — just sign in
or create an account.

The connection is encrypted. The server uses a self-signed certificate, so the
first time you connect Voxara records that certificate and refuses any different
one afterwards. Ask whoever runs the server for its SHA-256 fingerprint and
check it matches on that first connection.

Updates
-------
Voxara checks the server it is connected to on launch and offers any newer
build. You can also check at any time from Settings -> About.

Your settings and session live in:
    %APPDATA%\Voxara\settings.json
