[CmdletBinding()]
param([switch]$RunHarness, [switch]$CheckConnection, [switch]$WriteTests,
    [ValidateSet('OBSERVER','TEST_ADMIN')][string]$ObservationMode='OBSERVER')

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 compatible. No secret persistence.
# Default: prompt, validate, discard. Running the harness requires a separate
# explicit approval in the parent environment AND the -RunHarness switch.
# -WriteTests only adds the fixed --write-tests argument to an approved run.
function Assert-SurplusTestConfiguration {
    param([System.Collections.IDictionary]$Configuration)

    $roles = [ordered]@{
        PAYMENT_SURPLUS_TEST_ADMIN_URL = 'ttv_surplus_lifecycle'
        PAYMENT_SURPLUS_TEST_WRITER_URL = 'ttv_surplus_writer'
        PAYMENT_SURPLUS_TEST_READER_URL = 'ttv_surplus_reader'
    }
    if ($Configuration.Contains('PAYMENT_SURPLUS_TEST_OBSERVATION_URL')) {
        if ($Configuration['PAYMENT_SURPLUS_TEST_OBSERVATION_MODE'] -cnotin @('OBSERVER','TEST_ADMIN')) {
            throw 'PREFLIGHT_CONFIGURATION_INVALID'
        }
        $roles['PAYMENT_SURPLUS_TEST_OBSERVATION_URL'] = if ($Configuration['PAYMENT_SURPLUS_TEST_OBSERVATION_MODE'] -ceq 'TEST_ADMIN') {'postgres'} else {'ttv_surplus_observer'}
    }
    foreach ($key in @($roles.Keys) + @(
        'PAYMENT_SURPLUS_TEST_PORT',
        'PAYMENT_SURPLUS_TEST_CLUSTER_ID',
        'PAYMENT_SURPLUS_TEST_DATA_DIRECTORY'
    )) {
        if (-not $Configuration -or
            [string]::IsNullOrEmpty([string]$Configuration[$key])) {
            throw 'TEST_CONFIGURATION_MISSING'
        }
    }
    if ($Configuration['PAYMENT_SURPLUS_TEST_PORT'] -cne '55432' -or
        $Configuration['PAYMENT_SURPLUS_TEST_CLUSTER_ID'] -cne '7703979600700924132' -or
        $Configuration['PAYMENT_SURPLUS_TEST_DATA_DIRECTORY'] -cne 'D:/text-to-voice/pg-test-cluster') {
        throw 'TEST_CLUSTER_CONFIGURATION_MISMATCH'
    }
    foreach ($key in $roles.Keys) {
        $value = [string]$Configuration[$key]
        $uri = $null
        if ($value -cnotmatch '^postgres(?:ql)?://[^/?#\s]+@127\.0\.0\.1:55432/postgres$' -or
            $value -match '[\s\\?#]' -or $value -match '%(?![0-9A-Fa-f]{2})' -or
            -not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri)) {
            throw 'TEST_URL_REJECTED'
        }
        if ($uri.Host -cne '127.0.0.1' -or $uri.Port -ne 55432 -or
            $uri.AbsolutePath -cne '/postgres' -or $uri.Query -or $uri.Fragment) {
            throw 'TEST_URL_REJECTED'
        }
        $identity = $uri.UserInfo.Split([char[]]':', 2)
        if ($identity.Length -ne 2 -or [string]::IsNullOrEmpty($identity[1]) -or
            [Uri]::UnescapeDataString($identity[0]) -cne $roles[$key]) {
            throw 'TEST_ROLE_OR_PASSWORD_MISSING'
        }
    }
}

function Read-SurplusSecretUrl {
    param([string]$Role)
    $secret = $null
    $buffer = [IntPtr]::Zero
    try {
        $secret = Read-Host "TEST URL for $Role (hidden input; percent-encode password characters)" -AsSecureString
        $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
    }
    finally {
        if ($buffer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)
        }
        if ($null -ne $secret) { $secret.Dispose() }
    }
}

