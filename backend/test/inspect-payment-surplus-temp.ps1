[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-SurplusInspectionResult {
    param([string]$Json, [int]$ExitCode)
    try { $result = $Json | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'INSPECTION_FAILED' }
    $allowed = @('NO_TEMP_DATABASE_FOUND', 'TEMP_DATABASE_FOUND',
        'IDENTITY_MISMATCH', 'INSUFFICIENT_PRIVILEGE', 'INSPECTION_FAILED')
    if ($result.status -cnotin $allowed) { throw 'INSPECTION_FAILED' }
    if ($result.status -cin @('NO_TEMP_DATABASE_FOUND', 'TEMP_DATABASE_FOUND') -and $ExitCode -ne 0) {
        throw 'INSPECTION_FAILED'
    }
    if (($result.status -ceq 'NO_TEMP_DATABASE_FOUND' -and @($result.databases).Count -ne 0) -or
        ($result.status -ceq 'TEMP_DATABASE_FOUND' -and @($result.databases).Count -eq 0)) {
        throw 'INSPECTION_FAILED'
    }
    Write-Output ([string]$result.status)
    if ($result.status -ceq 'TEMP_DATABASE_FOUND') {
        foreach ($db in $result.databases) {
            if ($db.name -cnotmatch '^ttv_surplus_it_[0-9a-f]{32}$' -or
                [string]$db.oid -cnotmatch '^[1-9][0-9]*$' -or
                [string]$db.ownerOid -cnotmatch '^[1-9][0-9]*$' -or
                $db.marker -cnotin @('ABSENT', 'HARNESS_FORMAT', 'OTHER_FORMAT', 'UNKNOWN') -or
                ([string]$db.connections -cne 'UNKNOWN' -and
                    [string]$db.connections -cnotmatch '^[0-9]+$')) {
                throw 'INSPECTION_FAILED'
            }
            # Names of unexpected owner roles are suppressed, not raw-echoed.
            $owner = if ($db.owner -cin @('postgres', 'ttv_surplus_lifecycle',
                'ttv_surplus_writer', 'ttv_surplus_reader')) { $db.owner } else { 'OTHER_ROLE' }
            [pscustomobject]@{
                Database = $db.name
                OID = [string]$db.oid
                Owner = $owner
                OwnerOID = [string]$db.ownerOid
                Connections = [string]$db.connections
                Marker = $db.marker
            } | ConvertTo-Json -Compress
        }
    }
    if ($result.status -cnotin @('NO_TEMP_DATABASE_FOUND', 'TEMP_DATABASE_FOUND')) {
        throw 'INSPECTION_FAILED'
    }
}

function Invoke-SurplusTempInspection {
    $secret = $null
    $buffer = [IntPtr]::Zero
    $raw = $null
    $info = $null
    $child = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $secret = Read-Host 'TEST lifecycle URL (hidden; percent-encode password characters)' -AsSecureString
        $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $raw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
        $uri = $null
        if ($raw -cnotmatch '^postgres(?:ql)?://[^/?#\s]+@127\.0\.0\.1:55432/postgres$' -or
            $raw -match '[\s\\?#]' -or $raw -match '%(?![0-9a-fA-F]{2})' -or
            -not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri)) {
            Write-Output 'IDENTITY_MISMATCH'; throw 'INSPECTION_FAILED'
        }
        $identity = $uri.UserInfo.Split([char[]]':', 2)
        if ($uri.Host -cne '127.0.0.1' -or $uri.Port -ne 55432 -or
            $uri.AbsolutePath -cne '/postgres' -or $uri.Query -or $uri.Fragment -or
            $identity.Length -ne 2 -or [string]::IsNullOrEmpty($identity[1]) -or
            [Uri]::UnescapeDataString($identity[0]) -cne 'ttv_surplus_lifecycle') {
            Write-Output 'IDENTITY_MISMATCH'; throw 'INSPECTION_FAILED'
        }
        $probe = @'
'use strict';
const { Client } = require('pg');
const pattern = '^ttv_surplus_it_[0-9a-f]{32}$';
const namePattern = new RegExp(pattern);
let client, lost = false;
let status = 'INSPECTION_FAILED';
let databases = [];
async function close() {
  if (!client) return;
  let timer;
  try {
    await Promise.race([client.end(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLOSE_TIMEOUT')), 3000);
    })]);
  } catch {
    try { client.unref(); } catch {}
    status = 'INSPECTION_FAILED';
  } finally { clearTimeout(timer); }
}
(async () => {
  try {
    const raw = process.env.SURPLUS_INSPECTION_URL;
    if (typeof raw !== 'string' ||
        !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(raw) ||
        /[\s\\?#]/.test(raw) || /%(?![a-f0-9]{2})/i.test(raw)) {
      status = 'IDENTITY_MISMATCH'; return;
    }
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1' || url.port !== '55432' ||
        url.pathname !== '/postgres' || url.search || url.hash || !url.password ||
        decodeURIComponent(url.username) !== 'ttv_surplus_lifecycle') {
      status = 'IDENTITY_MISMATCH'; return;
    }
    client = new Client({connectionString: url.toString(),
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
      connectionTimeoutMillis: 5000, query_timeout: 5000,
      application_name: 'ttv-surplus-temp-inspection'});
    client.on('error', () => { lost = true; });
    await client.connect();
    const identity = (await client.query(`SELECT current_user AS role,
      session_user AS session_role, current_database() AS db,
      host(inet_server_addr()) AS host, inet_server_port()::text AS port,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
      current_setting('data_directory') AS directory,
      current_setting('default_transaction_read_only') AS session_ro,
      current_setting('transaction_read_only') AS tx_ro`)).rows[0];
    if (!identity || identity.role !== 'ttv_surplus_lifecycle' ||
        identity.session_role !== 'ttv_surplus_lifecycle' || identity.db !== 'postgres' ||
        identity.host !== '127.0.0.1' || identity.port !== '55432' ||
        identity.cluster !== '7703979600700924132' ||
        typeof identity.directory !== 'string' ||
        identity.directory.replaceAll('\\','/').replace(/\/+$/, '').toLowerCase() !==
          'd:/text-to-voice/pg-test-cluster' ||
        identity.session_ro !== 'on' || identity.tx_ro !== 'on' || lost) {
      status = 'IDENTITY_MISMATCH'; return;
    }
    const rows = (await client.query(`SELECT datname AS name, oid::text AS oid,
      datdba::text AS owner_oid, pg_catalog.pg_get_userbyid(datdba) AS owner
      FROM pg_catalog.pg_database WHERE datname ~ $1 ORDER BY datname`, [pattern])).rows;
    databases = rows.map(row => {
      if (!namePattern.test(row.name) || !/^[1-9][0-9]*$/.test(row.oid) ||
          !/^[1-9][0-9]*$/.test(row.owner_oid)) throw new Error('INVALID_METADATA');
      return {name: row.name, oid: row.oid, owner: row.owner, ownerOid: row.owner_oid,
        connections: 'UNKNOWN', marker: 'UNKNOWN'};
    });
    if (databases.length) {
      try {
        // Database comments are shared objects. No connection to a temp DB is needed.
        const comments = (await client.query(`SELECT oid::text AS oid,
          pg_catalog.shobj_description(oid, 'pg_database') AS marker
          FROM pg_catalog.pg_database WHERE datname ~ $1`, [pattern])).rows;
        for (const db of databases) {
          const row = comments.find(row => row.oid === db.oid);
          if (row) db.marker = row.marker === null ? 'ABSENT' :
            typeof row.marker !== 'string' ? 'UNKNOWN' :
              /^ttv-surplus-it:[0-9a-f]{64}$/.test(row.marker) ? 'HARNESS_FORMAT' : 'OTHER_FORMAT';
        }
      } catch (error) {
        if (error.code !== '42501') throw error;
        // Insufficient permission is UNKNOWN, never evidence of an absent marker.
      }
      try {
        const sessions = (await client.query(`SELECT datid::text AS oid, count(*)::text AS count
          FROM pg_catalog.pg_stat_activity WHERE datid = ANY($1::oid[]) GROUP BY datid`,
          [databases.map(db => db.oid)])).rows;
        for (const db of databases) {
          const row = sessions.find(row => row.oid === db.oid);
          if (row && !/^[0-9]+$/.test(row.count)) throw new Error('INVALID_METADATA');
          db.connections = row ? row.count : '0';
        }
      } catch (error) {
        if (error.code !== '42501') throw error;
      }
    }
    status = databases.length ? 'TEMP_DATABASE_FOUND' : 'NO_TEMP_DATABASE_FOUND';
  } catch (error) {
    status = error.code === '42501' ? 'INSUFFICIENT_PRIVILEGE' : 'INSPECTION_FAILED';
  } finally {
    await close();
    if (lost) status = 'INSPECTION_FAILED';
    delete process.env.SURPLUS_INSPECTION_URL;
    process.stdout.write(JSON.stringify({status, databases}));
    process.exitCode = ['TEMP_DATABASE_FOUND','NO_TEMP_DATABASE_FOUND'].includes(status) ? 0 : 1;
  }
})().catch(() => { process.exitCode = 1; });
'@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
        $info.Arguments = '-e "eval(Buffer.from(''' + $encoded + ''',''base64'').toString(''utf8''))"'
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
        $info.EnvironmentVariables['SURPLUS_INSPECTION_URL'] = $raw
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $info
        if (-not $child.Start()) { throw 'INSPECTION_FAILED' }
        $stdoutTask = $child.StandardOutput.ReadToEndAsync()
        $stderrTask = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(35000)) {
            $child.Kill()
            [void]$child.WaitForExit(3000)
            throw 'INSPECTION_FAILED'
        }
        [void]$stderrTask.GetAwaiter().GetResult()
        Write-SurplusInspectionResult ($stdoutTask.GetAwaiter().GetResult()) $child.ExitCode
    }
    catch { throw 'INSPECTION_FAILED' }
    finally {
        if ($buffer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)
        }
        if ($null -ne $secret) { $secret.Dispose() }
        if ($null -ne $info) { $info.EnvironmentVariables.Clear() }
        [Environment]::SetEnvironmentVariable('SURPLUS_INSPECTION_URL', $null, 'Process')
        $raw = $null
        $uri = $null
        $identity = $null
        $stdoutTask = $null
        $stderrTask = $null
        if ($null -ne $child) { $child.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-SurplusTempInspection }
