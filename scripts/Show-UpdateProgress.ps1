[CmdletBinding()]
param(
    [string] $InstallRoot = (Join-Path $env:ProgramData 'TerronesPOS'),
    [string] $Version = '',
    [Parameter(Mandatory = $true)] [string] $RequestedAt
)

# Shown by the visor right before it closes for an update. The updater cannot run
# while visor-web is open, so this separate window reports its progress instead.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$statusPath = Join-Path $InstallRoot 'state\update-status.json'
$progressPath = Join-Path $InstallRoot 'state\update-progress.json'
$requestPath = Join-Path $InstallRoot 'updates\request.json'
$lockPath = Join-Path $InstallRoot 'updates\install.lock'
$requested = [DateTime]::Parse($RequestedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$started = Get-Date
$phases = @(
    @{ Id = 'prepare'; Label = 'Preparar la actualización' },
    @{ Id = 'backup'; Label = 'Respaldar la base de datos' },
    @{ Id = 'install'; Label = 'Instalar la versión nueva' },
    @{ Id = 'migrate'; Label = 'Actualizar la base de datos' },
    @{ Id = 'start'; Label = 'Iniciar Terrones POS' },
    @{ Id = 'verify'; Label = 'Comprobar que todo funcione' }
)
$script:finished = $false
$script:detail = ''
$script:closeAt = $null

function Read-State([string] $Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $value = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        $updatedAt = [DateTime]::Parse([string]$value.updatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        # Files left by an earlier attempt must not be reported as this one.
        if ($updatedAt -lt $requested.AddSeconds(-5)) { return $null }
        return $value
    } catch { return $null }
}

$form = New-Object Windows.Forms.Form
$form.Text = 'Actualizando Terrones POS'
$form.ClientSize = New-Object Drawing.Size(480, 400)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.TopMost = $true
$form.BackColor = [Drawing.Color]::FromArgb(30, 41, 59)
$form.ForeColor = [Drawing.Color]::FromArgb(226, 232, 240)
$form.Font = New-Object Drawing.Font('Segoe UI', 10)

$title = New-Object Windows.Forms.Label
$title.Location = New-Object Drawing.Point(24, 18)
$title.Size = New-Object Drawing.Size(432, 30)
$title.Font = New-Object Drawing.Font('Segoe UI', 14, [Drawing.FontStyle]::Bold)
$title.Text = if ($Version) { "Instalando la versión $Version" } else { 'Instalando la actualización' }
$form.Controls.Add($title)

$hint = New-Object Windows.Forms.Label
$hint.Location = New-Object Drawing.Point(24, 50)
$hint.Size = New-Object Drawing.Size(432, 40)
$hint.ForeColor = [Drawing.Color]::FromArgb(148, 163, 184)
$hint.Text = 'Tarda de 5 a 10 minutos. No apagues la computadora; Terrones POS se abrirá solo al terminar.'
$form.Controls.Add($hint)

$phaseLabels = @{}
$top = 98
foreach ($phase in $phases) {
    $label = New-Object Windows.Forms.Label
    $label.Location = New-Object Drawing.Point(32, $top)
    $label.Size = New-Object Drawing.Size(424, 24)
    $label.Text = '○  ' + $phase.Label
    $label.ForeColor = [Drawing.Color]::FromArgb(100, 116, 139)
    $form.Controls.Add($label)
    $phaseLabels[$phase.Id] = $label
    $top += 26
}

$message = New-Object Windows.Forms.Label
$message.Location = New-Object Drawing.Point(24, 262)
$message.Size = New-Object Drawing.Size(432, 44)
$message.Text = 'Esperando a que se cierre Terrones POS…'
$form.Controls.Add($message)

$bar = New-Object Windows.Forms.ProgressBar
$bar.Location = New-Object Drawing.Point(24, 310)
$bar.Size = New-Object Drawing.Size(432, 14)
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$form.Controls.Add($bar)

$elapsed = New-Object Windows.Forms.Label
$elapsed.Location = New-Object Drawing.Point(24, 330)
$elapsed.Size = New-Object Drawing.Size(200, 20)
$elapsed.ForeColor = [Drawing.Color]::FromArgb(148, 163, 184)
$form.Controls.Add($elapsed)

$copy = New-Object Windows.Forms.Button
$copy.Location = New-Object Drawing.Point(224, 356)
$copy.Size = New-Object Drawing.Size(120, 32)
$copy.Text = 'Copiar detalle'
$copy.Visible = $false
$copy.Add_Click({ if ($script:detail) { [Windows.Forms.Clipboard]::SetText($script:detail) } })
$form.Controls.Add($copy)

$close = New-Object Windows.Forms.Button
$close.Location = New-Object Drawing.Point(352, 356)
$close.Size = New-Object Drawing.Size(104, 32)
$close.Text = 'Ocultar'
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

function Set-Phase([string] $Current, [bool] $Failed) {
    $reached = $true
    foreach ($phase in $phases) {
        $label = $phaseLabels[$phase.Id]
        if ($phase.Id -eq $Current) {
            $reached = $false
            if ($Failed) {
                $label.Text = '✗  ' + $phase.Label
                $label.ForeColor = [Drawing.Color]::FromArgb(248, 113, 113)
            } else {
                $label.Text = '►  ' + $phase.Label
                $label.ForeColor = [Drawing.Color]::White
            }
        } elseif ($reached) {
            $label.Text = '✓  ' + $phase.Label
            $label.ForeColor = [Drawing.Color]::FromArgb(74, 222, 128)
        } else {
            $label.Text = '○  ' + $phase.Label
            $label.ForeColor = [Drawing.Color]::FromArgb(100, 116, 139)
        }
    }
}

function Complete-Success([string] $Text) {
    $script:finished = $true
    Set-Phase '' $false
    $bar.Style = 'Continuous'
    $bar.Value = 100
    $title.Text = 'Actualización completada'
    $message.ForeColor = [Drawing.Color]::FromArgb(74, 222, 128)
    $message.Text = "$Text Terrones POS se está abriendo."
    $close.Text = 'Cerrar'
    $script:closeAt = (Get-Date).AddSeconds(15)
}

function Complete-Failure([string] $Text, [string] $ErrorText, [string] $Log, [string] $Phase) {
    $script:finished = $true
    if ($Phase) { Set-Phase $Phase $true }
    $bar.Style = 'Continuous'
    $bar.Value = 0
    $title.Text = 'La actualización no se completó'
    $message.ForeColor = [Drawing.Color]::FromArgb(248, 113, 113)
    $message.Text = "$Text $ErrorText"
    $hint.Text = 'Terrones POS sigue funcionando con la versión anterior. Copia el detalle y envíalo a soporte.'
    $script:detail = "Versión: $Version`r`nMensaje: $Text`r`nError: $ErrorText`r`nRegistro: $Log`r`nHora: $((Get-Date).ToString('s'))"
    $copy.Visible = $true
    $close.Text = 'Cerrar'
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    $span = (Get-Date) - $started
    $elapsed.Text = 'Tiempo transcurrido: {0:mm\:ss}' -f $span
    if ($script:finished) {
        if ($script:closeAt -and (Get-Date) -ge $script:closeAt) { $form.Close() }
        return
    }
    $status = Read-State $statusPath
    $progress = Read-State $progressPath
    if ($status -and $status.state -eq 'completed') { Complete-Success ([string]$status.message); return }
    if ($status -and $status.state -eq 'error') {
        $phase = if ($progress) { [string]$progress.phase } else { '' }
        $log = if ($progress) { [string]$progress.log } else { '' }
        Complete-Failure ([string]$status.message) ([string]$status.error) $log $phase
        return
    }
    if ($progress -and $progress.phase -eq 'failed') {
        Complete-Failure ([string]$progress.message) ([string]$progress.error) ([string]$progress.log) ''
        return
    }
    if ($progress) {
        Set-Phase ([string]$progress.phase) $false
        if ($progress.message) { $message.Text = [string]$progress.message }
    } elseif ($status -and $status.message) {
        $message.Text = [string]$status.message
    }
    $waiting = -not $status -and -not $progress -and (Test-Path -LiteralPath $requestPath) -and -not (Test-Path -LiteralPath $lockPath)
    if ($waiting -and $span.TotalMinutes -ge 3) {
        $message.Text = 'El actualizador aún no arranca. Se reintenta cada minuto; deja la sesión de Windows abierta.'
    }
    if ($span.TotalHours -ge 2) {
        Complete-Failure 'El actualizador no respondió en dos horas.' 'Revisa el estado con F9 al abrir Terrones POS.' '' ''
    }
})
$timer.Start()
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
