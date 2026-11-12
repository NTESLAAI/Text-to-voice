[CmdletBinding()]
param([switch]$Execute, [switch]$AcknowledgeUnverifiedOrigin, [switch]$ConfirmExclusiveAccess)
$ErrorActionPreference = 'Stop'
$secret=$null; $buffer=[IntPtr]::Zero; $raw=$null; $uri=$null; $identity=$null
$info=$null; $child=$null; $stdoutTask=$null; $stderrTask=$null; $approval=$null
try {
    $expectedApproval = 'DELETE:ttv_surplus_it_f646e091562849a38743a12b41e8ec2f:16393:2503a0a7006f4750f386396ecace600286d21a7243ce4566e0fd9005291ce5c6:ORIGIN_UNVERIFIED'
    $approval = [Environment]::GetEnvironmentVariable('PAYMENT_SURPLUS_ORPHAN_CLEANUP_APPROVAL','Process')
    if ($Execute -and ($approval -cne $expectedApproval -or
        -not $AcknowledgeUnverifiedOrigin -or -not $ConfirmExclusiveAccess)) {
        throw 'EXECUTE_NOT_APPROVED'
    }
    $secret = Read-Host 'TEST lifecycle URL to /postgres (hidden; percent-encode password characters)' -AsSecureString
    $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $raw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
    if ($raw -cnotmatch '^postgres(?:ql)?://[^/?#\s]+@127\.0\.0\.1:55432/postgres$' -or
        $raw -match '[\s\\?#]' -or $raw -match '%(?![0-9a-fA-F]{2})' -or
        -not [Uri]::TryCreate($raw,[UriKind]::Absolute,[ref]$uri)) { throw 'URL_REJECTED' }
    $identity=$uri.UserInfo.Split([char[]]':',2)
    if ($uri.Host -cne '127.0.0.1' -or $uri.Port -ne 55432 -or $uri.AbsolutePath -cne '/postgres' -or
        $uri.Query -or $uri.Fragment -or $identity.Length -ne 2 -or
        [string]::IsNullOrEmpty($identity[1]) -or
        [Uri]::UnescapeDataString($identity[0]) -cne 'ttv_surplus_lifecycle') { throw 'URL_REJECTED' }
    $info=New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $info.Arguments='"'+(Join-Path $PSScriptRoot 'cleanup-payment-surplus-orphan.cjs')+'"'
    $info.WorkingDirectory=Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($key in @('SYSTEMROOT','WINDIR','PATH','TEMP','TMP')) {
        $value=[Environment]::GetEnvironmentVariable($key,'Process')
        if($null -ne $value){$info.EnvironmentVariables[$key]=$value}
    }
    $info.EnvironmentVariables['SURPLUS_ORPHAN_URL']=$raw
    $info.EnvironmentVariables['SURPLUS_ORPHAN_MODE']='DRY-RUN'
    if($Execute){
        $info.EnvironmentVariables['SURPLUS_ORPHAN_MODE']='EXECUTE'
        $info.EnvironmentVariables['SURPLUS_ORPHAN_APPROVAL']=$approval
        $info.EnvironmentVariables['SURPLUS_ORPHAN_ACK_ORIGIN']='1'
        $info.EnvironmentVariables['SURPLUS_ORPHAN_EXCLUSIVE']='1'
    }
    $child=New-Object System.Diagnostics.Process
    $child.StartInfo=$info
    if(-not $child.Start()){throw 'CHILD_START_FAILED'}
    $stdoutTask=$child.StandardOutput.ReadToEndAsync()
    $stderrTask=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit(60000)){
        $child.Kill(); [void]$child.WaitForExit(3000)
        if($Execute){Write-Output 'DROP_OUTCOME_UNKNOWN'}else{Write-Output 'DROP_REFUSED'}
        throw 'CHILD_TIMEOUT'
    }
    $result=$stdoutTask.GetAwaiter().GetResult()|ConvertFrom-Json -ErrorAction Stop
    [void]$stderrTask.GetAwaiter().GetResult()
    if($result.status -cnotin @('DRY_RUN_REPORT','CLEANUP_PASS','DROP_REFUSED','DROP_FAILED','DROP_OUTCOME_UNKNOWN')){
        throw 'INVALID_CHILD_RESULT'
    }
    if(($result.status -ceq 'CLEANUP_PASS' -and -not $Execute) -or
        ($result.status -ceq 'DRY_RUN_REPORT' -and $Execute) -or
        ($result.status -ceq 'CLEANUP_PASS' -and $result.reason -cne 'NAME_AND_OID_ABSENT') -or
        ($result.status -ceq 'DRY_RUN_REPORT' -and $result.reason -cne 'READONLY_INSPECTION_COMPLETED') -or
        ($result.status -cin @('DRY_RUN_REPORT','CLEANUP_PASS') -and $child.ExitCode -ne 0)){
        throw 'INVALID_CHILD_RESULT'
    }
    if($result.status -ceq 'DRY_RUN_REPORT'){
        $report=$result.report
        if($null -eq $report -or $report.host -cne '127.0.0.1' -or $report.port -cne '55432' -or
            $report.cluster -cne '7703979600700924132' -or
            $report.directory -cne 'd:/text-to-voice/pg-test-cluster' -or
            $report.database -cne 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f' -or
            $report.oid -cne '16393' -or $report.owner -cne 'ttv_surplus_writer' -or
            $report.ownerOid -cne '16389' -or $report.origin -cne 'UNVERIFIED' -or
            $report.fingerprint -cne '2503a0a7006f4750f386396ecace600286d21a7243ce4566e0fd9005291ce5c6' -or
            $report.sessionStatus -cnotin @('READ_OK','UNKNOWN','INSUFFICIENT_PRIVILEGE','QUERY_FAILED','OBSERVATION_INCOMPLETE') -or
            $report.readiness -cnotin @('NOT_READY','READY_FOR_SEPARATE_APPROVAL')){throw 'INVALID_CHILD_RESULT'}
        foreach($key in @('targetSessions','otherSessions','TARGET_CLIENT_SESSIONS',
            'OTHER_CONFIRMED_CLIENT_SESSIONS','CONFIRMED_BACKGROUND','UNCLASSIFIED_BACKENDS')){
            if([string]$report.$key -cne 'UNKNOWN' -and [string]$report.$key -cnotmatch '^[0-9]+$'){
                throw 'INVALID_CHILD_RESULT'
            }
        }
        foreach($blocker in $report.blockers){
            if($blocker -cnotin @('ROLE_PRIVILEGES_MISMATCH','SESSION_STATE_UNKNOWN',
                'TARGET_HAS_SESSIONS','OTHER_CLIENT_SESSIONS_PRESENT','UNCLASSIFIED_BACKENDS_PRESENT')){throw 'INVALID_CHILD_RESULT'}
        }
        if($report.UNCLASSIFIED_BACKENDS -cne '0' -and
            ($report.readiness -cne 'NOT_READY' -or $report.otherSessions -cne 'UNKNOWN')){throw 'INVALID_CHILD_RESULT'}
        if($report.readiness -ceq 'READY_FOR_SEPARATE_APPROVAL' -and
            (@($report.blockers).Count -ne 0 -or $report.sessionStatus -cne 'READ_OK' -or
                $report.targetSessions -cne '0' -or $report.otherSessions -cne '0' -or
                $report.UNCLASSIFIED_BACKENDS -cne '0' -or $report.TARGET_CLIENT_SESSIONS -cne '0' -or
                $report.OTHER_CONFIRMED_CLIENT_SESSIONS -cne '0')){throw 'INVALID_CHILD_RESULT'}
    }
    $safeReason=if($result.reason -cin @('READONLY_INSPECTION_COMPLETED',
        'NAME_AND_OID_ABSENT','SERVER_REJECTED_DROP','DROP_NOT_CONFIRMED',
        'CLUSTER_IDENTITY_MISMATCH','DATABASE_IDENTITY_MISMATCH','MARKER_FINGERPRINT_MISMATCH',
        'ROLE_PRIVILEGES_MISMATCH','TARGET_HAS_SESSIONS','EXCLUSIVE_ACCESS_UNVERIFIED',
        'SESSION_STATE_UNKNOWN','UNCLASSIFIED_BACKENDS_PRESENT',
        'CONNECTION_LOST','INVALID_MODE','EXECUTE_NOT_APPROVED','URL_REJECTED',
        'POSTCHECK_NOT_CONFIRMED','INSUFFICIENT_PRIVILEGE','QUERY_OR_CONNECTION_FAILED',
        'CONNECTION_CLOSE_FAILED','UNEXPECTED_PROCESS_FAILURE','PRECHECK_FAILED')){
        $result.reason
    }else{'UNCLASSIFIED'}
    Write-Output ('STATUS='+$result.status+' REASON='+$safeReason+' ORIGIN=UNVERIFIED')
    if($result.status -ceq 'DRY_RUN_REPORT'){
        [pscustomobject]@{host=$report.host;port=$report.port;cluster=$report.cluster;
            directory=$report.directory;database=$report.database;oid=$report.oid;
            owner=$report.owner;ownerOid=$report.ownerOid;fingerprint=$report.fingerprint;
            targetSessions=$report.targetSessions;otherSessions=$report.otherSessions;
            TARGET_CLIENT_SESSIONS=$report.TARGET_CLIENT_SESSIONS;
            OTHER_CONFIRMED_CLIENT_SESSIONS=$report.OTHER_CONFIRMED_CLIENT_SESSIONS;
            CONFIRMED_BACKGROUND=$report.CONFIRMED_BACKGROUND;UNCLASSIFIED_BACKENDS=$report.UNCLASSIFIED_BACKENDS;
            sessionStatus=$report.sessionStatus;readiness=$report.readiness;
            blockers=@($report.blockers)}|ConvertTo-Json -Compress
        Write-Output 'PENDING=SEPARATE_EXECUTE_APPROVAL_REQUIRED,UNVERIFIED_ORIGIN_ACK_REQUIRED,OPERATOR_EXCLUSIVITY_CONFIRMATION_REQUIRED'
    }
    if($result.status -cnotin @('DRY_RUN_REPORT','CLEANUP_PASS')){throw 'CLEANUP_NOT_PASS'}
}
catch { throw 'ORPHAN_CLEANUP_REFUSED_FAILED_OR_UNKNOWN' }
finally {
    if($buffer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)}
    if($null -ne $secret){$secret.Dispose()}
    if($null -ne $info){$info.EnvironmentVariables.Clear()}
    [Environment]::SetEnvironmentVariable('SURPLUS_ORPHAN_URL',$null,'Process')
    [Environment]::SetEnvironmentVariable('PAYMENT_SURPLUS_ORPHAN_CLEANUP_APPROVAL',$null,'Process')
    $raw=$null; $uri=$null; $identity=$null; $approval=$null
    $stdoutTask=$null; $stderrTask=$null
    if($null -ne $child){$child.Dispose()}
}