function New-SurplusChildStartInfo {
    param(
        [System.Collections.IDictionary]$Configuration,
        [string]$NodePath,
        [string]$RunnerPath,
        [string]$BackendPath,
        [string]$Approval,
        [switch]$WriteTests
    )
    Assert-SurplusTestConfiguration $Configuration
    if (-not $Configuration.Contains('PAYMENT_SURPLUS_TEST_OBSERVATION_URL')) { throw 'PREFLIGHT_CONFIGURATION_INVALID' }
    if ($Approval -cne 'YES') { throw 'RUN_NOT_APPROVED' }
    if ($RunnerPath.Contains('"')) { throw 'INVALID_RUNNER_PATH' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $NodePath
    $info.Arguments = '"' + $RunnerPath + '"'
    if ($WriteTests) { $info.Arguments += ' --write-tests' }
    $info.WorkingDirectory = $BackendPath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables.Clear()
    foreach ($key in @(
        'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
        'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'LANG', 'LC_ALL'
    )) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -ne $value) { $info.EnvironmentVariables[$key] = $value }
    }
    foreach ($key in $Configuration.Keys) {
        if ($key -notin @(
            'PAYMENT_SURPLUS_TEST_ADMIN_URL', 'PAYMENT_SURPLUS_TEST_WRITER_URL',
            'PAYMENT_SURPLUS_TEST_READER_URL', 'PAYMENT_SURPLUS_TEST_PORT',
            'PAYMENT_SURPLUS_TEST_CLUSTER_ID', 'PAYMENT_SURPLUS_TEST_DATA_DIRECTORY',
            'PAYMENT_SURPLUS_TEST_OBSERVATION_URL', 'PAYMENT_SURPLUS_TEST_OBSERVATION_MODE'
        )) { throw 'UNEXPECTED_TEST_CONFIGURATION' }
        $info.EnvironmentVariables[$key] = [string]$Configuration[$key]
    }
    $info.EnvironmentVariables['TZ'] = 'UTC'
    # Forward an already supplied approval; never set the parent approval flag.
    $info.EnvironmentVariables['PAYMENT_SURPLUS_TEMP_ALLOW_RUN'] = $Approval
    return $info
}

