param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8000)

try {
    $listener.Start()
    Write-Host 'PaperMind AI is running at http://127.0.0.1:8000/' -ForegroundColor Green
    Write-Host 'Keep this window open while using the site. Press Ctrl+C to stop.'
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8000/' }

    while ($listener.Server.IsBound) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') { }

            $requestPath = '/'
            if ($requestLine -match '^GET\s+(\S+)') { $requestPath = ($Matches[1] -split '\?')[0] }
            $relativePath = [System.Uri]::UnescapeDataString($requestPath.TrimStart('/'))
            if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
            $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relativePath))
            $isInRoot = $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)

            if (-not $isInRoot -or -not [System.IO.File]::Exists($filePath)) {
                $status = '404 Not Found'
                $body = [System.Text.Encoding]::UTF8.GetBytes('Not found')
                $contentType = 'text/plain; charset=utf-8'
            } else {
                $status = '200 OK'
                $body = [System.IO.File]::ReadAllBytes($filePath)
                $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                $contentType = switch ($extension) {
                    '.html' { 'text/html; charset=utf-8' }
                    '.js' { 'text/javascript; charset=utf-8' }
                    '.mjs' { 'text/javascript; charset=utf-8' }
                    '.css' { 'text/css; charset=utf-8' }
                    '.json' { 'application/json; charset=utf-8' }
                    default { 'application/octet-stream' }
                }
            }

            $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($requestLine -notmatch '^HEAD\s+') { $stream.Write($body, 0, $body.Length) }
            $stream.Flush()
        } catch {
            Write-Host "Request error: $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            if ($client) { $client.Dispose() }
        }
    }
} catch {
    Write-Host "PaperMind AI could not start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Close this window and try again. If port 8000 is already in use, close the other local server first.'
    Read-Host 'Press Enter to close'
} finally {
    $listener.Stop()
}
