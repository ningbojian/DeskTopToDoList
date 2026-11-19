param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]

$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
if ($null -eq $asTaskMethod) { throw 'Cannot locate WinRT AsTask<T> helper' }
function Await($op, [type]$resultType) {
    $generic = $asTaskMethod.MakeGenericMethod($resultType)
    $task = $generic.Invoke($null, @($op)); $task.Wait(); return $task.Result
}
function OcrBitmap($bitmap) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('zh-CN') }
    if ($null -eq $engine) { throw 'No OCR language pack available' }
    return Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
}
function OcrFile([string]$p) {
    $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $b = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    return OcrBitmap $b
}

# ---- main full-page OCR ----
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = OcrBitmap $bitmap

$lines = @()
foreach ($ln in $result.Lines) {
    # OcrLine has no BoundingRect; derive the line box from its words.
    $lx = 99999; $ly = 99999; $rx = 0; $by = 0
    foreach ($w in $ln.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $lx) { $lx = $r.X }
        if ($r.Y -lt $ly) { $ly = $r.Y }
        if (($r.X + $r.Width) -gt $rx) { $rx = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $by) { $by = $r.Y + $r.Height }
    }
    if ($lx -eq 99999) { $lx = 0; $ly = 0; $rx = 0; $by = 0 }
    $lines += [ordered]@{ text = [string]$ln.Text; x = [math]::Round($lx,1); y = [math]::Round($ly,1); w = [math]::Round(($rx-$lx),1); h = [math]::Round(($by-$ly),1) }
}
$words = @()
foreach ($ln in $result.Lines) {
    foreach ($w in $ln.Words) {
        $r = $w.BoundingRect
        $words += [ordered]@{ text = [string]$w.Text; x = [math]::Round($r.X,1); y = [math]::Round($r.Y,1); w = [math]::Round($r.Width,1); h = [math]::Round($r.Height,1) }
    }
}

# ---- detect date column: small month labels on the LEFT edge ----
# Windows OCR reads the big day digits poorly. Spawn ocr-digit.ps1 per label:
# it crops the big digit, shrinks it beside normal text, and re-OCRs reliably.
$dates = @()
try {
    $monthLabels = $words | Where-Object { [double]$_.x -lt 130 -and ([string]$_.text) -match '^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$' } | Sort-Object { [double]$_.y }
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $digitScript = Join-Path $scriptDir 'ocr-digit.ps1'
    foreach ($lab in $monthLabels) {
        $dayFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "dy-$([guid]::NewGuid().ToString('N')).txt")
        try {
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $digitScript -ImagePath $ImagePath -Y ([double]$lab.y) -OutFile $dayFile 2>&1 | Out-Null
            $day = 0
            if (Test-Path $dayFile) {
                $raw = [System.IO.File]::ReadAllText($dayFile, [System.Text.Encoding]::UTF8).Trim()
                $dn = 0
                if ([int]::TryParse($raw, [ref]$dn)) { $day = $dn }
                Remove-Item $dayFile -Force -ErrorAction SilentlyContinue
            }
            if ($day -ge 1 -and $day -le 31) {
                $dates += [ordered]@{ day = $day; month = [string]$lab.text; y = [math]::Round([double]$lab.y, 1) }
            }
        } catch { Remove-Item $dayFile -Force -ErrorAction SilentlyContinue }
    }
} catch { Write-Output ("date-detect warn: " + $_.Exception.Message) }

$payload = [ordered]@{
    text  = [string]$result.Text
    lines = $lines
    words = $words
    dates = $dates
}
$json = $payload | ConvertTo-Json -Compress -Depth 6
if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output 'OK'
} else {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    Write-Output $json
}
