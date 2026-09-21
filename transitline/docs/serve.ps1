param([int]$Port = 8000, [string]$Root = $PSScriptRoot, [string]$Index = "korea-basemap.html")

Add-Type -AssemblyName System.Net.HttpListener -ErrorAction SilentlyContinue

$root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/ (Ctrl+C to stop)"

$mime = @{
  ".html" = "text/html"; ".json" = "application/json"; ".geojson" = "application/json";
  ".js" = "application/javascript"; ".mjs" = "application/javascript"; ".css" = "text/css";
  ".pmtiles" = "application/octet-stream";
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
      # HTTP Range support: .pmtiles archives are read by byte range, not whole-file.
      $res.AddHeader("Accept-Ranges", "bytes")
      $len = ([IO.FileInfo]$full).Length
      $start = 0L; $end = $len - 1
      $rng = $req.Headers["Range"]
      if ($rng -and $rng -match '^bytes=(\d*)-(\d*)$') {
        if ($Matches[1] -ne "") { $start = [long]$Matches[1] }
        if ($Matches[2] -ne "") { $end = [long]$Matches[2] }
        if ($Matches[1] -eq "" -and $Matches[2] -ne "") { $start = [math]::Max(0L, $len - [long]$Matches[2]); $end = $len - 1 }
        if ($end -ge $len) { $end = $len - 1 }
        $res.StatusCode = 206
        $res.AddHeader("Content-Range", "bytes $start-$end/$len")
      }
      $count = $end - $start + 1
      $res.ContentLength64 = $count
      $fs = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] 81920
        $left = $count
        while ($left -gt 0) {
          $n = $fs.Read($buf, 0, [int][math]::Min($buf.Length, $left))
          if ($n -le 0) { break }
          $res.OutputStream.Write($buf, 0, $n)
          $left -= $n
        }
      } finally { $fs.Close() }
    } else {
      $res.StatusCode = 404
    }
  } catch {
    # a browser aborting a request mid-response must not take the server down
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
