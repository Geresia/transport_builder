param([int]$Port = 8000, [string]$Root = $PSScriptRoot, [string]$Index = "korea-basemap.html")

Add-Type -AssemblyName System.Net.HttpListener -ErrorAction SilentlyContinue

$root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/ (Ctrl+C to stop)"

$mime = @{
  ".html" = "text/html"; ".json" = "application/json"; ".geojson" = "application/json";
  ".js" = "application/javascript"; ".css" = "text/css"; ".pmtiles" = "application/octet-stream";
  ".png" = "image/png"; ".jpg" = "image/jpeg"; ".svg" = "image/svg+xml"
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq "") { $path = $Index }
    $full = Join-Path $root $path
    if (Test-Path $full -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($full)
      $ct = $mime[$ext]
      if (-not $ct) { $ct = "application/octet-stream" }
      $res.ContentType = $ct
      $bytes = [IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