function Invoke-SurplusConnectionCheck {
    param([System.Collections.IDictionary]$Configuration)
    Assert-SurplusTestConfiguration $Configuration
    # Code only is sent on the command line. Each child receives one secret URL.
    # No application modules, Prisma, dotenv, harness or DDL/DML are loaded.
    $probe = @'
'use strict';
const { Client } = require('pg');
const role = process.env.SURPLUS_PROBE_ROLE;
const allowed = ['ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader'];
let status = 'CONNECTION_FAILED';
let fields = [];
let phase = 'configuration';
function mismatch(names, invalid = false) {
  fields = names;
  status = invalid ? 'METADATA_INVALID' : 'IDENTITY_MISMATCH';
}
function compare(row, expected, missing) {
  if (!row || typeof row !== 'object') { mismatch([missing], true); return false; }
  const invalid = expected.filter(([key]) => typeof row[key] !== 'string').map(([, , label]) => label);
  if (invalid.length) { mismatch(invalid, true); return false; }
  const different = expected.filter(([key, value]) => row[key] !== value).map(([, , label]) => label);
  if (different.length) { mismatch(different); return false; }
  return true;
}
let client;
let lost = false;
async function close() {
  if (!client) return;
  let timer;
  try {
    await Promise.race([client.end(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLOSE_TIMEOUT')), 3000);
    })]);
  } catch {
    client.unref();
    status = 'CLEANUP_FAILED';
  } finally { clearTimeout(timer); }
}
(async () => {
  try {
    const raw = process.env.SURPLUS_PROBE_URL;
    if (!allowed.includes(role) || typeof raw !== 'string' ||
        !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(raw) ||
        /[\s\\?#]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) {
      mismatch(['configuration']); return;
    }
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1' || url.port !== '55432' ||
        url.pathname !== '/postgres' || url.search || url.hash ||
        decodeURIComponent(url.username) !== role || !url.password) {
      mismatch(['configuration']); return;
    }
    client = new Client({connectionString: url.toString(),
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
      connectionTimeoutMillis: 5000, query_timeout: 5000,
      application_name: 'ttv-surplus-readonly-connection-check'});
    client.on('error', () => { lost = true; });
    phase = 'connection';
    await client.connect();
    phase = 'endpoint_metadata';
    const endpoint = (await client.query(`SELECT current_user AS role,
      session_user AS session_role, current_database() AS db,
      host(inet_server_addr()) AS host, inet_server_port()::text AS port,
      current_setting('default_transaction_read_only') AS session_ro,
      current_setting('transaction_read_only') AS tx_ro`)).rows[0];
    if (!compare(endpoint, [
      ['role', role, 'current_user'], ['session_role', role, 'session_user'],
      ['db', 'postgres', 'current_database'], ['host', '127.0.0.1', 'server_address'],
      ['port', '55432', 'server_port'], ['session_ro', 'on', 'session_read_only'],
      ['tx_ro', 'on', 'transaction_read_only']
    ], 'endpoint_metadata')) return;
    if (role === 'ttv_surplus_reader') {
      // The parent creates this attestation only after lifecycle's full metadata
      // verification AND successful connection cleanup in this same invocation.
      // Endpoint/user/read-only checks above remain mandatory for the reader.
      if (process.env.SURPLUS_PROBE_LIFECYCLE_VERIFIED !== '1') {
        mismatch(['lifecycle_verification']); return;
      }
      status = lost ? 'CONNECTION_FAILED' : 'PASS';
      return;
    }
    phase = 'cluster_metadata';
    const identity = (await client.query(`SELECT
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
      current_setting('data_directory') AS directory`)).rows[0];
    if (!compare(identity && {...identity,
      directory: typeof identity.directory === 'string' ?
        identity.directory.replaceAll('\\','/').replace(/\/+$/, '').toLowerCase() : identity.directory
    }, [
      ['cluster', '7703979600700924132', 'cluster_id'],
      ['directory', 'd:/text-to-voice/pg-test-cluster', 'data_directory']
    ], 'cluster_metadata')) return;
    status = lost ? 'CONNECTION_FAILED' : 'PASS';
  } catch (error) {
    fields = [phase];
    status = error.code === '42501' ? 'INSUFFICIENT_PRIVILEGE' :
      phase !== 'connection' && /^[0-9A-Z]{5}$/.test(error.code || '') &&
        !/^(08|28|57P)/.test(error.code) ? 'QUERY_FAILED' : 'CONNECTION_FAILED';
  } finally {
    await close();
    if (lost && status === 'PASS') status = 'CONNECTION_FAILED';
    delete process.env.SURPLUS_PROBE_URL;
    delete process.env.SURPLUS_PROBE_LIFECYCLE_VERIFIED;
    process.stdout.write(JSON.stringify({status, fields}));
    process.exitCode = status === 'PASS' ? 0 : 1;
  }
})().catch(() => { process.exitCode = 1; });
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
    $roles = [ordered]@{
        PAYMENT_SURPLUS_TEST_ADMIN_URL = 'ttv_surplus_lifecycle'
        PAYMENT_SURPLUS_TEST_WRITER_URL = 'ttv_surplus_writer'
        PAYMENT_SURPLUS_TEST_READER_URL = 'ttv_surplus_reader'
    }
    # Local to this invocation; never accept an inherited environment attestation.
    $lifecycleVerified = $false
    foreach ($key in $roles.Keys) {
        $info = $null
        $child = $null
        $stdoutTask = $null
        $stderrTask = $null
        try {
            if ($roles[$key] -ceq 'ttv_surplus_reader' -and -not $lifecycleVerified) {
                Write-Output 'ttv_surplus_reader IDENTITY_MISMATCH'
                Write-Output 'FIELDS=lifecycle_verification'
                throw 'CONNECTION_CHECK_FAILED'
            }
            $info = New-Object System.Diagnostics.ProcessStartInfo
            $info.FileName = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
            $info.Arguments = '-e "eval(Buffer.from(''' + $encoded + ''',''base64'').toString(''utf8''))"'
            $info.WorkingDirectory = Split-Path -Parent $PSScriptRoot
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            $info.RedirectStandardOutput = $true
            $info.RedirectStandardError = $true
            $info.EnvironmentVariables.Clear()
            foreach ($osKey in @('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP')) {
                $value = [Environment]::GetEnvironmentVariable($osKey, 'Process')
                if ($null -ne $value) { $info.EnvironmentVariables[$osKey] = $value }
            }
            $info.EnvironmentVariables['SURPLUS_PROBE_URL'] = [string]$Configuration[$key]
            $info.EnvironmentVariables['SURPLUS_PROBE_ROLE'] = $roles[$key]
            if ($roles[$key] -ceq 'ttv_surplus_reader' -and $lifecycleVerified) {
                $info.EnvironmentVariables['SURPLUS_PROBE_LIFECYCLE_VERIFIED'] = '1'
            }
            $child = New-Object System.Diagnostics.Process
            $child.StartInfo = $info
            if (-not $child.Start()) { throw 'CONNECTION_CHECK_FAILED' }
            $stdoutTask = $child.StandardOutput.ReadToEndAsync()
            $stderrTask = $child.StandardError.ReadToEndAsync()
            if (-not $child.WaitForExit(20000)) {
                # Only our own SELECT-only probe, never pg_terminate_backend.
                $child.Kill()
                [void]$child.WaitForExit(3000)
                throw 'CONNECTION_CHECK_TIMEOUT'
            }
            $result = $stdoutTask.GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop
            [void]$stderrTask.GetAwaiter().GetResult()
            $safeStatus = if ($result.status -cin @(
                'PASS', 'INSUFFICIENT_PRIVILEGE', 'IDENTITY_MISMATCH',
                'CONNECTION_FAILED', 'CLEANUP_FAILED', 'METADATA_INVALID', 'QUERY_FAILED'
            )) { $result.status } else { 'CONNECTION_FAILED' }
            Write-Output ($roles[$key] + ' ' + $safeStatus)
            $safeFields = @($result.fields | Where-Object { $_ -cin @(
                'configuration', 'connection', 'endpoint_metadata', 'cluster_metadata',
                'current_user', 'session_user', 'current_database', 'server_address',
                'server_port', 'session_read_only', 'transaction_read_only',
                'cluster_id', 'data_directory', 'lifecycle_verification'
            ) } | Select-Object -Unique)
            if ($safeStatus -cne 'PASS' -and $safeFields.Count -gt 0) {
                Write-Output ('FIELDS=' + ($safeFields -join ','))
            }
            if ($safeStatus -cne 'PASS' -or $child.ExitCode -ne 0) {
                throw 'CONNECTION_CHECK_FAILED'
            }
            if ($roles[$key] -ceq 'ttv_surplus_lifecycle') {
                $lifecycleVerified = $true
            }
        }
        catch { throw 'CONNECTION_CHECK_FAILED' }
        finally {
            if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
            $stdoutTask = $null
            $stderrTask = $null
            if ($null -ne $child) { $child.Dispose() }
        }
    }
    Write-Output 'CONNECTION_CHECK_PASS: three TEST roles verified read-only; harness not started'
}

function ConvertTo-SurplusApprovalRequest {
    param([string]$Line, [int]$RunnerPid, [string]$Mode, [string]$ObservationMode)
    if ($Line.Length -gt 2048) { throw 'PREFLIGHT_APPROVAL_INVALID' }
    try { $request = $Line | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'PREFLIGHT_APPROVAL_INVALID' }
    $allowed=@('version','type','runId','mode','target','runnerPid','challenge','observationMode')
    if ($request -isnot [pscustomobject] -or @($request.PSObject.Properties).Count -ne $allowed.Count -or
        @($request.PSObject.Properties.Name | Where-Object {$_ -cnotin $allowed}).Count -ne 0 -or
        $request.version -isnot [int] -or $request.version -ne 1 -or $request.type -isnot [string] -or $request.type -cne 'PREFLIGHT_CHALLENGE' -or
        $request.runId -isnot [string] -or $request.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $request.mode -isnot [string] -or $request.observationMode -isnot [string] -or
        $request.mode -cne $Mode -or $request.observationMode -cne $ObservationMode -or
        $request.runnerPid -isnot [int] -or $request.runnerPid -ne $RunnerPid -or
        $request.target -isnot [string] -or $request.target -cnotmatch '^ttv_surplus_it_[0-9a-f]{32}$' -or
        $request.challenge -isnot [string] -or $request.challenge -cnotmatch '^[0-9a-f]{64}$') {
        throw 'PREFLIGHT_APPROVAL_INVALID'
    }
    # Fixed, validated fields only. No raw child text reaches the prompt.
    return $request
}

function Confirm-SurplusRunApproval {
    param($Child, [string]$Mode, [string]$ObservationMode)
    $lineTask=$Child.StandardOutput.ReadLineAsync()
    if (-not $lineTask.Wait(5000)) { throw 'PREFLIGHT_APPROVAL_TIMEOUT' }
    $line=$lineTask.GetAwaiter().GetResult()
    if ($null -eq $line) { throw 'PREFLIGHT_CHANNEL_CLOSED' }
    $request=ConvertTo-SurplusApprovalRequest $line $Child.Id $Mode $ObservationMode
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $expected='CONFIRM '+$request.runId+' '+$request.mode+' '+$request.target+' EXCLUSIVE'
    $confirmation=Read-Host ('Xac nhan khong co quan tri/DDL dong thoi trong cua so chay. Nhap chinh xac: '+$expected)
    if ($watch.ElapsedMilliseconds -ge 120000 -or $Child.HasExited) { throw 'PREFLIGHT_APPROVAL_TIMEOUT' }
    if ($confirmation -cne $expected) { throw 'PREFLIGHT_APPROVAL_INVALID' }
    $reply=@{version=1;runId=$request.runId;mode=$request.mode;target=$request.target;
        challenge=$request.challenge;confirmRun=$true;confirmExclusive=$true}|ConvertTo-Json -Compress
    $Child.StandardInput.WriteLine($reply)
    $Child.StandardInput.Flush()
    # Keep stdin open until completion; EOF revokes the runner's approval.
}

function Write-SurplusRunnerDiagnostics {
    param([string]$OutputText)
    # Treat all child output as untrusted. Never forward raw lines or messages.
    foreach ($line in ($OutputText -split '\r?\n')) {
        if ($line.Length -gt 16384) { continue }
        try { $item = $line | ConvertFrom-Json -ErrorAction Stop }
        catch { continue }
        if ($item.surplusStatus -ceq 'PREFLIGHT_RESULT') {
            $codes=@('PREFLIGHT_GO','PREFLIGHT_CONFIGURATION_INVALID','PREFLIGHT_APPROVAL_INVALID',
                'PREFLIGHT_APPROVAL_TIMEOUT','PREFLIGHT_CHANNEL_CLOSED','PREFLIGHT_INTERRUPTED',
                'PREFLIGHT_EVIDENCE_INVALID','PREFLIGHT_IDENTITY_MISMATCH','PREFLIGHT_METADATA_BLOCKED',
                'PREFLIGHT_SESSION_UNEXPLAINED','PREFLIGHT_EXPIRED','PREFLIGHT_ALREADY_CONSUMED','PREFLIGHT_NOT_READY')
            if ($item.verification -cin @('VERIFIED','FAIL','UNKNOWN') -and $item.readiness -ceq 'NOT_READY' -and $item.code -cin $codes) {
                Write-Output ('PREFLIGHT_VERIFICATION='+$item.verification+' READINESS=NOT_READY CODE='+$item.code)
            }
        }
        if ($item.surplusStatus -cin @(
            'PREFLIGHT_FAILED', 'TEMP_DB_CREATED', 'MIGRATION_PASS', 'MIGRATION_FAILED',
            'JEST_PASS', 'JEST_FAILED', 'SETUP_FAILED', 'CLEANUP_PASS', 'CLEANUP_FAILED',
            'DROP_OUTCOME_UNKNOWN', 'HARNESS_PASS',
            'HARNESS_TIMEOUT', 'TEMP_DB_CREATE_OUTCOME_UNKNOWN'
        )) {
            Write-Output ([string]$item.surplusStatus)
        }
        if ($item.stage -cin @(
            'configuration', 'cluster-preflight', 'create-database',
            'migration-direct-preflight', 'migration', 'migration-history',
            'fixture', 'reader-grants', 'reader-preflight', 'http',
            'cleanup-writer', 'cleanup-database'
        )) {
            $safeCode = if ($item.code -cin @(
                'RUN_NOT_APPROVED', 'INVALID_CONFIGURATION', 'FIXED_TEST_CLUSTER_REQUIRED',
                'FIXED_TEST_ENDPOINT_REQUIRED', 'CLUSTER_IDENTITY_MISMATCH',
                'DEDICATED_UNPRIVILEGED_WRITER_AND_READER_REQUIRED',
                'LIFECYCLE_CREATEDB_WITHOUT_ADMIN_PRIVILEGES_REQUIRED',
                'LIFECYCLE_ROLE_IDENTITY_MISMATCH', 'LIFECYCLE_DIRECT_WRITER_SET_INHERIT_REQUIRED',
                'REVERSE_LIFECYCLE_WRITER_MEMBERSHIP_FORBIDDEN',
                'LIFECYCLE_ROLE_MEMBERSHIP_OUTSIDE_ALLOWLIST', 'TEST_ROLE_MEMBERSHIP_TOO_BROAD',
                'WRITER_CANNOT_VERIFY_CLUSTER_SETTINGS', 'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
                'DIRECT_TEMP_DATABASE_PREFLIGHT_FAILED', 'MIGRATION_HISTORY_MISMATCH',
                'MIGRATION_FILES_CHANGED_DURING_RUN', 'READER_HAS_WRITE_PRIVILEGES',
                'FOUR_HTTP_PASSES_REQUIRED', 'ALL_WRITE_CASES_REQUIRED', 'CHILD_COMMAND_FAILED', 'CHILD_TIMEOUT',
                'CHILD_NOT_CLOSED', 'CHILD_START_FAILED', 'CHILD_OUTPUT_LIMIT',
                'CHILD_LIFECYCLE_NOT_SETTLED', 'WRITER_LIFECYCLE_NOT_SETTLED',
                'DATABASE_NOT_CREATED_BY_THIS_PROCESS', 'DATABASE_OWNERSHIP_OR_MARKER_MISMATCH',
                'DATABASE_STILL_HAS_CONNECTIONS', 'DATABASE_DROP_NOT_CONFIRMED',
                'CLEANUP_TIMEOUT', 'HARNESS_TIMEOUT', 'RUN_INTERRUPTED', 'OPERATION_FAILED',
                'PREFLIGHT_CONFIGURATION_INVALID','PREFLIGHT_APPROVAL_INVALID','PREFLIGHT_APPROVAL_TIMEOUT',
                'PREFLIGHT_CHANNEL_CLOSED','PREFLIGHT_INTERRUPTED','PREFLIGHT_EVIDENCE_INVALID',
                'PREFLIGHT_IDENTITY_MISMATCH','PREFLIGHT_METADATA_BLOCKED','PREFLIGHT_SESSION_UNEXPLAINED',
                'PREFLIGHT_EXPIRED','PREFLIGHT_ALREADY_CONSUMED','PREFLIGHT_NOT_READY'
            )) { [string]$item.code } else { 'UNCLASSIFIED' }
            Write-Output ('RUNNER_STAGE=' + $item.stage + ' CODE=' + $safeCode)
            if ([string]$item.sqlstate -cmatch '^[0-9A-Z]{5}$') {
                Write-Output ('SQLSTATE=' + $item.sqlstate)
            }
        }
    }
}

function Wait-SurplusHarnessProcess {
    param($Child, [ValidateRange(1, 420000)][int]$TimeoutMilliseconds = 420000)
    $remaining = $TimeoutMilliseconds
    while ($remaining -gt 0) {
        $slice = [Math]::Min(1000, $remaining)
        if ($Child.WaitForExit($slice)) { return }
        $remaining -= $slice
    }
    # A hard timeout cannot establish whether CREATE/DROP completed. Never retry.
    Write-Output 'HARNESS_TIMEOUT'
    Write-Output 'DROP_OUTCOME_UNKNOWN'
    try {
        if (-not $Child.HasExited) {
            $Child.Kill() # Only the Node runner started by this script; never a PostgreSQL backend.
            [void]$Child.WaitForExit(5000)
        }
    } catch { throw 'HARNESS_TIMEOUT_PROCESS_STATE_UNKNOWN' }
    throw 'HARNESS_TIMEOUT'
}

function Invoke-SurplusSecurePreparation {
    param([switch]$ExecuteHarness, [switch]$VerifyConnection, [switch]$WriteTests,
        [ValidateSet('OBSERVER','TEST_ADMIN')][string]$ObservationMode='OBSERVER')
    $configuration = @{}
    $info = $null
    $child = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        if ($ExecuteHarness -and $VerifyConnection) { throw 'INCOMPATIBLE_TEST_MODES' }
        if ($WriteTests -and -not $ExecuteHarness) { throw 'WRITE_TESTS_REQUIRE_RUN_HARNESS' }
        $approval = [Environment]::GetEnvironmentVariable('PAYMENT_SURPLUS_TEMP_ALLOW_RUN', 'Process')
        if ($ExecuteHarness -and $approval -cne 'YES') { throw 'RUN_NOT_APPROVED' }
        $configuration['PAYMENT_SURPLUS_TEST_PORT'] = '55432'
        $configuration['PAYMENT_SURPLUS_TEST_CLUSTER_ID'] = '7703979600700924132'
        $configuration['PAYMENT_SURPLUS_TEST_DATA_DIRECTORY'] = 'D:/text-to-voice/pg-test-cluster'
        $configuration['PAYMENT_SURPLUS_TEST_ADMIN_URL'] = Read-SurplusSecretUrl 'ttv_surplus_lifecycle'
        $configuration['PAYMENT_SURPLUS_TEST_WRITER_URL'] = Read-SurplusSecretUrl 'ttv_surplus_writer'
        $configuration['PAYMENT_SURPLUS_TEST_READER_URL'] = Read-SurplusSecretUrl 'ttv_surplus_reader'
        if ($ExecuteHarness) {
            $configuration['PAYMENT_SURPLUS_TEST_OBSERVATION_MODE']=$ObservationMode
            $configuration['PAYMENT_SURPLUS_TEST_OBSERVATION_URL']=Read-SurplusSecretUrl $(if($ObservationMode -ceq 'TEST_ADMIN'){'postgres'}else{'ttv_surplus_observer'})
        }
        Assert-SurplusTestConfiguration $configuration
        foreach ($key in ($configuration.Keys | Sort-Object)) { Write-Output "$key PRESENT" }
        if ($VerifyConnection) {
            Invoke-SurplusConnectionCheck $configuration
            return
        }
        if (-not $ExecuteHarness) {
            Write-Output 'PREPARATION_PASS: validated; harness not started; secrets discarded on return'
            return
        }
        $backendPath = Split-Path -Parent $PSScriptRoot
        $runnerPath = Join-Path $PSScriptRoot 'run-payment-surplus-temp.cjs'
        $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
        $info = New-SurplusChildStartInfo $configuration $nodePath $runnerPath $backendPath $approval -WriteTests:$WriteTests
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $info
        if (-not $child.Start()) { throw 'CHILD_START_FAILED' }
        # Drain both streams concurrently. Never forward raw child output, which
        # could contain credentials if an unexpected dependency fails.
        $stderrTask = $child.StandardError.ReadToEndAsync()
        Confirm-SurplusRunApproval $child $(if($WriteTests){'WRITE_TESTS'}else{'READ_TESTS'}) $ObservationMode
        $stdoutTask = $child.StandardOutput.ReadToEndAsync()
        Wait-SurplusHarnessProcess $child
        Write-SurplusRunnerDiagnostics ($stdoutTask.GetAwaiter().GetResult())
        Write-SurplusRunnerDiagnostics ($stderrTask.GetAwaiter().GetResult())
        Write-Output ('HARNESS_EXIT_CODE=' + $child.ExitCode)
        if ($child.ExitCode -ne 0) { throw 'HARNESS_FAILED' }
    }
    catch {
        # No raw ErrorRecord, exception text, command parameters or child output.
        $preflightCodes=@('PREFLIGHT_CONFIGURATION_INVALID','PREFLIGHT_APPROVAL_INVALID',
            'PREFLIGHT_APPROVAL_TIMEOUT','PREFLIGHT_CHANNEL_CLOSED')
        if ($_.Exception.Message -cin $preflightCodes) {
            Write-Output ('PREFLIGHT_VERIFICATION=UNKNOWN READINESS=NOT_READY CODE='+$_.Exception.Message)
        }
        throw 'SECURE_TEST_PREPARATION_OR_RUN_FAILED'
    }
    finally {
        foreach ($key in @(
            'PAYMENT_SURPLUS_TEST_ADMIN_URL',
            'PAYMENT_SURPLUS_TEST_WRITER_URL',
            'PAYMENT_SURPLUS_TEST_READER_URL', 'PAYMENT_SURPLUS_TEST_OBSERVATION_URL'
        )) {
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
        }
        if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
        $configuration.Clear()
        $stdoutTask = $null
        $stderrTask = $null
        if ($null -ne $child) {
            try { $child.StandardInput.Close() } catch { }
            $child.Dispose()
        }
    }
}

# Dot-sourcing only defines functions for offline tests; it never prompts or runs.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-SurplusSecurePreparation -ExecuteHarness:$RunHarness -VerifyConnection:$CheckConnection -WriteTests:$WriteTests -ObservationMode $ObservationMode
}
