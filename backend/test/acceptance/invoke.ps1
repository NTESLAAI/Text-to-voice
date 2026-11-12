param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][ValidateSet('migrate-cold','upgrade-base','upgrade-final','test','backup-restore')][string]$Action
)
function ConvertTo-AcceptanceReport($report, [string]$Action, [int]$ExitCode) {
    if ($null -eq $report -or $report -is [array]) { throw 'REFUSED' }
    foreach ($key in @('status','readiness','code')) { if ($report.$key -isnot [string]) { throw 'REFUSED' } }
    if ($null -ne $report.action -and $report.action -isnot [string]) { throw 'REFUSED' }
    $keys = @($report.PSObject.Properties.Name)
    if ($keys.Count -notin @(4,5) -or @($keys | Where-Object { $_ -notin @('status','readiness','action','code','tests') }).Count -ne 0) { throw 'REFUSED' }
    $codes = @('ACCEPTANCE_STEP_PASS','ACCEPTANCE_TEST_FAILED','INHERITED_CONFIGURATION_REFUSED','APPROVAL_REQUIRED','IDENTITY_UNVERIFIED','URL_VALIDATION_FAILED','CHILD_TIMEOUT_OUTCOME_UNKNOWN','CHILD_START_FAILED','CHILD_FAILED','MIGRATION_HISTORY_UNVERIFIED','UPGRADE_DATA_CHANGED','RESTORE_DATA_MISMATCH','ACCEPTANCE_STEP_FAILED')
    $codes += @('JEST_MULTIPLE_CONFIGURATIONS','JEST_CLI_TYPE_ERROR','JEST_RESULT_SUMMARY_TYPE_ERROR','JEST_ZERO_TESTS_UNCLASSIFIED','JEST_DOTENV_IMPORT_REFUSED','JEST_FD_READ_FAILED','JEST_MODULE_NOT_FOUND','JEST_ESM_REQUIRE_FAILED','JEST_TRANSFORM_FAILED','JEST_UNCLASSIFIED_BOOTSTRAP_FAILURE','ACCEPTANCE_DATABASE_NOT_EMPTY')
    if ($report.status -cnotin @('VERIFIED','UNKNOWN') -or $report.readiness -cne 'NOT_READY' -or $report.code -cnotin $codes -or ($report.action -cne $Action -and -not ($null -eq $report.action -and $report.status -ceq 'UNKNOWN'))) { throw 'REFUSED' }
    $safe = [ordered]@{ status = $report.status; readiness = 'NOT_READY'; action = $Action; code = $report.code; exitCode = $ExitCode }
    if ($ExitCode -ne 0 -and $safe.status -ceq 'VERIFIED') { $safe.status = 'UNKNOWN'; $safe.code = 'CHILD_FAILED' }
    if ($Action -ceq 'test' -and $report.status -ceq 'VERIFIED' -and $keys -notcontains 'tests') { throw 'REFUSED' }
    if ($Action -ceq 'test' -and $keys -contains 'tests') {
        if ($null -eq $report.tests -or @($report.tests.PSObject.Properties).Count -ne 5 -or @($report.tests.PSObject.Properties.Name | Where-Object { $_ -notin @('total','passed','failed','skipped','failedCases') }).Count -ne 0) { throw 'REFUSED' }
        foreach ($key in @('total','passed','failed','skipped')) {
            $n = $report.tests.$key
            if (($n -isnot [int] -and $n -isnot [long]) -or $n -lt 0 -or $n -gt 1000) { throw 'REFUSED' }
        }
        if ($report.tests.total -ne 14 -or ($report.tests.passed + $report.tests.failed + $report.tests.skipped) -ne 14) { throw 'REFUSED' }
        if ($report.status -ceq 'VERIFIED' -and ($report.tests.failed -ne 0 -or $report.tests.skipped -ne 0)) { throw 'REFUSED' }
        if ($report.status -ceq 'UNKNOWN' -and ($report.tests.failed + $report.tests.skipped) -eq 0) { throw 'REFUSED' }
        if ($report.tests.failedCases -isnot [array] -or $report.tests.failedCases.Count -ne $report.tests.failed) { throw 'REFUSED' }
        $ids = @('A01','A02','A03','A04','A05','A06','A07','A08:APPLE','A08:GOOGLE','A09','A10','A11','A12','A13')
        foreach ($id in $report.tests.failedCases) { if ($id -isnot [string] -or $id -cnotin $ids) { throw 'REFUSED' } }
        if (@($report.tests.failedCases | Select-Object -Unique).Count -ne $report.tests.failedCases.Count) { throw 'REFUSED' }
        $safe.tests = [ordered]@{ total = $report.tests.total; passed = $report.tests.passed; failed = $report.tests.failed; skipped = $report.tests.skipped; failedCases = @($report.tests.failedCases) }
    } elseif ($keys -contains 'tests') { throw 'REFUSED' }

    return $safe
}
$ErrorActionPreference = 'Stop'
$secure = $null
$plain = $null
$packet = $null
$process = $null
$credentials = @{}
try {
    # Refuse inherited application/libpq configuration rather than silently using it.
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').Keys) {
        if ([string]$entry -match '^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|PG.*|NODE_OPTIONS|NODE_PATH)$') { throw 'REFUSED' }
    }
    $manifestFile = [IO.Path]::GetFullPath($ManifestPath).Replace('\','/')
    if ($manifestFile -notmatch '^D:/text-to-voice-it/[0-9a-f-]{36}/manifest\.json$') { throw 'REFUSED' }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($manifestFile -cne ('D:/text-to-voice-it/' + $manifest.runId + '/manifest.json')) { throw 'REFUSED' }
    $approval = Read-Host ('Nhap chinh xac APPROVE ' + $manifest.runId + ' ' + $Action)
    if ($approval -cne ('APPROVE ' + $manifest.runId + ' ' + $Action)) { throw 'REFUSED' }
    foreach ($role in @('owner','writer','reader')) {
        $secure = Read-Host ('URL MOI cua ' + $role + ' tai 127.0.0.1:56432/postgres') -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $credentials[$role] = $plain
        $plain = $null
        $secure.Dispose(); $secure = $null
    }
    $packet = @{ manifest = $manifest; credentials = $credentials; action = $Action; approval = $approval } | ConvertTo-Json -Depth 12 -Compress
    if ($packet.Length -gt 32768) { throw 'REFUSED' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command node -CommandType Application).Source
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'run.cjs') + '"'
    $start.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $allowed = @('SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC')
    $start.EnvironmentVariables.Clear()
    foreach ($key in $allowed) { $value = [Environment]::GetEnvironmentVariable($key); if ($null -ne $value) { $start.EnvironmentVariables[$key] = $value } }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'REFUSED' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($packet); $process.StandardInput.Close()
    if (-not $process.WaitForExit(600000)) {
        # Do not retry, clean up DBs, or claim that a timed-out operation rolled back.
        $process.Kill()
        throw 'REFUSED'
    }
    $report = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
    $null = $stderr.GetAwaiter().GetResult()
    $safe = ConvertTo-AcceptanceReport $report $Action $process.ExitCode
    $safe | ConvertTo-Json -Compress
    if ($process.ExitCode -ne 0 -or $report.status -ne 'VERIFIED' -or $report.code -ne 'ACCEPTANCE_STEP_PASS') { exit 1 }
}
catch {
    '{"status":"UNKNOWN","readiness":"NOT_READY","code":"ACCEPTANCE_WRAPPER_FAILED_OR_OUTCOME_UNKNOWN"}'
    exit 1
}
finally {
    if ($secure) { $secure.Dispose() }
    $plain = $null; $packet = $null
    $credentials.Clear()
    if ($process) { $process.Dispose() }
}
