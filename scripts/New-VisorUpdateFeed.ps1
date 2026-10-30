[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $PrivateKeyFile,
    [Parameter(Mandatory = $true)] [string] $Installer,
    [string] $Output = (Join-Path $PSScriptRoot '..\dist\update-feed'),
    [string] $Notes = 'Actualizador de un clic para Terrones POS.'
)

$ErrorActionPreference = 'Stop'
try {
    $env:TERRONES_UPDATE_SIGNING_PRIVATE_XML = [IO.File]::ReadAllText((Resolve-Path $PrivateKeyFile))
    & node (Join-Path $PSScriptRoot 'Sign-TerronesUpdateFeed.js') (Resolve-Path $Installer) $Output $Notes
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo firmar el feed del visor.' }
    Get-ChildItem -LiteralPath $Output -File | Select-Object Name,Length,@{Name='SHA256';Expression={(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
} finally {
    Remove-Item Env:TERRONES_UPDATE_SIGNING_PRIVATE_XML -ErrorAction SilentlyContinue
}
