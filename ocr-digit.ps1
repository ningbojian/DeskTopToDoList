param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [Parameter(Mandatory=$true)][double]$Y,
  [Parameter(Mandatory=$true)][string]$OutFile
)
# Crop the big day-digit under a month label, shrink it beside normal text,
# and OCR it — Windows OCR reads large isolated digits poorly otherwise.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
$m=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1
function Await($op,[type]$t){$g=$m.MakeGenericMethod($t);$task=$g.Invoke($null,@($op));$task.Wait();return $task.Result}
function OcrFile([string]$p){
  $f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
  $s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $b=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if(-not $e){$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('en-US')}
  $r=Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
  return [string]$r.Text
}
$src = New-Object System.Drawing.Bitmap($ImagePath)
$x0=45; $y0=[int]($Y+45); $cw=85; $ch=80
if($y0+$ch -gt $src.Height){$ch=$src.Height-$y0}
if($cw -gt $src.Width-$x0){$cw=$src.Width-$x0}
$rect=New-Object System.Drawing.Rectangle($x0,$y0,$cw,$ch)
$crop=$src.Clone($rect,$src.PixelFormat)
$canvas=New-Object System.Drawing.Bitmap(400,150)
$g=[System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$hh=95; $ww=[int]($crop.Width*($hh/$crop.Height))
$g.DrawImage($crop,10,25,$ww,$hh)
$font=New-Object System.Drawing.Font('Arial',28,[System.Drawing.FontStyle]::Bold)
$g.DrawString('DATE',$font,[System.Drawing.Brushes]::Black,120,50)
$g.Dispose()
$tmp=[System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),"d-$([guid]::NewGuid().ToString('N')).png")
$canvas.Save($tmp,[System.Drawing.Imaging.ImageFormat]::Png)
$txt=''
try { $txt = OcrFile $tmp } catch {}
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
$mnum=[regex]::Match($txt,'\d{1,2}')
$digit = if($mnum.Success){$mnum.Value}else{''}
[System.IO.File]::WriteAllText($OutFile,$digit,(New-Object System.Text.UTF8Encoding($false)))
$src.Dispose();$crop.Dispose();$canvas.Dispose()
Write-Output 'OK'
