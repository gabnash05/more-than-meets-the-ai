$ErrorActionPreference = 'Stop'
if (-not $env:UV_CACHE_DIR) {
    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.local/cache/uv'
}
$env:TEMP = if ($env:REFEREE_DATA_TMP) { $env:REFEREE_DATA_TMP } else {
    Join-Path $PSScriptRoot '.local/tmp'
}
$env:TMP = $env:TEMP
$env:UV_PYTHON_DOWNLOADS = 'never'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

Push-Location -LiteralPath $PSScriptRoot
try {
    uv run --frozen --no-dev referee-data @args
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $exitCode
