param(
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [Parameter(Mandatory = $true)][ValidateSet('attach','detach')][string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DesktopNative
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

$target = [IntPtr]$Hwnd

if ($Action -eq 'attach') {
    $progman = [DesktopNative]::FindWindow('Progman', 'Program Manager')
    if ($progman -eq [IntPtr]::Zero) { Write-Output 'ERROR: Progman not found'; exit 1 }

    # Ask explorer to spawn the WorkerW that hosts the desktop wallpaper.
    $result = [UIntPtr]::Zero
    [void][DesktopNative]::SendMessageTimeout($progman, 0x052C, [UIntPtr]::Zero, [IntPtr]::Zero, 0x0001, 1000, [ref]$result)

    $script:worker = [IntPtr]::Zero
    $cb = [DesktopNative+EnumWindowsProc] {
        param($hWnd, $lParam)
        $defView = [DesktopNative]::FindWindowEx($hWnd, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
        if ($defView -ne [IntPtr]::Zero) {
            $script:worker = [DesktopNative]::FindWindowEx([IntPtr]::Zero, $hWnd, 'WorkerW', $null)
        }
        return $true
    }
    [void][DesktopNative]::EnumWindows($cb, [IntPtr]::Zero)

    $parent = $script:worker
    if ($parent -eq [IntPtr]::Zero) { $parent = $progman }
    [void][DesktopNative]::SetParent($target, $parent)
    Write-Output ("ATTACHED parent=" + $parent.ToInt64())
}
else {
    [void][DesktopNative]::SetParent($target, [IntPtr]::Zero)
    $flags = 0x0001 -bor 0x0002 -bor 0x0040
    [void][DesktopNative]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, $flags)
    Write-Output 'DETACHED'
}
