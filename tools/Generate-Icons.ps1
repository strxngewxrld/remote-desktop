# Run on Windows: powershell -File tools/Generate-Icons.ps1
# All application marks use the same 24-unit monitor and bidirectional arrows.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$mediaDirectory = Join-Path $PSScriptRoot '../packages/vscode-rdp/media'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$monitor = '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4m-4 0h8"/>'
$arrows = '<path d="M7 9h10m-2-2 2 2-2 2m2 2H7m2-2-2 2 2 2"/>'
function Write-Mark([string]$name, [string]$color) {
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="' + $color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + $monitor + $arrows + '</svg>' + "`n"
    [System.IO.File]::WriteAllText((Join-Path $mediaDirectory $name), $svg, $utf8)
}
Write-Mark 'rdp-icon.svg' 'currentColor'
Write-Mark 'rdp-icon-light.svg' '#424242'
Write-Mark 'rdp-icon-dark.svg' '#e0e0e0'

$source = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#142437"/><g transform="translate(64 64) scale(16)" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g stroke="#59d6ec">' + $monitor + '</g><g stroke="#f2fbff">' + $arrows + '</g></g></svg>' + "`n"
[System.IO.File]::WriteAllText((Join-Path $mediaDirectory 'icon.svg'), $source, $utf8)

# Raster export of that same geometry; no fonts, stock art, or external packages.
$bitmap = [System.Drawing.Bitmap]::new(512, 512)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$background = [System.Drawing.Drawing2D.GraphicsPath]::new()
foreach ($corner in @(@(0, 0, 180), @(320, 0, 270), @(320, 320, 0), @(0, 320, 90))) {
    $background.AddArc($corner[0], $corner[1], 192, 192, $corner[2], 90)
}
$background.CloseFigure()
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#142437'))
$graphics.FillPath($brush, $background)
$graphics.TranslateTransform(64, 64)
$graphics.ScaleTransform(16, 16)
$cyan = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#59d6ec'), 1.6)
$white = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#f2fbff'), 1.6)
foreach ($pen in @($cyan, $white)) {
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
}
$display = [System.Drawing.Drawing2D.GraphicsPath]::new()
foreach ($corner in @(@(3, 4, 180), @(17, 4, 270), @(17, 13, 0), @(3, 13, 90))) {
    $display.AddArc($corner[0], $corner[1], 4, 4, $corner[2], 90)
}
$display.CloseFigure()
$graphics.DrawPath($cyan, $display)
$graphics.DrawLine($cyan, 12, 17, 12, 21)
$graphics.DrawLine($cyan, 8, 21, 16, 21)
foreach ($line in @(@(7, 9, 17, 9), @(15, 7, 17, 9), @(17, 9, 15, 11), @(17, 13, 7, 13), @(9, 11, 7, 13), @(7, 13, 9, 15))) {
    $graphics.DrawLine($white, $line[0], $line[1], $line[2], $line[3])
}
$bitmap.Save((Join-Path $mediaDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
foreach ($resource in @($display, $background, $brush, $cyan, $white, $graphics, $bitmap)) { $resource.Dispose() }
Write-Output 'Generated marketplace PNG, vector source, activity-bar icon, and light/dark tab icons.'
