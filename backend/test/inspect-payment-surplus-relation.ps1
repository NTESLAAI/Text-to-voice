[CmdletBinding()]
param([switch]$AclDiagnostic)
$ErrorActionPreference = 'Stop'
# Reuse only the hidden-input helper; dot-sourcing never starts its harness.
. (Join-Path $PSScriptRoot 'run-payment-surplus-secure.ps1')

function New-RelationInspectionProcess {
    param([switch]$ValidateReport, [switch]$AclDiagnostic)
    if($ValidateReport -and $AclDiagnostic){throw 'INVALID_INSPECTION_MODE'}
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $info.Arguments = '"' + (Join-Path $PSScriptRoot 'inspect-payment-surplus-relation.cjs') + '"'
    if ($ValidateReport) { $info.Arguments += ' --validate-report' }
    if ($AclDiagnostic) { $info.Arguments += ' --acl-diagnostic' }
    $info.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = [bool]$ValidateReport
    $info.EnvironmentVariables.Clear()
    foreach ($key in @('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -ne $value) { $info.EnvironmentVariables[$key] = $value }
    }
    return $info
}

function New-RelationDiagnosticJson {
    param([string]$Code, [string]$Phase)
    $allowed=@{
        CREDENTIAL_INPUT_FAILED='CREDENTIAL_INPUT';PROCESS_START_FAILED='PROCESS_START';
        WRAPPER_TIMEOUT='PROCESS_WAIT';OUTPUT_READ_FAILED='OUTPUT_READ';
        REPORT_VALIDATION_FAILED='OUTPUT_VALIDATION';VALIDATOR_START_FAILED='OUTPUT_VALIDATION';
        VALIDATOR_TIMEOUT='OUTPUT_VALIDATION'
    }
    if([string]::IsNullOrEmpty($Code) -or -not $allowed.ContainsKey($Code) -or $allowed[$Code] -cne $Phase){
        $Code='REPORT_VALIDATION_FAILED';$Phase='OUTPUT_VALIDATION'
    }
    return ([ordered]@{status='UNKNOWN';readiness='NOT_READY';code=$Code;phase=$Phase;identityStatus='UNVERIFIED'}|ConvertTo-Json -Compress)
}

function ConvertTo-RelationSafeOutput {
    param([string]$Json, [int]$InspectionExitCode)
    $info = $null; $validator = $null; $started = $false
    $failureCode='REPORT_VALIDATION_FAILED'
    try {
        if ($Json.Length -gt 1048576) { throw 'INVALID_REPORT' }
        # A separate offline process validates the entire nested schema, counts and
        # permission consistency. It receives no URL/credentials and cannot load pg.
        $failureCode='VALIDATOR_START_FAILED'
        $info = New-RelationInspectionProcess -ValidateReport
        $validator = New-Object System.Diagnostics.Process
        $validator.StartInfo = $info
        if (-not $validator.Start()) { throw 'INVALID_REPORT' }
        $started = $true
        $failureCode='REPORT_VALIDATION_FAILED'
        $stdout = $validator.StandardOutput.ReadToEndAsync()
        $stderr = $validator.StandardError.ReadToEndAsync()
        $write = $validator.StandardInput.WriteAsync($Json)
        if (-not $write.Wait(3000)) { $failureCode='VALIDATOR_TIMEOUT';throw 'INVALID_REPORT' }
        $validator.StandardInput.Close()
        if (-not $validator.WaitForExit(5000)) { $failureCode='VALIDATOR_TIMEOUT';throw 'INVALID_REPORT' }
        $filtered = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        $parsed = $filtered | ConvertFrom-Json -ErrorAction Stop
        if ($parsed.status -ceq 'VERIFIED' -and ($InspectionExitCode -ne 0 -or $validator.ExitCode -ne 0)) { throw 'INVALID_REPORT' }
        # Only the local fixed validator's output crosses this boundary, never child JSON.
        return $filtered
    }
    catch { return (New-RelationDiagnosticJson -Code $failureCode -Phase 'OUTPUT_VALIDATION') }
    finally {
        if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
        if ($null -ne $validator) {
            if ($started -and -not $validator.HasExited) { $validator.Kill(); [void]$validator.WaitForExit(3000) }
            $validator.Dispose()
        }
    }
}

$raw = $null; $info = $null; $child = $null; $reported = $false; $started = $false
$failureCode='CREDENTIAL_INPUT_FAILED';$failurePhase='CREDENTIAL_INPUT'
try {
    $raw = Read-SurplusSecretUrl 'ttv_surplus_lifecycle'
    $failureCode='PROCESS_START_FAILED';$failurePhase='PROCESS_START'
    $info = New-RelationInspectionProcess -AclDiagnostic:$AclDiagnostic
    $info.EnvironmentVariables['SURPLUS_RELATION_URL'] = $raw
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    if (-not $child.Start()) { throw 'INSPECTION_FAILED' }
    $started = $true
    $failureCode='OUTPUT_READ_FAILED';$failurePhase='OUTPUT_READ'
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $failureCode='WRAPPER_TIMEOUT';$failurePhase='PROCESS_WAIT'
    # 28 sequential statements * 5s + connect 5s + close 3s = 148s;
    # finite outer budget leaves 12s for local scheduling/validation.
    if (-not $child.WaitForExit(160000)) {
        # Only this tool's child process; never a PostgreSQL backend.
        $child.Kill(); [void]$child.WaitForExit(3000)
        throw 'INSPECTION_FAILED'
    }
    $failureCode='OUTPUT_READ_FAILED';$failurePhase='OUTPUT_READ'
    $info.EnvironmentVariables.Clear(); $raw = $null
    $json = ConvertTo-RelationSafeOutput -Json $stdout.GetAwaiter().GetResult() -InspectionExitCode $child.ExitCode
    [void]$stderr.GetAwaiter().GetResult()
    Write-Output $json
    $reported = $true
    if (($json | ConvertFrom-Json).status -cne 'VERIFIED') { throw 'INSPECTION_FAILED' }
}
catch {
    if (-not $reported) { Write-Output (New-RelationDiagnosticJson -Code $failureCode -Phase $failurePhase) }
    throw 'READONLY_RELATION_INSPECTION_UNKNOWN_OR_NOT_READY'
}
finally {
    if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
    $raw = $null; $json = $null; $stdout = $null; $stderr = $null
    if ($null -ne $child) {
        if ($started -and -not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(3000) }
        $child.Dispose()
    }
}
