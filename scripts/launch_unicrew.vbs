' UNICREW dev launcher (hidden window).
' Calls launch_unicrew.bat with hidden window so the user only sees the
' Tauri window, never a black cmd console.
Option Explicit
Dim shell, scriptDir, batPath
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\launch_unicrew.bat"
' Run params: 0 = hidden window, False = don't wait for exit
shell.Run """" & batPath & """", 0, False
