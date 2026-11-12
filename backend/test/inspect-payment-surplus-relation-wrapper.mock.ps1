[CmdletBinding()]
param([string]$InspectionDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
# Extract only two helper definitions; never prompt or start the real inspector.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $InspectionDirectory 'inspect-payment-surplus-relation.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SYNTAX_FAILED'}
$definitions=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)
foreach($name in @('New-RelationInspectionProcess','New-RelationDiagnosticJson','ConvertTo-RelationSafeOutput')){
    $definition=$definitions|Where-Object Name -ceq $name
    if($null -eq $definition){throw 'MISSING_HELPER'}
    # Bind the directory explicitly when running this test as an in-memory scriptblock.
    . ([scriptblock]::Create($definition.Extent.Text.Replace('$PSScriptRoot','$InspectionDirectory')))
}
function New-MockReport {
    $ids=@('16388','16389','16390')
    $roles=@();$memberships=@();$sources=@()
    foreach($id in $ids){
        $roles+= [pscustomobject]@{oid=$id;superuser=$false;bypass_rls=$false;schema_usage=$true;table_update=$true;column_update=$true;owner_usage=$false;owner_set=$false;write_all_usage=$false;write_all_set=$false}
        foreach($target in @('10')+$ids){$same=$id -ceq $target;$memberships+=[pscustomobject]@{role_oid=$id;target_oid=$target;member=$same;usage=$same;settable=$same}}
        $sources+=[pscustomobject]@{role_oid=$id;scope='RELATION';attnum=0;grantee_oid='0';grantor_oid='10';public=$true;direct=$false;inherited=$false;settable=$false;grantable=$false}
    }
    return [pscustomobject]@{status='VERIFIED';readiness='NOT_READY';code='METADATA_VERIFIED';phase='OUTPUT_VALIDATION';identityStatus='VERIFIED';database_oid='5';snapshotMatched=$true;
        counts=[pscustomobject]@{relation=1;roles=3;columns=1;acl=1;memberships=12;rules=0;triggers=0;policies=0;sources=3};
        data=[pscustomobject]@{relation=@([pscustomobject]@{oid='12104';schema_oid='11';schema_name='pg_catalog';name='mock_relation';kind='r';owner_oid='10';default_acl=$false;rls=$false;force_rls=$false;has_rules=$false;has_triggers=$false;security_invoker=$false});
            roles=$roles;columns=@([pscustomobject]@{attnum=1;default_acl=$true});acl=@([pscustomobject]@{scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='0';grantable=$false});memberships=$memberships;rules=@();triggers=@();policies=@();sources=$sources}}
}
$passed=0;$failed=0
foreach($case in @(
    @{name='valid';valid=$true;mutate=$null;exitCode=0},
    @{name='untrusted-child-exit';valid=$false;mutate=$null;exitCode=1},
    @{name='nested-sentinel';valid=$false;mutate={param($r)$r.data.relation[0]|Add-Member NoteProperty unexpected 'SENTINEL_NO_URL'};exitCode=0},
    @{name='snapshot-mismatch';valid=$false;mutate={param($r)$r.snapshotMatched=$false};exitCode=0},
    @{name='count-mismatch';valid=$false;mutate={param($r)$r.counts.memberships=11};exitCode=0},
    @{name='null-data';valid=$false;mutate={param($r)$r.data=$null};exitCode=0},
    @{name='false-source';valid=$false;mutate={param($r)$r.data.sources[0].public=$false};exitCode=0},
    @{name='wrong-boolean';valid=$false;mutate={param($r)$r.data.roles[0].table_update='true'};exitCode=0},
    @{name='verified-without-identity';valid=$false;mutate={param($r)$r.identityStatus='UNVERIFIED'};exitCode=0},
    @{name='verified-with-untrusted-phase';valid=$false;mutate={param($r)$r.phase='SENTINEL_NO_URL'};exitCode=0}
)){
    $report=New-MockReport
    if($null -ne $case.mutate){& $case.mutate $report}
    $output=@(ConvertTo-RelationSafeOutput -Json ($report|ConvertTo-Json -Depth 12 -Compress) -InspectionExitCode $case.exitCode)
    $json=$output -join ''
    $ok=$output.Count -eq 1 -and $json -notmatch 'SENTINEL_NO_URL'
    if($case.valid){$ok=$ok -and ($json|ConvertFrom-Json).status -ceq 'VERIFIED'}
    else{$ok=$ok -and $json -ceq (New-RelationDiagnosticJson 'REPORT_VALIDATION_FAILED' 'OUTPUT_VALIDATION')}
    if($ok){$passed++;Write-Output ('PASS '+$case.name)}else{$failed++;Write-Output ('FAIL '+$case.name)}
}
$malformed=ConvertTo-RelationSafeOutput -Json 'SENTINEL_NO_URL' -InspectionExitCode 1
if(($malformed|ConvertFrom-Json).status -ceq 'UNKNOWN' -and $malformed -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output 'PASS malformed-json'}else{$failed++}
$info=New-RelationInspectionProcess -ValidateReport
if($info.Arguments.EndsWith(' --validate-report') -and -not $info.EnvironmentVariables.ContainsKey('SURPLUS_RELATION_URL') -and -not $info.EnvironmentVariables.ContainsKey('DATABASE_URL')){$passed++;Write-Output 'PASS offline-environment-isolation'}else{$failed++}
$info.EnvironmentVariables.Clear()
foreach($case in @(
    @{name='auth-diagnostic-preserved';code='AUTHENTICATION_FAILED';phase='CONNECT';identity='UNVERIFIED';state='28P01'},
    @{name='catalog-diagnostic-preserved';code='SQL_SYNTAX_ERROR';phase='INVENTORY';identity='VERIFIED';state='42601'},
    @{name='identity-diagnostic-preserved';code='IDENTITY_MISMATCH';phase='IDENTITY';identity='UNVERIFIED';state=$null}
)){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code=$case.code;phase=$case.phase;identityStatus=$case.identity}
    if($null -ne $case.state){$report.sqlstate=$case.state}
    if($case.phase -ceq 'INVENTORY'){$report.inventoryGroup='acl'}
    $json=ConvertTo-RelationSafeOutput -Json ($report|ConvertTo-Json -Compress) -InspectionExitCode 1
    $r=$json|ConvertFrom-Json
    if($r.code -ceq $case.code -and $r.phase -ceq $case.phase -and $r.identityStatus -ceq $case.identity -and $r.sqlstate -ceq $case.state -and ($case.phase -cne 'INVENTORY' -or $r.inventoryGroup -ceq 'acl')){$passed++;Write-Output ('PASS '+$case.name)}else{$failed++;Write-Output ('FAIL '+$case.name)}
}
foreach($field in @('phase','code','sqlstate')){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code='AUTHENTICATION_FAILED';phase='CONNECT';identityStatus='UNVERIFIED';sqlstate='28P01'}
    $report[$field]='SENTINEL_NO_URL'
    $json=ConvertTo-RelationSafeOutput -Json ($report|ConvertTo-Json -Compress) -InspectionExitCode 1
    if(($json|ConvertFrom-Json).code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output ('PASS untrusted-'+$field)}else{$failed++}
}

