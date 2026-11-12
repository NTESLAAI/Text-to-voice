[CmdletBinding()]
param([switch]$TestAdmin, [switch]$Observer)
$ErrorActionPreference='Stop'
$secret=$null; $buffer=[IntPtr]::Zero; $raw=$null; $uri=$null; $identity=$null
$info=$null; $child=$null; $stdoutTask=$null; $stderrTask=$null
try {
    if($TestAdmin -and $Observer){throw 'MODE_CONFLICT'}
    $expectedRole=if($TestAdmin){'postgres'}elseif($Observer){'ttv_surplus_observer'}else{'ttv_surplus_lifecycle'}
    $mode=if($TestAdmin){'TEST_ADMIN'}elseif($Observer){'OBSERVER'}else{'LIFECYCLE'}
    $secret=Read-Host "TEST $expectedRole URL to /postgres (hidden; percent-encode password characters)" -AsSecureString
    $buffer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $raw=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
    if($raw -cnotmatch '^postgres(?:ql)?://[^/?#\s]+@127\.0\.0\.1:55432/postgres$' -or
        $raw -match '[\s\\?#]' -or $raw -match '%(?![0-9a-fA-F]{2})' -or
        -not [Uri]::TryCreate($raw,[UriKind]::Absolute,[ref]$uri)){throw 'URL_REJECTED'}
    $identity=$uri.UserInfo.Split([char[]]':',2)
    if($uri.Host -cne '127.0.0.1' -or $uri.Port -ne 55432 -or $uri.AbsolutePath -cne '/postgres' -or
        $uri.Query -or $uri.Fragment -or $identity.Length -ne 2 -or
        [string]::IsNullOrEmpty($identity[1]) -or
        [Uri]::UnescapeDataString($identity[0]) -cne $expectedRole){throw 'URL_REJECTED'}
    $info=New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $info.Arguments='"'+(Join-Path $PSScriptRoot 'inspect-payment-surplus-sessions.cjs')+'"'
    $info.WorkingDirectory=Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($key in @('SYSTEMROOT','WINDIR','PATH','TEMP','TMP')){
        $value=[Environment]::GetEnvironmentVariable($key,'Process')
        if($null -ne $value){$info.EnvironmentVariables[$key]=$value}
    }
    $info.EnvironmentVariables['SURPLUS_SESSION_URL']=$raw
    $info.EnvironmentVariables['SURPLUS_SESSION_MODE']=$mode
    $child=New-Object System.Diagnostics.Process; $child.StartInfo=$info
    if(-not $child.Start()){throw 'CHILD_START_FAILED'}
    $stdoutTask=$child.StandardOutput.ReadToEndAsync(); $stderrTask=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit(30000)){
        $child.Kill();[void]$child.WaitForExit(3000);throw 'INSPECTION_TIMEOUT'
    }
    $result=$stdoutTask.GetAwaiter().GetResult()|ConvertFrom-Json -ErrorAction Stop
    [void]$stderrTask.GetAwaiter().GetResult()
    if($result.status -cnotin @('PASS','FAIL','UNKNOWN') -or $result.reason -cnotin @(
        'SESSION_SNAPSHOT_READ','OBSERVATION_INCOMPLETE','IDENTITY_MISMATCH','INVALID_METADATA',
        'INSUFFICIENT_PRIVILEGE','QUERY_OR_CONNECTION_FAILED','CONNECTION_CLOSE_FAILED',
        'CONNECTION_LOST','INSPECTION_FAILED')){throw 'INVALID_RESULT'}
    if($result.status -ceq 'PASS' -and ($child.ExitCode -ne 0 -or
        $result.reason -cne 'SESSION_SNAPSHOT_READ' -or $null -eq $result.sessions -or
        $result.otherSessions -ceq 'UNKNOWN')){throw 'INVALID_RESULT'}
    # The child already suppresses free-form application/role/database names.
    # Select only explicit metadata fields; never render raw child output.
    $output=New-Object 'System.Collections.Generic.List[string]'
    [void]$output.Add('STATUS='+$result.status+' REASON='+$result.reason)
    if($null -ne $result.sessions){
        if([string]$result.selfPid -cnotmatch '^[1-9][0-9]*$' -or
            ([string]$result.targetSessions -cne 'UNKNOWN' -and
                [string]$result.targetSessions -cnotmatch '^[0-9]+$') -or
            ([string]$result.otherSessions -cne 'UNKNOWN' -and
                [string]$result.otherSessions -cnotmatch '^[0-9]+$')){throw 'INVALID_RESULT'}
        [void]$output.Add('SELF_PID='+$result.selfPid+' TARGET_SESSIONS='+$result.targetSessions+' OTHER_SESSIONS='+$result.otherSessions)
        foreach($key in @('verifiedOtherClients','verifiedOtherBackgrounds','unclassifiedOtherBackends')){
            if([string]$result.$key -cnotmatch '^[0-9]+$'){throw 'INVALID_RESULT'}
        }
        if(($result.unclassifiedOtherBackends -gt 0 -and $result.otherSessions -cne 'UNKNOWN') -or
            ($result.status -ceq 'PASS' -and ($result.unclassifiedOtherBackends -ne 0 -or
                $result.targetSessions -ceq 'UNKNOWN'))){throw 'INVALID_RESULT'}
        [void]$output.Add('VERIFIED_OTHER_CLIENTS='+$result.verifiedOtherClients+
            ' VERIFIED_OTHER_BACKGROUNDS='+$result.verifiedOtherBackgrounds+
            ' UNCLASSIFIED_OTHER_BACKENDS='+$result.unclassifiedOtherBackends)
        foreach($row in $result.sessions){
            if([string]$row.pid -cnotmatch '^[1-9][0-9]*$' -or
                $row.kind -cnotin @('SELF','OTHER_CLIENT','BACKGROUND','UNKNOWN') -or
                $row.database_scope -cnotin @('TARGET','POSTGRES','NONE','OTHER_DATABASE') -or
                $row.observation -cnotin @('VISIBLE','UNKNOWN') -or
                $row.classification -cnotin @('SELF','VERIFIED_CLIENT','VERIFIED_BACKGROUND','UNCLASSIFIED')){throw 'INVALID_RESULT'}
            foreach($key in @('datname','usename','application_name','client_addr','backend_type',
                'state','wait_event_type','wait_event')){
                if($null -ne $row.$key -and [string]$row.$key -cnotmatch '^[A-Za-z0-9_. :()\-]{0,96}$'){
                    throw 'INVALID_RESULT'
                }
            }
            foreach($key in @('database_oid','role_oid')){
                if($null -ne $row.$key -and [string]$row.$key -cnotmatch '^[1-9][0-9]*$'){throw 'INVALID_RESULT'}
            }
            if($null -ne $row.backend_start -and [string]$row.backend_start -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'){throw 'INVALID_RESULT'}
            if($null -ne $row.backendIdentity -and $row.backendIdentity -cne ($result.cluster+'|'+$result.postmasterStart+'|'+$row.pid+'|'+$row.backend_start)){throw 'INVALID_RESULT'}
            $entry=[pscustomobject]@{pid=$row.pid;datname=$row.datname;usename=$row.usename;
                application_name=$row.application_name;client_addr=$row.client_addr;backend_type=$row.backend_type;
                state=$row.state;wait_event_type=$row.wait_event_type;wait_event=$row.wait_event;
                kind=$row.kind;classification=$row.classification;
                database_scope=$row.database_scope;observation=$row.observation;database_oid=$row.database_oid;
                role_oid=$row.role_oid;backend_start=$row.backend_start;backendIdentity=$row.backendIdentity;
                cluster=$result.cluster;postmasterStart=$result.postmasterStart;observedAt=$result.observedAt}|ConvertTo-Json -Compress -Depth 4
            [void]$output.Add($entry)
        }
    }
    $output|Write-Output
    if($result.status -cne 'PASS'){throw 'OBSERVATION_UNKNOWN_OR_FAILED'}
}
catch {throw 'READONLY_SESSION_INSPECTION_FAILED_OR_UNKNOWN'}
finally {
    if($buffer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)}
    if($null -ne $secret){$secret.Dispose()}
    if($null -ne $info){$info.EnvironmentVariables.Clear()}
    [Environment]::SetEnvironmentVariable('SURPLUS_SESSION_URL',$null,'Process')
    $raw=$null;$uri=$null;$identity=$null;$stdoutTask=$null;$stderrTask=$null
    if($null -ne $child){$child.Dispose()}
}
