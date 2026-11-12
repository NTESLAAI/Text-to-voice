[CmdletBinding()]
param([switch]$Acl)
$ErrorActionPreference = 'Stop'
# Dot-sourcing this existing script defines the hidden prompt; it never starts a harness.
. (Join-Path $PSScriptRoot 'run-payment-surplus-secure.ps1')

function Copy-SurplusReportValue {
    param($Value, $Schema)
    if($Schema -is [string]) {
        $valid=$false
        if($Schema -ceq 'bool'){$valid=$Value -is [bool]}
        elseif($Schema -ceq 'count'){$valid=($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 -and $Value -le 9007199254740991}
        elseif($Schema -ceq 'oid'){$parsed=[uint64]0;$valid=$Value -is [string] -and $Value -cmatch '^[1-9][0-9]*$' -and [uint64]::TryParse($Value,[ref]$parsed) -and $parsed -le 4294967295}
        elseif($Schema -ceq 'pid'){$valid=$Value -is [string] -and $Value -cmatch '^[1-9][0-9]*$'}
        elseif($Schema -ceq 'timestamp'){$valid=$Value -is [string] -and $Value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'}
        elseif($Schema -ceq 'sha'){$valid=$Value -is [string] -and $Value -cmatch '^[a-f0-9]{64}$'}
        elseif($Schema -ceq 'sqlstate'){$valid=$Value -is [string] -and $Value -cmatch '^[0-9A-Z]{5}$'}
        elseif($Schema -ceq 'database'){$valid=$Value -is [string] -and ($Value -cin @('postgres','template0','template1','text_to_voice','text_to_voice_test','OTHER_DATABASE_REDACTED') -or $Value -cmatch '^ttv_surplus_it_[a-f0-9]{32}$')}
        elseif($Schema -ceq 'ip'){$ip=$null;$valid=$Value -is [string] -and ($Value -ceq 'UNKNOWN' -or [Net.IPAddress]::TryParse($Value,[ref]$ip))}
        elseif($Schema -ceq 'event'){$valid=$Value -is [string] -and $Value -cmatch '^[A-Za-z][A-Za-z0-9_]{0,62}$'}
        elseif($Schema -ceq 'aclOid'){
            if($Value -is [string] -and $Value -ceq '0'){return $Value}
            return Copy-SurplusReportValue $Value 'oid'
        }
        elseif($Schema -ceq 'aclRole'){$valid=$Value -is [string] -and $Value -cin @('PUBLIC','postgres','ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader','OTHER_ROLE_REDACTED')}
        elseif($Schema -ceq 'countOrUnknown'){
            if($Value -is [string] -and $Value -ceq 'UNKNOWN'){return $Value}
            return Copy-SurplusReportValue $Value 'count'
        }
        elseif($Schema -ceq 'backendKey'){$valid=$Value -is [string] -and $Value -cmatch '^7703979600700924132\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[1-9][0-9]*\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'}
        elseif($Schema.StartsWith('enum:')){$valid=$Value -is [string] -and $Value -cin $Schema.Substring(5).Split('|')}
        if(-not $valid){throw 'REPORT_VALIDATION_FAILED'}
        return $Value
    }
    if($Schema.ContainsKey('nullable')) {
        if($null -eq $Value){return $null}
        return Copy-SurplusReportValue $Value $Schema.nullable
    }
    if($Schema.ContainsKey('array')) {
        if($Value -isnot [array]){throw 'REPORT_VALIDATION_FAILED'}
        $items=New-Object 'System.Collections.Generic.List[object]'
        foreach($item in $Value){[void]$items.Add((Copy-SurplusReportValue $item $Schema.array))}
        return ,$items.ToArray()
    }
    if($Value -isnot [pscustomobject]){throw 'REPORT_VALIDATION_FAILED'}
    $copy=[ordered]@{}
    foreach($property in $Value.PSObject.Properties){
        if($property.Name -cnotin @($Schema.fields.Keys)){throw 'REPORT_VALIDATION_FAILED'}
    }
    foreach($key in $Schema.fields.Keys){
        if($key -cnotin @($Value.PSObject.Properties.Name)){
            if($key -cnotin @($Schema.optional)){throw 'REPORT_VALIDATION_FAILED'}
            continue
        }
        $copy[$key]=Copy-SurplusReportValue $Value.$key $Schema.fields[$key]
    }
    return [pscustomobject]$copy
}

function Get-SurplusReportSchemas {
    $diagnostics='enum:mode|url_format|url_encoding|host|port|database|username|credential_presence|identity_row|current_user|session_user|admin_attribute|server_address|server_port|cluster_id|data_directory|session_read_only|transaction_read_only|backend_pid|connection_state'
    $reasons='enum:IDENTITY_MISMATCH|INVALID_METADATA|INSUFFICIENT_PRIVILEGE|QUERY_OR_CONNECTION_FAILED|CONNECTION_CLOSE_FAILED|CONNECTION_LOST|OBSERVATION_INCOMPLETE|INSPECTION_FAILED|SESSION_SNAPSHOT_READ'
    $blocker='enum:EXCLUSIVE_OPERATION_NOT_CONFIRMED|METADATA_UNVERIFIED|SESSION_OR_IDENTITY_UNVERIFIED|OTHER_CLIENT_SESSIONS_PRESENT|UNCLASSIFIED_BACKENDS_PRESENT|TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE|ORPHAN_IDENTITY_UNVERIFIED|ROLE_ATTRIBUTES_UNSAFE|ACL_TEMP_PRIVILEGE_PRESENT|ACL_SCHEMA_CREATE_OR_OWNERSHIP_PRESENT|ACL_WRITE_CAPABILITIES_PRESENT|PUBLIC_SECURITY_DEFINER_REVIEW_REQUIRED'
    $groups=[ordered]@{
        roles=@('ROLE','role_oid','login inherit superuser create_database create_role replication bypass_rls stats_member stats_usage stats_set settings_usage')
        functions=@('FUNCTION','role_oid object_oid owner_oid schema_oid','default_acl effective_execute schema_usage public_execute')
        databases=@('DATABASE','role_oid object_oid owner_oid','default_acl effective_connect effective_create effective_temp public_connect public_create public_temp owner_usage owner_set')
        schemas=@('SCHEMA','role_oid object_oid owner_oid','default_acl effective_usage effective_create public_usage public_create owner_usage owner_set')
        memberships=@('ROLE_MEMBERSHIP','role_oid object_oid','member usage settable')
        edges=@('MEMBERSHIP_EDGE','role_oid object_oid grantor_oid','admin inherit settable')
        relations=@('RELATION','role_oid object_oid owner_oid schema_oid','default_acl owner_usage owner_set schema_usage table_insert table_update table_delete table_truncate table_references table_trigger table_maintain column_insert column_update')
        sequences=@('SEQUENCE','role_oid object_oid owner_oid schema_oid','default_acl effective_usage effective_update owner_usage owner_set')
        definers=@('SECURITY_DEFINER','role_oid object_oid owner_oid schema_oid','default_acl effective_execute schema_usage public_execute')
    }
    $objectFields=@{};$countFields=@{}
    foreach($key in $groups.Keys){
        $definition=$groups[$key];$fields=@{objectType=('enum:'+$definition[0])}
        foreach($name in $definition[1].Split(' ')){$fields[$name]='oid'}
        foreach($name in $definition[2].Split(' ')){$fields[$name]='bool'}
        $objectFields[$key]=@{array=@{fields=$fields}};$countFields[$key]='count'
    }
    $grant=@{fields=@{scope='enum:RELATION|COLUMN';attnum='count';grantor_oid='oid';grantee_oid='aclOid';grantable='bool'}}
    $pathFields=@{role_oid='oid';scope='enum:RELATION|COLUMN';attnum='count';grantor_oid='oid';grantee_oid='aclOid';grantable='bool';public='bool';direct='bool';inherited='bool';settable='bool'}
    $evidence=@{fields=@{transaction=@{fields=@{owner='enum:METADATA_CLIENT';isolation='enum:repeatable read';readOnly='bool';sameSnapshot='bool'}};
        database_oid='oid';identity=@{fields=@{object_oid='oid';schema_oid='oid';schema_name='enum:pg_catalog';relation_name='enum:pg_settings';relkind='enum:v';owner_oid='oid'}};
        counts=@{fields=@{grants='count';paths='count';roles='count'}};grants=@{array=$grant};paths=@{array=@{fields=$pathFields}};
        roles=@{array=@{fields=@{role_oid='oid';write_all_usage='bool';write_all_set='bool'}}}}}
    $checks=@{fields=@{status='enum:VERIFIED';database_oid='oid';snapshotMatched='bool';counts=@{fields=$countFields};objects=@{fields=$objectFields};evidence=$evidence}}
    $sessionCheck=@{fields=@{status='enum:VERIFIED|UNKNOWN';otherClients=@{nullable='count'};backgrounds=@{nullable='count'};unclassified=@{nullable='count'}}}
    $acl=@{fields=@{verification='enum:VERIFIED|UNKNOWN';readiness='enum:NOT_READY';
        code='enum:ACL_TRANSACTION_INVALID|ACL_EVIDENCE_INVALID|ACL_READ_VERIFIED|ACL_INCOMPLETE_RESULT|ACL_ROLE_OID_MISMATCH|ACL_FUNCTION_UNRESOLVED|ACL_SNAPSHOT_CHANGED|ACL_SCOPE_MISMATCH|ACL_CATALOG_QUERY_FAILED|IDENTITY_MISMATCH|INVALID_METADATA|INSUFFICIENT_PRIVILEGE|QUERY_OR_CONNECTION_FAILED|CONNECTION_CLOSE_FAILED|CONNECTION_LOST|OBSERVATION_INCOMPLETE|INSPECTION_FAILED';
        sqlstate='sqlstate';phase='enum:URL_VALIDATION|SERVER_IDENTITY';fields=@{array=$diagnostics};blockers=@{array=$blocker};checks=@{nullable=$checks};
        warnings=@{array=@{fields=@{code='enum:PG_SETTINGS_DEFAULT_PUBLIC_UPDATE';database_oid='enum:5';object_oid='oid';role_oids=@{array='oid'}}}};
        blockingDatabaseOids=@{array='oid'};sessionCheck=$sessionCheck};optional=@('sqlstate','phase','fields')}

    $role='enum:postgres|ttv_surplus_lifecycle|ttv_surplus_writer|ttv_surplus_reader|OTHER_ROLE_REDACTED'
    $rights=@{fields=@{MEMBER='bool';USAGE='bool';SET='bool'}}
    $roleRow=@{fields=@{name=$role;oid='oid';login='bool';createDb='bool';superuser='bool';createRole='bool';replication='bool';bypassRls='bool';inherit='bool';fullStatsEffective='bool';
        observationRights=@{fields=@{pg_read_all_stats=$rights;pg_monitor=$rights;pg_read_all_settings=$rights}}}}
    $dbRow=@{fields=@{name='database';oid='oid';owner=$role;ownerOid='oid';aclSource='enum:DEFAULT|EXPLICIT';writerCreate='bool';readerCreate='bool';markerFormat='enum:ABSENT|HARNESS_FORMAT|OTHER';markerSha256=@{nullable='sha'}}}
    $aclRow=@{fields=@{databaseOid='oid';grantorOid='oid';grantor=$role;granteeOid='enum:0';grantee='enum:PUBLIC';privilege='enum:CREATE|CONNECT|TEMPORARY';grantable='bool'}}
    # The grantee may also be a non-PUBLIC role; the dedicated type validates both cases.
    $aclRow.fields.granteeOid='aclOid';$aclRow.fields.grantee='aclRole'
    $metadata=@{fields=@{databases=@{array=$dbRow};acl=@{array=$aclRow};orphan='enum:ABSENT_AT_SNAPSHOT|CURRENT_IDENTITY_VERIFIED|IDENTITY_CHANGED_OR_UNVERIFIED';origin='enum:UNVERIFIED';roles=@{array=$roleRow}}}
    $backendTypes='enum:client backend|autovacuum launcher|autovacuum worker|background writer|checkpointer|walwriter|walsender|walreceiver|logical replication launcher|logical replication worker|parallel worker|background worker|standalone backend|archiver|startup|walsummarizer|UNKNOWN'
    $sessionRow=@{fields=@{pid='pid';database_oid=@{nullable='oid'};role_oid=@{nullable='oid'};backend_start=@{nullable='timestamp'};backendIdentity=@{nullable='backendKey'};
        datname=@{nullable='database'};usename=@{nullable=$role};application_name='enum:|psql|pgAdmin 4|ttv-surplus-session-inspection|ttv-surplus-explicit-orphan-cleanup|ttv-surplus-temp-control|ttv-surplus-temp-inspection|ttv-surplus-target-inspection|ttv-surplus-readonly-connection-check|ttv-surplus-migration-verifier|OTHER_APPLICATION_REDACTED';
        client_addr=@{nullable='ip'};backend_type=$backendTypes;state=@{nullable='enum:active|idle|idle in transaction|idle in transaction (aborted)|fastpath function call|disabled|UNKNOWN'};
        wait_event_type=@{nullable='enum:Activity|BufferPin|Client|Extension|IO|IPC|Lock|LWLock|Timeout|UNKNOWN'};wait_event=@{nullable='event'};
        kind='enum:SELF|OTHER_CLIENT|BACKGROUND|UNKNOWN';classification='enum:SELF|VERIFIED_CLIENT|VERIFIED_BACKGROUND|UNCLASSIFIED';database_scope='enum:TARGET|POSTGRES|NONE|OTHER_DATABASE';observation='enum:VISIBLE|UNKNOWN'}}
    $sessions=@{fields=@{status='enum:PASS|FAIL|UNKNOWN';reason=$reasons;phase='enum:URL_VALIDATION|SERVER_IDENTITY';fields=@{array=$diagnostics};
        selfPid='pid';cluster='enum:7703979600700924132';postmasterStart=@{nullable='timestamp'};observedAt=@{nullable='timestamp'};
        targetSessions='countOrUnknown';otherSessions='countOrUnknown';verifiedOtherClients='count';verifiedOtherBackgrounds='count';unclassifiedOtherBackends='count';sessions=@{array=$sessionRow}};
        optional=@('phase','fields','selfPid','cluster','postmasterStart','observedAt','targetSessions','otherSessions','verifiedOtherClients','verifiedOtherBackgrounds','unclassifiedOtherBackends','sessions')}
    $legacy=@{fields=@{verification='enum:VERIFIED|UNKNOWN';readiness='enum:NOT_READY';reason=$reasons;phase='enum:URL_VALIDATION|SERVER_IDENTITY';fields=@{array=$diagnostics};blockers=@{array=$blocker};metadata=@{nullable=$metadata};sessions=$sessions};optional=@('phase','fields','sessions')}
    return @{acl=$acl;legacy=$legacy;groups=$groups}
}

function Get-SurplusWriteClassification {
    param($Checks)
    $eligible=$false
    try {
        $e=$Checks.evidence;$id=$e.identity;$roots=@($Checks.objects.roles|ForEach-Object {$_.role_oid})
        $eligible=$Checks.status -ceq 'VERIFIED' -and $Checks.snapshotMatched -ceq $true -and $Checks.database_oid -ceq '5' -and $e.database_oid -ceq '5' -and
            $e.transaction.owner -ceq 'METADATA_CLIENT' -and $e.transaction.isolation -ceq 'repeatable read' -and $e.transaction.readOnly -ceq $true -and $e.transaction.sameSnapshot -ceq $true -and
            $id.schema_name -ceq 'pg_catalog' -and $id.relation_name -ceq 'pg_settings' -and $id.relkind -ceq 'v' -and $id.schema_oid -ceq '11' -and $id.owner_oid -ceq '10' -and
            $roots.Count -eq 3 -and @($roots|Select-Object -Unique).Count -eq 3 -and $e.counts.roles -eq 3 -and $e.roles.Count -eq 3 -and
            $e.counts.grants -eq 2 -and $e.grants.Count -eq 2 -and $e.counts.paths -eq 6 -and $e.paths.Count -eq 6 -and
            @($e.grants|ForEach-Object {$_.grantee_oid}|Select-Object -Unique).Count -eq 2
        foreach($g in $e.grants){if($g.scope -cne 'RELATION' -or $g.attnum -ne 0 -or $g.grantor_oid -cne '10' -or $g.grantee_oid -cnotin @('0','10') -or $g.grantable -cne $false){$eligible=$false}}
        foreach($root in $roots){
            $role=@($Checks.objects.roles|Where-Object role_oid -ceq $root)
            $wide=@($e.roles|Where-Object role_oid -ceq $root)
            $target=@($Checks.objects.relations|Where-Object {$_.role_oid -ceq $root -and $_.object_oid -ceq $id.object_oid})
            $owner=@($Checks.objects.memberships|Where-Object {$_.role_oid -ceq $root -and $_.object_oid -ceq $id.owner_oid})
            if($role.Count -ne 1 -or $role[0].superuser -cne $false -or $wide.Count -ne 1 -or $wide[0].write_all_usage -cne $false -or $wide[0].write_all_set -cne $false -or
                $target.Count -ne 1 -or $owner.Count -ne 1 -or $owner[0].usage -cne $false -or $owner[0].settable -cne $false){$eligible=$false;continue}
            $r=$target[0]
            if($r.schema_oid -cne $id.schema_oid -or $r.owner_oid -cne $id.owner_oid -or $r.default_acl -cne $false -or $r.schema_usage -cne $true -or
                $r.table_update -cne $true -or $r.column_update -cne $true -or $r.owner_usage -cne $false -or $r.owner_set -cne $false){$eligible=$false}
            foreach($key in @('table_insert','table_delete','table_truncate','table_references','table_trigger','table_maintain','column_insert')){if($r.$key -cne $false){$eligible=$false}}
            foreach($grantee in @('0','10')){
                $p=@($e.paths|Where-Object {$_.role_oid -ceq $root -and $_.grantee_oid -ceq $grantee})
                if($p.Count -ne 1 -or $p[0].scope -cne 'RELATION' -or $p[0].attnum -ne 0 -or $p[0].grantor_oid -cne '10' -or $p[0].grantable -cne $false -or
                    $p[0].public -cne ($grantee -ceq '0') -or $p[0].direct -cne $false -or $p[0].inherited -cne $false -or $p[0].settable -cne $false){$eligible=$false}
            }
        }
    }catch{$eligible=$false}
    $blocked=$false
    foreach($r in $Checks.objects.relations){foreach($p in $r.PSObject.Properties){
        if(($p.Name -cmatch '^(table_|column_)' -or $p.Name -cin @('owner_usage','owner_set')) -and $p.Value -ceq $true -and
            -not ($eligible -and $r.object_oid -ceq $Checks.evidence.identity.object_oid -and $p.Name -cin @('table_update','column_update'))){$blocked=$true}
    }}
    foreach($r in $Checks.objects.sequences){if($r.effective_usage -or $r.effective_update -or $r.owner_usage -or $r.owner_set){$blocked=$true}}
    $warnings=@()
    if($eligible){$warnings=@([pscustomobject]@{code='PG_SETTINGS_DEFAULT_PUBLIC_UPDATE';database_oid='5';object_oid=$Checks.evidence.identity.object_oid;role_oids=@($roots|Sort-Object)})}
    return [pscustomobject]@{blocked=$blocked;warnings=$warnings}
}

function Assert-SurplusReportConsistency {
    param($Report, [switch]$Acl, $Schemas)
    if($Report.blockers -cnotcontains 'EXCLUSIVE_OPERATION_NOT_CONFIRMED'){throw 'REPORT_VALIDATION_FAILED'}
    if(@($Report.blockers|Select-Object -Unique).Count -ne $Report.blockers.Count){throw 'REPORT_VALIDATION_FAILED'}
    if(($null -ne $Report.phase) -ne ($null -ne $Report.fields)){throw 'REPORT_VALIDATION_FAILED'}
    if($null -ne $Report.phase -and $Report.fields.Count -eq 0){throw 'REPORT_VALIDATION_FAILED'}
    if(-not $Acl){
        if($Report.verification -ceq 'VERIFIED' -and ($null -eq $Report.metadata -or $null -eq $Report.sessions -or $Report.sessions.status -cne 'PASS')){throw 'REPORT_VALIDATION_FAILED'}
        if($null -ne $Report.sessions -and $Report.sessions.status -ceq 'PASS'){
            foreach($key in @('selfPid','cluster','postmasterStart','observedAt','targetSessions','otherSessions','verifiedOtherClients','verifiedOtherBackgrounds','unclassifiedOtherBackends','sessions')){
                if($null -eq $Report.sessions.$key){throw 'REPORT_VALIDATION_FAILED'}
            }
            $s=$Report.sessions
            if($s.reason -cne 'SESSION_SNAPSHOT_READ' -or $s.unclassifiedOtherBackends -ne 0 -or $s.otherSessions -ceq 'UNKNOWN' -or $s.targetSessions -ceq 'UNKNOWN' -or
                @($s.sessions|Where-Object {$_.pid -ceq $s.selfPid}).Count -ne 1 -or @($s.sessions|Where-Object {$_.classification -ceq 'UNCLASSIFIED'}).Count -gt 0){throw 'REPORT_VALIDATION_FAILED'}
        }
        if($null -ne $Report.metadata){
            $m=$Report.metadata
            if($m.roles.Count -ne 3 -or @($m.roles|ForEach-Object {$_.oid}|Select-Object -Unique).Count -ne 3 -or
                ((@($m.roles|ForEach-Object {$_.name}|Sort-Object) -join ':') -cne 'ttv_surplus_lifecycle:ttv_surplus_reader:ttv_surplus_writer')){throw 'REPORT_VALIDATION_FAILED'}
            foreach($r in $m.roles){if($r.fullStatsEffective -cne $r.observationRights.pg_read_all_stats.USAGE){throw 'REPORT_VALIDATION_FAILED'}}
            foreach($d in $m.databases){if(($d.markerFormat -ceq 'ABSENT') -ne ($null -eq $d.markerSha256)){throw 'REPORT_VALIDATION_FAILED'}}
            foreach($a in $m.acl){if(($a.granteeOid -ceq '0') -ne ($a.grantee -ceq 'PUBLIC')){throw 'REPORT_VALIDATION_FAILED'}}
        }
        if($null -ne $Report.sessions -and $null -ne $Report.sessions.sessions){
            $s=$Report.sessions
            foreach($row in $s.sessions){if($null -ne $row.backendIdentity -and $row.backendIdentity -cne ($s.cluster+'|'+$s.postmasterStart+'|'+$row.pid+'|'+$row.backend_start)){throw 'REPORT_VALIDATION_FAILED'}}
            if(@($s.sessions|ForEach-Object {$_.pid}|Select-Object -Unique).Count -ne $s.sessions.Count){throw 'REPORT_VALIDATION_FAILED'}
            $clients=@($s.sessions|Where-Object {$_.classification -ceq 'VERIFIED_CLIENT'}).Count
            $backgrounds=@($s.sessions|Where-Object {$_.classification -ceq 'VERIFIED_BACKGROUND'}).Count
            $unclassified=@($s.sessions|Where-Object {$_.classification -ceq 'UNCLASSIFIED'}).Count
            if($clients -ne $s.verifiedOtherClients -or $backgrounds -ne $s.verifiedOtherBackgrounds -or $unclassified -ne $s.unclassifiedOtherBackends){throw 'REPORT_VALIDATION_FAILED'}
            if($s.status -ceq 'PASS' -and ($s.otherSessions -ne $clients -or $s.targetSessions -ne @($s.sessions|Where-Object {$_.classification -ceq 'VERIFIED_CLIENT' -and $_.database_scope -ceq 'TARGET'}).Count)){throw 'REPORT_VALIDATION_FAILED'}
            if($clients -gt 0 -and $Report.blockers -cnotcontains 'OTHER_CLIENT_SESSIONS_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
            if($unclassified -gt 0 -and $Report.blockers -cnotcontains 'UNCLASSIFIED_BACKENDS_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
            foreach($row in $s.sessions){
                $expectedKind=@{SELF='SELF';VERIFIED_CLIENT='OTHER_CLIENT';VERIFIED_BACKGROUND='BACKGROUND';UNCLASSIFIED='UNKNOWN'}[$row.classification]
                if($row.kind -cne $expectedKind -or (($row.pid -ceq $s.selfPid) -ne ($row.classification -ceq 'SELF'))){throw 'REPORT_VALIDATION_FAILED'}
                if($row.classification -ceq 'VERIFIED_CLIENT' -and $row.backend_type -cne 'client backend'){throw 'REPORT_VALIDATION_FAILED'}
                if($row.classification -ceq 'VERIFIED_BACKGROUND' -and $row.backend_type -cin @('client backend','UNKNOWN')){throw 'REPORT_VALIDATION_FAILED'}
            }
        }
        return
    }
    $verified=$Report.verification -ceq 'VERIFIED'
    if($verified -and ($Report.code -cne 'ACL_READ_VERIFIED' -or $null -eq $Report.checks -or $Report.sessionCheck.status -cne 'VERIFIED' -or $null -ne $Report.sqlstate -or $null -ne $Report.phase)){throw 'REPORT_VALIDATION_FAILED'}
    if(-not $verified -and $Report.code -ceq 'ACL_READ_VERIFIED'){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.sessionCheck.status -ceq 'VERIFIED'){
        if($null -eq $Report.sessionCheck.otherClients -or $null -eq $Report.sessionCheck.backgrounds -or $Report.sessionCheck.unclassified -cne 0 -or -not $verified){throw 'REPORT_VALIDATION_FAILED'}
    }elseif($Report.blockers -cnotcontains 'SESSION_OR_IDENTITY_UNVERIFIED'){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.sessionCheck.otherClients -gt 0 -and $Report.blockers -cnotcontains 'OTHER_CLIENT_SESSIONS_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.sessionCheck.unclassified -gt 0 -and $Report.blockers -cnotcontains 'UNCLASSIFIED_BACKENDS_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.blockingDatabaseOids.Count -gt 0 -and $Report.blockers -cnotcontains 'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE'){throw 'REPORT_VALIDATION_FAILED'}
    if($null -eq $Report.checks){if($Report.warnings.Count -ne 0){throw 'REPORT_VALIDATION_FAILED'};return}
    $checks=$Report.checks
    if(-not $checks.snapshotMatched -or $checks.counts.roles -ne 3 -or $checks.counts.functions -ne 9 -or $checks.counts.databases -ne 3 -or $checks.counts.schemas -lt 3 -or $checks.counts.relations -lt 3 -or $checks.counts.memberships -lt 9){throw 'REPORT_VALIDATION_FAILED'}
    $roots=@($checks.objects.roles|ForEach-Object {$_.role_oid})
    if(@($roots|Select-Object -Unique).Count -ne 3){throw 'REPORT_VALIDATION_FAILED'}
    $e=$checks.evidence
    if(-not $e.transaction.readOnly -or -not $e.transaction.sameSnapshot -or $e.database_oid -cne $checks.database_oid -or $e.database_oid -cne '5' -or
        $e.counts.roles -ne 3 -or $e.roles.Count -ne 3 -or $e.counts.grants -ne $e.grants.Count -or $e.grants.Count -gt 256 -or
        $e.counts.paths -ne $e.paths.Count -or $e.paths.Count -ne 3*$e.grants.Count -or @($e.roles|ForEach-Object {$_.role_oid}|Select-Object -Unique).Count -ne 3){throw 'REPORT_VALIDATION_FAILED'}
    $grantKeys=@($e.grants|ForEach-Object {$_.scope+':'+$_.attnum+':'+$_.grantor_oid+':'+$_.grantee_oid})
    if(@($grantKeys|Select-Object -Unique).Count -ne $e.grants.Count){throw 'REPORT_VALIDATION_FAILED'}
    $pathKeys=@($e.paths|ForEach-Object {$_.role_oid+':'+$_.scope+':'+$_.attnum+':'+$_.grantor_oid+':'+$_.grantee_oid})
    if(@($pathKeys|Select-Object -Unique).Count -ne $e.paths.Count){throw 'REPORT_VALIDATION_FAILED'}
    foreach($g in $e.grants){if(($g.scope -ceq 'RELATION' -and $g.attnum -ne 0) -or ($g.scope -ceq 'COLUMN' -and $g.attnum -le 0)){throw 'REPORT_VALIDATION_FAILED'}}
    foreach($r in $e.roles){
        if($r.role_oid -cnotin $roots){throw 'REPORT_VALIDATION_FAILED'}
        $target=@($checks.objects.relations|Where-Object {$_.role_oid -ceq $r.role_oid -and $_.object_oid -ceq $e.identity.object_oid})
        $owner=@($checks.objects.memberships|Where-Object {$_.role_oid -ceq $r.role_oid -and $_.object_oid -ceq $e.identity.owner_oid})
        $baseline=@($checks.objects.roles|Where-Object {$_.role_oid -ceq $r.role_oid})
        if($target.Count -ne 1 -or $owner.Count -ne 1 -or $target[0].schema_oid -cne $e.identity.schema_oid -or $target[0].owner_oid -cne $e.identity.owner_oid -or
            $target[0].owner_usage -cne $owner[0].usage -or $target[0].owner_set -cne $owner[0].settable){throw 'REPORT_VALIDATION_FAILED'}
        foreach($g in $e.grants){
            $p=@($e.paths|Where-Object {$_.role_oid -ceq $r.role_oid -and $_.scope -ceq $g.scope -and $_.attnum -eq $g.attnum -and $_.grantor_oid -ceq $g.grantor_oid -and $_.grantee_oid -ceq $g.grantee_oid})
            $m=@($checks.objects.memberships|Where-Object {$_.role_oid -ceq $r.role_oid -and $_.object_oid -ceq $g.grantee_oid})
            if($p.Count -ne 1 -or ($g.grantee_oid -cne '0' -and $m.Count -ne 1)){throw 'REPORT_VALIDATION_FAILED'}
            $public=$g.grantee_oid -ceq '0';$direct=$g.grantee_oid -ceq $r.role_oid
            $inherited=(-not $public -and -not $direct -and $m[0].usage)
            $settable=(-not $public -and $m[0].settable)
            if($p[0].public -cne $public -or $p[0].direct -cne $direct -or $p[0].inherited -cne $inherited -or $p[0].settable -cne $settable -or $p[0].grantable -cne $g.grantable){throw 'REPORT_VALIDATION_FAILED'}
        }
        $usable=@($e.paths|Where-Object {$_.role_oid -ceq $r.role_oid -and ($_.public -or $_.direct -or $_.inherited)})
        $tableUpdate=$baseline[0].superuser -or $r.write_all_usage -or @($usable|Where-Object scope -ceq 'RELATION').Count -gt 0
        $columnUpdate=$tableUpdate -or @($usable|Where-Object scope -ceq 'COLUMN').Count -gt 0
        if($target[0].table_update -cne $tableUpdate -or $target[0].column_update -cne $columnUpdate){throw 'REPORT_VALIDATION_FAILED'}
    }
    foreach($category in $Schemas.groups.Keys){
        $rows=$checks.objects.$category;$count=$checks.counts.$category
        if($rows.Count -ne $count){throw 'REPORT_VALIDATION_FAILED'}
        $keys=New-Object 'System.Collections.Generic.List[string]'
        $oidFields=$Schemas.groups[$category][1].Split(' ')|Where-Object {$_ -cnotin @('owner_oid','schema_oid')}
        foreach($row in $rows){
            if($category -cne 'edges' -and $row.role_oid -cnotin $roots){throw 'REPORT_VALIDATION_FAILED'}
            [void]$keys.Add((@($oidFields|ForEach-Object {$row.$_}) -join ':'))
            if($category -ceq 'databases' -and $row.object_oid -cne $checks.database_oid){throw 'REPORT_VALIDATION_FAILED'}
        }
        if(@($keys|Select-Object -Unique).Count -ne $keys.Count){throw 'REPORT_VALIDATION_FAILED'}
        if($category -cnotin @('roles','edges')){
            if($count % 3 -ne 0){throw 'REPORT_VALIDATION_FAILED'}
            $reference=$null
            foreach($root in $roots){
                $objects=@($rows|Where-Object {$_.role_oid -ceq $root}|ForEach-Object {$_.object_oid}|Sort-Object)
                if($objects.Count -ne ($count/3)){throw 'REPORT_VALIDATION_FAILED'}
                $key=$objects -join ':';if($null -ne $reference -and $reference -cne $key){throw 'REPORT_VALIDATION_FAILED'};$reference=$key
            }
        }
    }
    if(@($checks.objects.databases|Where-Object {$_.effective_temp}).Count -gt 0 -and $Report.blockers -cnotcontains 'ACL_TEMP_PRIVILEGE_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
    if(@($checks.objects.schemas|Where-Object {$_.effective_create -or $_.owner_usage -or $_.owner_set}).Count -gt 0 -and $Report.blockers -cnotcontains 'ACL_SCHEMA_CREATE_OR_OWNERSHIP_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
    $classification=Get-SurplusWriteClassification $checks
    if($classification.blocked -and $Report.blockers -cnotcontains 'ACL_WRITE_CAPABILITIES_PRESENT'){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.warnings.Count -ne $classification.warnings.Count){throw 'REPORT_VALIDATION_FAILED'}
    if($Report.warnings.Count -eq 1){
        $w=$Report.warnings[0];$expected=$classification.warnings[0]
        if($w.object_oid -cne $expected.object_oid -or $w.role_oids.Count -ne 3 -or ((@($w.role_oids|Sort-Object) -join ':') -cne (@($expected.role_oids) -join ':'))){throw 'REPORT_VALIDATION_FAILED'}
    }
    if($checks.counts.definers -gt 0 -and $Report.blockers -cnotcontains 'PUBLIC_SECURITY_DEFINER_REVIEW_REQUIRED'){throw 'REPORT_VALIDATION_FAILED'}
}

function ConvertTo-SurplusValidatedReportJson {
    param($Report, [switch]$Acl, [int]$ChildExitCode=0)
    try {
        $schemas=Get-SurplusReportSchemas
        $schema=if($Acl){$schemas.acl}else{$schemas.legacy}
        $safe=Copy-SurplusReportValue $Report $schema
        Assert-SurplusReportConsistency $safe -Acl:$Acl -Schemas $schemas
        if($safe.verification -ceq 'VERIFIED' -and $ChildExitCode -ne 0){throw 'REPORT_VALIDATION_FAILED'}
        return ($safe|ConvertTo-Json -Depth 16 -Compress)
    }catch{return '{"verification":"UNKNOWN","readiness":"NOT_READY","code":"REPORT_VALIDATION_FAILED"}'}
}

$raw=$null; $info=$null; $child=$null; $stdout=$null; $stderr=$null
$reported=$false;$failureCode='INSPECTION_FAILED'
try {
    $raw=Read-SurplusSecretUrl 'ttv_surplus_lifecycle'
    # CJS reuses the existing strict URL + cluster guard BEFORE catalog inspection.
    $info=New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $info.Arguments='"'+(Join-Path $PSScriptRoot 'inspect-payment-surplus-metadata.cjs')+'"'
    $info.WorkingDirectory=Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($key in @('SYSTEMROOT','WINDIR','PATH','TEMP','TMP')) {
        $value=[Environment]::GetEnvironmentVariable($key,'Process')
        if($null -ne $value){$info.EnvironmentVariables[$key]=$value}
    }
    $info.EnvironmentVariables['SURPLUS_METADATA_URL']=$raw
    if($Acl){$info.EnvironmentVariables['SURPLUS_METADATA_ACL']='1'}
    $child=New-Object System.Diagnostics.Process; $child.StartInfo=$info
    if(-not $child.Start()){throw 'INSPECTION_START_FAILED'}
    $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
    $timeout=if($Acl){210000}else{45000}
    if(-not $child.WaitForExit($timeout)) {
        Write-Output '{"verification":"UNKNOWN","readiness":"NOT_READY","code":"INSPECTION_TIMEOUT"}'
        $reported=$true
        $child.Kill(); [void]$child.WaitForExit(3000); throw 'INSPECTION_TIMEOUT'
    }
    $failureCode='REPORT_VALIDATION_FAILED'
    $report=$stdout.GetAwaiter().GetResult()|ConvertFrom-Json -ErrorAction Stop
    [void]$stderr.GetAwaiter().GetResult()
    $json=ConvertTo-SurplusValidatedReportJson $report -Acl:$Acl -ChildExitCode $child.ExitCode
    Write-Output $json
    $reported=$true
    $safe=$json|ConvertFrom-Json
    if($child.ExitCode -ne 0 -or $safe.verification -cne 'VERIFIED'){throw 'OBSERVATION_UNVERIFIED'}
}
catch {
    if(-not $reported){Write-Output ('{"verification":"UNKNOWN","readiness":"NOT_READY","code":"'+$failureCode+'"}')}
    throw 'READONLY_METADATA_INSPECTION_UNKNOWN_OR_NOT_READY'
}
finally {
    if($null -ne $info){$info.EnvironmentVariables.Clear()}
    $raw=$null; $stdout=$null; $stderr=$null; $report=$null; $safe=$null; $json=$null
    if($null -ne $child){$child.Dispose()}
}