# Exercise the actual top-level try/catch/finally with a fake Process object.
# No operational child is started, no prompt is called and no socket is opened.
function Invoke-MockOperationalFailure {
    param([string]$Mode,[switch]$ValidatorOnly)
    $fakeProcess=[pscustomobject]@{StartInfo=$null;HasExited=$false;Disposed=$false;Killed=$false;
        StandardOutput=(New-Object IO.StringReader '{}');StandardError=(New-Object IO.StringReader 'SENTINEL_NO_URL');StandardInput=(New-Object IO.StringWriter)}
    if($Mode -ceq 'output-read'){
        $fakeProcess.StandardOutput=[pscustomobject]@{}
        $fakeProcess.StandardOutput|Add-Member ScriptMethod ReadToEndAsync {throw 'SENTINEL_NO_URL'}
    }
    $fakeProcess|Add-Member ScriptMethod Start {if($Mode -ceq 'startup'){throw 'SENTINEL_NO_URL'};return $true}
    $fakeProcess|Add-Member ScriptMethod WaitForExit {param($milliseconds)if($Mode -ceq 'timeout'){return $false};$this.HasExited=$true;return $true}
    $fakeProcess|Add-Member ScriptMethod Kill {$this.Killed=$true;$this.HasExited=$true}
    $fakeProcess|Add-Member ScriptMethod Dispose {$this.Disposed=$true}
    function New-Object {
        param([string]$TypeName)
        if($TypeName -ceq 'System.Diagnostics.Process'){return $fakeProcess}
        return (Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName)
    }
    function Read-SurplusSecretUrl {return 'MOCK_ONLY_NOT_A_CREDENTIAL'}
    $main=$ast.Extent.Text.Substring($ast.Extent.Text.IndexOf('$raw = $null; $info = $null; $child = $null;')).Replace('$PSScriptRoot','$InspectionDirectory')
    $output=@(& {try {if($ValidatorOnly){ConvertTo-RelationSafeOutput -Json '{}' -InspectionExitCode 0}else{& ([scriptblock]::Create($main))}}catch{if($_.Exception.Message -cne 'READONLY_RELATION_INSPECTION_UNKNOWN_OR_NOT_READY'){throw 'MOCK_UNEXPECTED_ERROR'}}})
    if($output.Count -ne 1 -or ($output -join '') -match 'SENTINEL_NO_URL|MOCK_ONLY'){throw 'MOCK_OUTPUT_UNSAFE'}
    $result=$output[0]|ConvertFrom-Json
    if(-not $fakeProcess.Disposed){throw 'MOCK_CLEANUP_FAILED'}
    if($Mode -ceq 'timeout' -and -not $fakeProcess.Killed){throw 'MOCK_CLEANUP_FAILED'}
    return $result
}
foreach($case in @(
    @{mode='startup';code='PROCESS_START_FAILED';phase='PROCESS_START'},
    @{mode='timeout';code='WRAPPER_TIMEOUT';phase='PROCESS_WAIT'},
    @{mode='output-read';code='OUTPUT_READ_FAILED';phase='OUTPUT_READ'}
)){
    $r=Invoke-MockOperationalFailure $case.mode
    if($r.code -ceq $case.code -and $r.phase -ceq $case.phase -and $r.identityStatus -ceq 'UNVERIFIED'){$passed++;Write-Output ('PASS wrapper-'+$case.mode)}else{$failed++;Write-Output ('FAIL wrapper-'+$case.mode)}
}
foreach($case in @(@{mode='startup';code='VALIDATOR_START_FAILED'},@{mode='timeout';code='VALIDATOR_TIMEOUT'})){
    $r=Invoke-MockOperationalFailure $case.mode -ValidatorOnly
    if($r.code -ceq $case.code -and $r.phase -ceq 'OUTPUT_VALIDATION' -and $r.identityStatus -ceq 'UNVERIFIED'){$passed++;Write-Output ('PASS validator-'+$case.mode)}else{$failed++;Write-Output ('FAIL validator-'+$case.mode)}
}
$json=New-RelationDiagnosticJson 'SENTINEL_NO_URL' 'SENTINEL_NO_URL'
if(($json|ConvertFrom-Json).code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output 'PASS wrapper-local-allowlist'}else{$failed++}
foreach($group in @('relation','roles','columns','acl','memberships','rules','triggers','policies')){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code='UNCLASSIFIED_DATABASE_ERROR';phase='INVENTORY';identityStatus='VERIFIED';inventoryGroup=$group}
    $json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 1
    $r=$json|ConvertFrom-Json
    if($r.inventoryGroup -ceq $group -and $r.code -ceq 'UNCLASSIFIED_DATABASE_ERROR' -and $r.identityStatus -ceq 'VERIFIED'){$passed++;Write-Output ('PASS inventory-'+$group)}else{$failed++}
}
foreach($mode in @('missing','null','unknown','wrong-phase')){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code='JAVASCRIPT_ERROR';phase='INVENTORY';identityStatus='VERIFIED';inventoryGroup='acl'}
    switch($mode){'missing'{$report.Remove('inventoryGroup')};'null'{$report.inventoryGroup=$null};'unknown'{$report.inventoryGroup='SENTINEL_NO_URL'};'wrong-phase'{$report.phase='COMPARE'}}
    $json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 1
    if(($json|ConvertFrom-Json).code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output ('PASS invalid-group-'+$mode)}else{$failed++}
}
foreach($step in @('RELATION_BRANCH','COLUMN_BRANCH','UNION_ORDERED')){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code='SQL_SYNTAX_ERROR';phase='ACL_DIAGNOSTIC';identityStatus='VERIFIED';aclStep=$step;sqlstate='42601'}
    $json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 1
    $r=$json|ConvertFrom-Json
    if($r.aclStep -ceq $step -and $r.code -ceq 'SQL_SYNTAX_ERROR'){$passed++;Write-Output ('PASS acl-step-'+$step)}else{$failed++}
}
$report=[ordered]@{status='VERIFIED';readiness='NOT_READY';code='ACL_DIAGNOSTIC_VERIFIED';phase='ACL_DIAGNOSTIC';identityStatus='VERIFIED';aclStep='UNION_ORDERED';snapshotMatched=$true}
$json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 0
if(($json|ConvertFrom-Json).code -ceq 'ACL_DIAGNOSTIC_VERIFIED'){$passed++;Write-Output 'PASS acl-diagnostic-success'}else{$failed++}
$report.aclStep='SENTINEL_NO_URL'
$json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 0
if(($json|ConvertFrom-Json).code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output 'PASS acl-untrusted-step'}else{$failed++}
$default=New-RelationInspectionProcess;$diagnostic=New-RelationInspectionProcess -AclDiagnostic
if($default.Arguments -notmatch '--acl-diagnostic' -and $diagnostic.Arguments.EndsWith(' --acl-diagnostic')){$passed++;Write-Output 'PASS acl-opt-in-only'}else{$failed++}
$default.EnvironmentVariables.Clear();$diagnostic.EnvironmentVariables.Clear()
$blocked=$false;try{[void](New-RelationInspectionProcess -AclDiagnostic -ValidateReport)}catch{$blocked=$true}
if($blocked){$passed++;Write-Output 'PASS mutually-exclusive-validator'}else{$failed++}
foreach($state in @('22023','ZZ999')){
    $report=[ordered]@{status='UNKNOWN';readiness='NOT_READY';code='INVALID_PARAMETER_VALUE';phase='ACL_DIAGNOSTIC';identityStatus='VERIFIED';aclStep='COLUMN_BRANCH';sqlstate=$state}
    $json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 1
    $r=$json|ConvertFrom-Json
    $ok=if($state -ceq '22023'){$r.code -ceq 'INVALID_PARAMETER_VALUE' -and $r.sqlstate -ceq '22023' -and $r.aclStep -ceq 'COLUMN_BRANCH'}else{$r.code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'ZZ999'}
    if($ok){$passed++;Write-Output ('PASS parameter-diagnostic-'+$state)}else{$failed++}
}
$report|Add-Member NoteProperty unexpected 'SENTINEL_NO_URL'
$json=ConvertTo-RelationSafeOutput ($report|ConvertTo-Json -Compress) 1
if(($json|ConvertFrom-Json).code -ceq 'REPORT_VALIDATION_FAILED' -and $json -notmatch 'SENTINEL_NO_URL'){$passed++;Write-Output 'PASS parameter-sentinel-blocked'}else{$failed++}
Write-Output ('MOCK_PASS='+$passed+' MOCK_FAIL='+$failed+'; offline validator only, no PostgreSQL')
if($failed){throw 'WRAPPER_MOCK_FAILED'}
