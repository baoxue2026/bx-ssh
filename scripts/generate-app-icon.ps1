param(
    [string]$OutputPath = "apps/desktop/src-tauri/app-icon-source.png"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$destination = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $OutputPath))
$destinationDirectory = Split-Path -Parent $destination
New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

$size = 1024
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$backgroundPath.AddArc(72, 72, 184, 184, 180, 90)
$backgroundPath.AddArc(768, 72, 184, 184, 270, 90)
$backgroundPath.AddArc(768, 768, 184, 184, 0, 90)
$backgroundPath.AddArc(72, 768, 184, 184, 90, 90)
$backgroundPath.CloseFigure()

$backgroundBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#20252B"))
$graphics.FillPath($backgroundBrush, $backgroundPath)

$terminalPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#F8FAFC"), 42)
$terminalPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$terminalPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawRectangle($terminalPen, 218, 248, 588, 528)

$promptPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#3B82F6"), 54)
$promptPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$promptPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($promptPen, 342, 426, 446, 512)
$graphics.DrawLine($promptPen, 446, 512, 342, 598)

$cursorPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#22C55E"), 54)
$cursorPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$cursorPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($cursorPen, 510, 598, 652, 598)

$bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)

$cursorPen.Dispose()
$promptPen.Dispose()
$terminalPen.Dispose()
$backgroundBrush.Dispose()
$backgroundPath.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $destination
