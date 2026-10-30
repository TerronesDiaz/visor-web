$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pythonRoot = Join-Path $projectRoot 'python-print'
$venv = Join-Path $projectRoot '.build-venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    # actions/setup-python exports pythonLocation; `py -3` would pick the newest Python on the
    # runner, for which the pinned build requirements may not exist.
    $basePython = if ($env:pythonLocation) { Join-Path $env:pythonLocation 'python.exe' } else { $null }
    if ($basePython -and (Test-Path -LiteralPath $basePython)) { & $basePython -m venv $venv }
    else { py -3 -m venv $venv }
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el entorno de Python para el servicio de impresión.' }
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $pythonRoot 'requirements-build.txt')
if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar las dependencias del servicio de impresión con $(& $python --version)." }
Push-Location $pythonRoot
try {
    & $python -m PyInstaller --clean --noconfirm terrones-print-service.spec
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller no pudo crear el servicio de impresión.' }
} finally {
    Pop-Location
}

$target = Join-Path $projectRoot 'dist\print-service'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pythonRoot 'dist\terrones-print-service.exe') -Destination $target -Force
Write-Host "Servicio de impresión creado en $target"
