[CmdletBinding()]
param([string]$InspectionDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
# Parse/extract validator definitions only. Never dot-source the operational wrapper.
$path=Join-Path $InspectionDirectory 'inspect-payment-surplus-metadata.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'WRAPPER_SYNTAX_FAILED'}
$definitions=$ast.FindAll({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)
foreach($name in @('Copy-SurplusReportValue','Get-SurplusReportSchemas','Get-SurplusWriteClassification','Assert-SurplusReportConsistency','ConvertTo-SurplusValidatedReportJson')){
    $definition=$definitions|Where-Object Name -ceq $name
    if($null -eq $definition){throw 'MISSING_VALIDATOR'}
    . ([scriptblock]::Create($definition.Extent.Text))
}
function New-ValidAclReport {
    $schemas=Get-SurplusReportSchemas
    $roots=@('200','201','202')
    $counts=[ordered]@{roles=3;functions=9;databases=3;schemas=3;memberships=12;edges=0;relations=3;sequences=0;definers=0}
    $ids=@{roles=@();functions=@('1000','1001','1002');databases=@('5');schemas=@('11');memberships=@('10')+$roots;edges=@();relations=@('12');sequences=@();definers=@()}
    $objects=[ordered]@{}
    foreach($category in $schemas.groups.Keys){
        $list=New-Object 'System.Collections.Generic.List[object]'
        foreach($root in $roots){
            $objectIds=if($category -ceq 'roles'){@($root)}else{$ids[$category]}
            foreach($id in $objectIds){
                $row=[ordered]@{objectType=$schemas.groups[$category][0]}
                foreach($key in $schemas.groups[$category][1].Split(' ')){$row[$key]=switch($key){'role_oid'{$root};'object_oid'{$id};'schema_oid'{'11'};default{'10'}}}
                foreach($key in $schemas.groups[$category][2].Split(' ')){$row[$key]=$false}
                if($category -ceq 'roles'){$row.login=$true;$row.inherit=$true;$row.create_database=$root -ceq '200'}
                if($category -ceq 'memberships' -and $root -ceq $id){$row.member=$true;$row.usage=$true;$row.settable=$true}
                [void]$list.Add([pscustomobject]$row)
            }
        }
        $objects[$category]=$list.ToArray()
    }
    return ([pscustomobject]@{verification='VERIFIED';readiness='NOT_READY';code='ACL_READ_VERIFIED';blockers=@('EXCLUSIVE_OPERATION_NOT_CONFIRMED');warnings=@();
        checks=[pscustomobject]@{status='VERIFIED';database_oid='5';snapshotMatched=$true;counts=[pscustomobject]$counts;objects=[pscustomobject]$objects;
            evidence=[pscustomobject]@{transaction=[pscustomobject]@{owner='METADATA_CLIENT';isolation='repeatable read';readOnly=$true;sameSnapshot=$true};database_oid='5';
                identity=[pscustomobject]@{object_oid='12';schema_oid='11';schema_name='pg_catalog';relation_name='pg_settings';relkind='v';owner_oid='10'};
                counts=[pscustomobject]@{grants=0;paths=0;roles=3};grants=@();paths=@();roles=@($roots|ForEach-Object {[pscustomobject]@{role_oid=$_;write_all_usage=$false;write_all_set=$false}})}};
        blockingDatabaseOids=@();sessionCheck=[pscustomobject]@{status='VERIFIED';otherClients=0;backgrounds=0;unclassified=0}}|
        ConvertTo-Json -Depth 16|ConvertFrom-Json)
}
$results=@{passed=0;failed=0}
function Invoke-ValidationCase {
    param([string]$Name,[scriptblock]$Mutate,[bool]$Valid=$false,[int]$ExitCode=0)
    $report=New-ValidAclReport
    if($null -ne $Mutate){& $Mutate $report}
    $captured=@(ConvertTo-SurplusValidatedReportJson $report -Acl -ChildExitCode $ExitCode)
    $ok=$captured.Count -eq 1
    $json=$captured -join ''
    if($Valid){$ok=$ok -and (($json|ConvertFrom-Json).verification -ceq 'VERIFIED')}
    else{$ok=$ok -and $json -ceq '{"verification":"UNKNOWN","readiness":"NOT_READY","code":"REPORT_VALIDATION_FAILED"}'}
    $ok=$ok -and $json -notmatch 'AUDIT_SENTINEL|UNTRUSTED_VALUE'
    if($ok){$results.passed++;Write-Output ('PASS '+$Name)}else{$results.failed++;Write-Output ('FAIL '+$Name)}
}
Invoke-ValidationCase 'valid-report' $null $true
Invoke-ValidationCase 'top-sentinel' {param($r)$r|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'nested-sentinel' {param($r)$r.checks|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'row-sentinel' {param($r)$r.checks.objects.roles[0]|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'session-sentinel' {param($r)$r.sessionCheck|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'null-checks' {param($r)$r.checks=$null}
Invoke-ValidationCase 'missing-checks' {param($r)$r.PSObject.Properties.Remove('checks')}
Invoke-ValidationCase 'numeric-oid' {param($r)$r.checks.database_oid=5}
Invoke-ValidationCase 'oid-overflow' {param($r)$r.checks.database_oid='4294967296'}
Invoke-ValidationCase 'string-boolean' {param($r)$r.checks.objects.roles[0].login='true'}
Invoke-ValidationCase 'bad-status' {param($r)$r.checks.status='PASS'}
Invoke-ValidationCase 'null-check-status' {param($r)$r.checks.status=$null}
Invoke-ValidationCase 'bad-top-status' {param($r)$r.verification='PASS'}
Invoke-ValidationCase 'count-mismatch' {param($r)$r.checks.counts.functions=8}
Invoke-ValidationCase 'string-count' {param($r)$r.checks.counts.functions='9'}
Invoke-ValidationCase 'float-count' {param($r)$r.checks.counts.functions=[double]9}
Invoke-ValidationCase 'negative-count' {param($r)$r.checks.counts.edges=-1}
Invoke-ValidationCase 'snapshot-false' {param($r)$r.checks.snapshotMatched=$false}
Invoke-ValidationCase 'snapshot-string' {param($r)$r.checks.snapshotMatched='true'}
Invoke-ValidationCase 'missing-session' {param($r)$r.PSObject.Properties.Remove('sessionCheck')}
Invoke-ValidationCase 'null-session' {param($r)$r.sessionCheck=$null}
Invoke-ValidationCase 'session-unknown-with-verified' {param($r)$r.sessionCheck.status='UNKNOWN'}
Invoke-ValidationCase 'session-null-count' {param($r)$r.sessionCheck.backgrounds=$null}
Invoke-ValidationCase 'session-unclassified' {param($r)$r.sessionCheck.unclassified=1}
Invoke-ValidationCase 'bad-session-status' {param($r)$r.sessionCheck.status='PASS'}
Invoke-ValidationCase 'string-session-count' {param($r)$r.sessionCheck.otherClients='0'}
Invoke-ValidationCase 'unknown-count-field' {param($r)$r.checks.counts|Add-Member NoteProperty unexpected 0}
Invoke-ValidationCase 'unknown-object-category' {param($r)$r.checks.objects|Add-Member NoteProperty unexpected @()}
Invoke-ValidationCase 'duplicate-object' {param($r)$r.checks.objects.functions[1]=$r.checks.objects.functions[0]}
Invoke-ValidationCase 'unknown-root' {param($r)$r.checks.objects.functions[0].role_oid='999'}
Invoke-ValidationCase 'database-scope' {param($r)$r.checks.objects.databases[0].object_oid='6'}
Invoke-ValidationCase 'missing-blocker' {param($r)$r.blockers=@()}
Invoke-ValidationCase 'unknown-blocker' {param($r)$r.blockers+=@('UNTRUSTED_VALUE')}
Invoke-ValidationCase 'incorrect-child-exit' $null $false 1
Invoke-ValidationCase 'missing-required-row-field' {param($r)$r.checks.objects.roles[0].PSObject.Properties.Remove('login')}
Invoke-ValidationCase 'wrong-object-type' {param($r)$r.checks.objects.roles[0].objectType='FUNCTION'}
Invoke-ValidationCase 'missing-temp-blocker' {param($r)$r.checks.objects.databases[0].effective_temp=$true}
Invoke-ValidationCase 'missing-write-blocker' {param($r)$r.checks.objects.relations[0].column_update=$true}
Invoke-ValidationCase 'valid-positive-finding' {param($r)$r.checks.objects.relations[0].table_delete=$true;$r.blockers+=@('ACL_WRITE_CAPABILITIES_PRESENT')} $true
Invoke-ValidationCase 'unsafe-diagnostic-field' {param($r)$r|Add-Member NoteProperty phase 'URL_VALIDATION';$r|Add-Member NoteProperty fields @('AUDIT_SENTINEL')}
Invoke-ValidationCase 'evidence-missing' {param($r)$r.checks.PSObject.Properties.Remove('evidence')}
Invoke-ValidationCase 'evidence-null' {param($r)$r.checks.evidence=$null}
Invoke-ValidationCase 'evidence-unknown-field' {param($r)$r.checks.evidence|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'evidence-wrong-isolation' {param($r)$r.checks.evidence.transaction.isolation='read committed'}
Invoke-ValidationCase 'evidence-read-write' {param($r)$r.checks.evidence.transaction.readOnly=$false}
Invoke-ValidationCase 'evidence-snapshot-mismatch' {param($r)$r.checks.evidence.transaction.sameSnapshot=$false}
Invoke-ValidationCase 'evidence-database-mismatch' {param($r)$r.checks.evidence.database_oid='99'}
Invoke-ValidationCase 'evidence-target-mismatch' {param($r)$r.checks.evidence.identity.object_oid='99'}
Invoke-ValidationCase 'evidence-owner-mismatch' {param($r)$r.checks.evidence.identity.owner_oid='99'}
Invoke-ValidationCase 'evidence-count-mismatch' {param($r)$r.checks.evidence.counts.paths=1}
Invoke-ValidationCase 'evidence-role-mismatch' {param($r)$r.checks.evidence.roles[0].role_oid='99'}
Invoke-ValidationCase 'evidence-wrong-schema' {param($r)$r.checks.evidence.identity.schema_name='public'}
Invoke-ValidationCase 'evidence-wrong-name' {param($r)$r.checks.evidence.identity.relation_name='other'}
Invoke-ValidationCase 'evidence-wrong-kind' {param($r)$r.checks.evidence.identity.relkind='r'}
function Add-MockPublicEvidence {
    param($r)
    $e=$r.checks.evidence
    $e.grants=@([pscustomobject]@{scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='0';grantable=$false})
    $e.paths=@($e.roles|ForEach-Object {[pscustomobject]@{role_oid=$_.role_oid;scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='0';grantable=$false;public=$true;direct=$false;inherited=$false;settable=$false}})
    $e.counts.grants=1;$e.counts.paths=3
    foreach($target in $r.checks.objects.relations){$target.table_update=$true;$target.column_update=$true}
    $r.blockers+=@('ACL_WRITE_CAPABILITIES_PRESENT')
}
Invoke-ValidationCase 'evidence-valid-PUBLIC-keeps-blocker' {param($r)Add-MockPublicEvidence $r} $true
Invoke-ValidationCase 'evidence-public-not-warning' {param($r)Add-MockPublicEvidence $r;$r.blockers=@('EXCLUSIVE_OPERATION_NOT_CONFIRMED')}
Invoke-ValidationCase 'evidence-path-sentinel' {param($r)Add-MockPublicEvidence $r;$r.checks.evidence.paths[0]|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'evidence-false-direct' {param($r)Add-MockPublicEvidence $r;$r.checks.evidence.paths[0].direct=$true}
Invoke-ValidationCase 'evidence-false-grant-option' {param($r)Add-MockPublicEvidence $r;$r.checks.evidence.paths[0].grantable=$true}
Invoke-ValidationCase 'evidence-duplicate-path' {param($r)Add-MockPublicEvidence $r;$r.checks.evidence.paths[1]=$r.checks.evidence.paths[0]}
Invoke-ValidationCase 'evidence-unknown-source' {param($r)Add-MockPublicEvidence $r;$r.checks.evidence.grants[0].grantee_oid='999'}
function Add-MockSettingsWarning {
    param($r)
    Add-MockPublicEvidence $r
    $e=$r.checks.evidence
    $e.grants+=@([pscustomobject]@{scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='10';grantable=$false})
    $e.paths+=@($e.roles|ForEach-Object {[pscustomobject]@{role_oid=$_.role_oid;scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='10';grantable=$false;public=$false;direct=$false;inherited=$false;settable=$false}})
    $e.counts.grants=2;$e.counts.paths=6
    foreach($target in $r.checks.objects.relations){$target.default_acl=$false;$target.schema_usage=$true}
    $r.blockers=@($r.blockers|Where-Object {$_ -cne 'ACL_WRITE_CAPABILITIES_PRESENT'})
    $r.warnings=@([pscustomobject]@{code='PG_SETTINGS_DEFAULT_PUBLIC_UPDATE';database_oid='5';object_oid='12';role_oids=@('200','201','202')})
}
function Restore-MockWriteBlocker {
    param($r)
    $r.warnings=@();$r.blockers+=@('ACL_WRITE_CAPABILITIES_PRESENT')
}
function Add-MockAdditionalGrant {
    param($r)
    $e=$r.checks.evidence
    $e.grants+=@([pscustomobject]@{scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='201';grantable=$false})
    $e.paths+=@($e.roles|ForEach-Object {[pscustomobject]@{role_oid=$_.role_oid;scope='RELATION';attnum=0;grantor_oid='10';grantee_oid='201';grantable=$false;public=$false;direct=($_.role_oid -ceq '201');inherited=$false;settable=($_.role_oid -ceq '201')}})
    $e.counts.grants=3;$e.counts.paths=9
}
Invoke-ValidationCase 'warning-valid-default-system-view' {param($r)Add-MockSettingsWarning $r} $true
Invoke-ValidationCase 'warning-required-when-eligible' {param($r)Add-MockSettingsWarning $r;$r.warnings=@()}
Invoke-ValidationCase 'warning-unknown-field' {param($r)Add-MockSettingsWarning $r;$r.warnings[0]|Add-Member NoteProperty extra 'AUDIT_SENTINEL'}
Invoke-ValidationCase 'warning-unknown-code' {param($r)Add-MockSettingsWarning $r;$r.warnings[0].code='AUDIT_SENTINEL'}
Invoke-ValidationCase 'warning-wrong-object' {param($r)Add-MockSettingsWarning $r;$r.warnings[0].object_oid='999'}
Invoke-ValidationCase 'warning-wrong-role' {param($r)Add-MockSettingsWarning $r;$r.warnings[0].role_oids[0]='999'}
Invoke-ValidationCase 'warning-duplicate' {param($r)Add-MockSettingsWarning $r;$r.warnings+=@($r.warnings[0])}
Invoke-ValidationCase 'warning-missing-proof' {param($r)Add-MockSettingsWarning $r;$r.checks.evidence=$null}
Invoke-ValidationCase 'warning-count-mismatch' {param($r)Add-MockSettingsWarning $r;$r.checks.counts.relations++}
Invoke-ValidationCase 'warning-no-READY' {param($r)Add-MockSettingsWarning $r;$r.readiness='READY'}
Invoke-ValidationCase 'warning-does-not-hide-extra-grant' {param($r)Add-MockSettingsWarning $r;Add-MockAdditionalGrant $r}
Invoke-ValidationCase 'extra-grant-stays-blocked' {param($r)Add-MockSettingsWarning $r;Add-MockAdditionalGrant $r;Restore-MockWriteBlocker $r} $true
Invoke-ValidationCase 'warning-does-not-hide-wide-SET' {param($r)Add-MockSettingsWarning $r;$r.checks.evidence.roles[0].write_all_set=$true}
Invoke-ValidationCase 'wide-SET-stays-blocked' {param($r)Add-MockSettingsWarning $r;$r.checks.evidence.roles[0].write_all_set=$true;Restore-MockWriteBlocker $r} $true
foreach($capability in @('table_insert','table_delete','table_truncate','table_references','table_trigger','table_maintain','column_insert')){
    $change={param($r)Add-MockSettingsWarning $r;$r.checks.objects.relations[0].$capability=$true;Restore-MockWriteBlocker $r}
    Invoke-ValidationCase ('other-write-still-blocked-'+$capability) $change $true
}
Invoke-ValidationCase 'application-update-keeps-blocker-and-warning' {param($r)
    Add-MockSettingsWarning $r
    $extra=@($r.checks.objects.relations|ForEach-Object {$clone=$_|ConvertTo-Json|ConvertFrom-Json;$clone.object_oid='999';$clone.schema_oid='2200';$clone})
    $r.checks.objects.relations+=$extra;$r.checks.counts.relations=6;$r.blockers+=@('ACL_WRITE_CAPABILITIES_PRESENT')
} $true
foreach($capability in @('effective_usage','effective_update','owner_usage','owner_set')){
    $change={param($r)
        Add-MockSettingsWarning $r
        $r.checks.objects.sequences=@($r.checks.objects.roles|ForEach-Object {[pscustomobject]@{objectType='SEQUENCE';role_oid=$_.role_oid;object_oid='900';owner_oid='10';schema_oid='11';default_acl=$true;effective_usage=$false;effective_update=$false;owner_usage=$false;owner_set=$false}})
        $r.checks.objects.sequences[0].$capability=$true;$r.checks.counts.sequences=3;$r.blockers+=@('ACL_WRITE_CAPABILITIES_PRESENT')
    }
    Invoke-ValidationCase ('sequence-keeps-blocker-'+$capability) $change $true
}

# Known UNKNOWN shapes may be rendered but never upgraded to VERIFIED.
$unknown=New-ValidAclReport;$unknown.verification='UNKNOWN';$unknown.code='ACL_CATALOG_QUERY_FAILED';$unknown.checks=$null
$unknown.sessionCheck=[pscustomobject]@{status='UNKNOWN';otherClients=$null;backgrounds=$null;unclassified=$null}
$unknown.blockers+=@('SESSION_OR_IDENTITY_UNVERIFIED');$unknown|Add-Member NoteProperty sqlstate '42501'
$json=ConvertTo-SurplusValidatedReportJson $unknown -Acl -ChildExitCode 1
if(($json|ConvertFrom-Json).code -ceq 'ACL_CATALOG_QUERY_FAILED'){$results.passed++;Write-Output 'PASS valid-unknown'}else{$results.failed++;Write-Output 'FAIL valid-unknown'}
function New-ValidDefaultReport {
    $rights=[pscustomobject]@{MEMBER=$false;USAGE=$false;SET=$false}
    $roles=@();$i=200
    foreach($name in @('ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader')){
        $roles+= [pscustomobject]@{name=$name;oid=[string]$i;login=$true;createDb=($i -eq 200);superuser=$false;createRole=$false;replication=$false;bypassRls=$false;inherit=$true;fullStatsEffective=$false;
            observationRights=[pscustomobject]@{pg_read_all_stats=$rights;pg_monitor=$rights;pg_read_all_settings=$rights}}
        $i++
    }
    $time='2026-11-04T00:00:00.123456Z'
    $session=[pscustomobject]@{pid='100';database_oid='5';role_oid='200';backend_start=$time;
        backendIdentity=('7703979600700924132|'+$time+'|100|'+$time);datname='postgres';usename='ttv_surplus_lifecycle';application_name='ttv-surplus-session-inspection';
        client_addr='127.0.0.1';backend_type='client backend';state='active';wait_event_type=$null;wait_event=$null;kind='SELF';classification='SELF';database_scope='POSTGRES';observation='VISIBLE'}
    return ([pscustomobject]@{verification='VERIFIED';readiness='NOT_READY';reason='SESSION_SNAPSHOT_READ';blockers=@('EXCLUSIVE_OPERATION_NOT_CONFIRMED');
        metadata=[pscustomobject]@{databases=@([pscustomobject]@{name='postgres';oid='5';owner='postgres';ownerOid='10';aclSource='DEFAULT';writerCreate=$false;readerCreate=$false;markerFormat='ABSENT';markerSha256=$null});acl=@();orphan='ABSENT_AT_SNAPSHOT';origin='UNVERIFIED';roles=$roles};
        sessions=[pscustomobject]@{status='PASS';reason='SESSION_SNAPSHOT_READ';selfPid='100';cluster='7703979600700924132';postmasterStart=$time;observedAt=$time;targetSessions=0;otherSessions=0;verifiedOtherClients=0;verifiedOtherBackgrounds=0;unclassifiedOtherBackends=0;sessions=@($session)}}|ConvertTo-Json -Depth 16|ConvertFrom-Json)
}
function Invoke-DefaultCase {
    param([string]$Name,[scriptblock]$Mutate,[bool]$Valid=$false)
    $report=New-ValidDefaultReport
    if($null -ne $Mutate){& $Mutate $report}
    $output=@(ConvertTo-SurplusValidatedReportJson $report)
    $json=$output -join ''
    $ok=$output.Count -eq 1 -and $json -notmatch 'AUDIT_SENTINEL'
    if($Valid){$ok=$ok -and ($json|ConvertFrom-Json).verification -ceq 'VERIFIED'}
    else{$ok=$ok -and $json -ceq '{"verification":"UNKNOWN","readiness":"NOT_READY","code":"REPORT_VALIDATION_FAILED"}'}
    if($ok){$results.passed++;Write-Output ('PASS '+$Name)}else{$results.failed++;Write-Output ('FAIL '+$Name)}
}
Invoke-DefaultCase 'default-valid' $null $true
Invoke-DefaultCase 'default-nested-sentinel' {param($r)$r.metadata.roles[0].observationRights.pg_monitor|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-DefaultCase 'default-session-sentinel' {param($r)$r.sessions.sessions[0]|Add-Member NoteProperty unexpected 'AUDIT_SENTINEL'}
Invoke-DefaultCase 'default-count-mismatch' {param($r)$r.sessions.verifiedOtherClients=1}
Invoke-DefaultCase 'default-other-count-mismatch' {param($r)$r.sessions.otherSessions=1}
Invoke-DefaultCase 'default-target-count-mismatch' {param($r)$r.sessions.targetSessions=1}
Invoke-DefaultCase 'default-null-metadata' {param($r)$r.metadata=$null}
Invoke-DefaultCase 'default-null-sessions' {param($r)$r.sessions=$null}
Invoke-DefaultCase 'default-bad-backend-identity' {param($r)$r.sessions.sessions[0].backendIdentity='AUDIT_SENTINEL'}
Invoke-DefaultCase 'default-duplicate-pid' {param($r)$r.sessions.sessions+=@($r.sessions.sessions[0])}
Invoke-DefaultCase 'default-classification-mismatch' {param($r)$r.sessions.sessions[0].kind='BACKGROUND'}
Invoke-DefaultCase 'default-invalid-nested-boolean' {param($r)$r.metadata.roles[0].observationRights.pg_monitor.SET='true'}
Write-Output ('MOCK_PASS='+$results.passed+' MOCK_FAIL='+$results.failed+'; definitions only, no child process or database')
if($results.failed){throw 'WRAPPER_MOCK_FAILED'}
