[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

# Independent inspection launcher. Never imports the integration harness.
$secret = $null
$buffer = [IntPtr]::Zero
$raw = $null
$uri = $null
$identity = $null
$info = $null
$child = $null
$stdoutTask = $null
$stderrTask = $null
try {
    $secret = Read-Host 'TEST lifecycle URL to /postgres (hidden; percent-encode password characters)' -AsSecureString
    $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $raw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
    if ($raw -cnotmatch '^postgres(?:ql)?://[^/?#\s]+@127\.0\.0\.1:55432/postgres$' -or
        $raw -match '[\s\\?#]' -or $raw -match '%(?![0-9a-fA-F]{2})' -or
        -not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri)) { throw 'URL_REJECTED' }
    $identity = $uri.UserInfo.Split([char[]]':', 2)
    if ($uri.Host -cne '127.0.0.1' -or $uri.Port -ne 55432 -or $uri.AbsolutePath -cne '/postgres' -or
        $uri.Query -or $uri.Fragment -or $identity.Length -ne 2 -or
        [string]::IsNullOrEmpty($identity[1]) -or
        [Uri]::UnescapeDataString($identity[0]) -cne 'ttv_surplus_lifecycle') { throw 'URL_REJECTED' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $info.Arguments = '"' + (Join-Path $PSScriptRoot 'inspect-payment-surplus-target.cjs') + '"'
    $info.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    foreach ($key in @('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -ne $value) { $info.EnvironmentVariables[$key] = $value }
    }
    $info.EnvironmentVariables['SURPLUS_TARGET_URL'] = $raw
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    if (-not $child.Start()) { throw 'INSPECTION_FAILED' }
    $stdoutTask = $child.StandardOutput.ReadToEndAsync()
    $stderrTask = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(60000)) {
        $child.Kill()
        [void]$child.WaitForExit(3000)
        throw 'INSPECTION_TIMEOUT'
    }
    $result = $stdoutTask.GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop
    [void]$stderrTask.GetAwaiter().GetResult()
    # Render only known statuses and strongly validated metadata, never raw output.
    $reasons = @('HISTORY_MATCHES', 'HISTORY_NOT_FOUND', 'HISTORY_INCOMPLETE_OR_DIFFERS',
        'IDENTITY_MISMATCH', 'MARKER_MISMATCH', 'URL_REJECTED', 'LOCAL_MIGRATIONS_INVALID',
        'HISTORY_OBJECT_INVALID', 'HISTORY_DATA_INVALID', 'LOCAL_MIGRATIONS_CHANGED',
        'INSUFFICIENT_PRIVILEGE', 'QUERY_OR_CONNECTION_FAILED', 'CONNECTION_CLOSE_FAILED',
        'CONNECTION_LOST', 'INSPECTION_FAILED')
    if ($result.status -cnotin @('PASS', 'FAIL', 'UNKNOWN') -or $result.reason -cnotin $reasons) {
        throw 'INSPECTION_FAILED'
    }
    if ($result.status -ceq 'PASS' -and ($child.ExitCode -ne 0 -or $result.reason -cne 'HISTORY_MATCHES')) {
        throw 'INSPECTION_FAILED'
    }
    if ($result.status -ceq 'PASS' -and
        ($null -eq $result.database -or @($result.history).Count -ne 24)) { throw 'INSPECTION_FAILED' }
    $rendered = New-Object 'System.Collections.Generic.List[string]'
    [void]$rendered.Add('STATUS=' + $result.status + ' REASON=' + $result.reason)
    if ($null -ne $result.database) {
        if ($result.database -cne 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f' -or
            [string]$result.oid -cne '16393' -or $result.owner -cne 'ttv_surplus_writer' -or
            [string]$result.ownerOid -cne '16389' -or
            $result.markerFingerprint -cnotmatch '^[0-9a-f]{64}$') { throw 'INSPECTION_FAILED' }
        [void]$rendered.Add('DATABASE=' + $result.database + ' OID=16393 OWNER=ttv_surplus_writer OWNER_OID=16389')
        [void]$rendered.Add('MARKER_SHA256=' + $result.markerFingerprint + ' ORIGIN=UNVERIFIED')
    }
    foreach ($row in $result.history) {
        if ($row.migration_name -cnotmatch '^([0-9]{14}_[a-z0-9_]+|UNEXPECTED_MIGRATION)$' -or
            $row.checksum -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$row.applied_steps_count -cnotmatch '^[0-9]+$' -or
            $row.checksum_matches -isnot [bool]) { throw 'INSPECTION_FAILED' }
        foreach ($key in @('started_at', 'finished_at', 'rolled_back_at')) {
            if ($null -ne $row.$key -and [string]$row.$key -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
                throw 'INSPECTION_FAILED'
            }
        }
        if ($result.status -ceq 'PASS' -and
            (-not $row.checksum_matches -or $null -eq $row.started_at -or
                $null -eq $row.finished_at -or $null -ne $row.rolled_back_at)) { throw 'INSPECTION_FAILED' }
        $renderedRow = [pscustomobject]@{ migration_name=$row.migration_name; checksum=$row.checksum;
            started_at=$row.started_at; finished_at=$row.finished_at;
            rolled_back_at=$row.rolled_back_at; applied_steps_count=$row.applied_steps_count;
            checksum_matches=$row.checksum_matches } | ConvertTo-Json -Compress
        [void]$rendered.Add($renderedRow)
    }
    $rendered | Write-Output
    if ($result.status -cne 'PASS') { throw 'INSPECTION_NOT_PASS' }
}
catch { throw 'READONLY_TARGET_INSPECTION_FAILED_OR_UNKNOWN' }
finally {
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
    if ($null -ne $secret) { $secret.Dispose() }
    if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
    [Environment]::SetEnvironmentVariable('SURPLUS_TARGET_URL', $null, 'Process')
    $raw = $null
    $uri = $null
    $identity = $null
    $stdoutTask = $null
    $stderrTask = $null
    if ($null -ne $child) { $child.Dispose() }
}
