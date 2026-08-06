$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pythonRoot = Join-Path $projectRoot 'python-print'
$venv = Join-Path $projectRoot '.build-venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    py -3 -m venv $venv
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $pythonRoot 'requirements-build.txt')
Push-Location $pythonRoot
try {
    & $python -m PyInstaller --clean --noconfirm terrones-print-service.spec
} finally {
    Pop-Location
}

$target = Join-Path $projectRoot 'dist\print-service'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pythonRoot 'dist\terrones-print-service.exe') -Destination $target -Force
Write-Host "Servicio de impresión creado en $target"
