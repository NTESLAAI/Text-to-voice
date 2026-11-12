$ErrorActionPreference = 'Stop'
# Extract only the pure report validator AST. Never invoke the wrapper or Node.
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'invoke.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'SYNTAX_FAILED' }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-AcceptanceReport' }, $true)
if ($null -eq $function) { throw 'VALIDATOR_MISSING' }
. ([scriptblock]::Create($function.Extent.Text))
$passed = 0
$failed = 0
function Fixture {
    return ('{"status":"VERIFIED","readiness":"NOT_READY","action":"test","code":"ACCEPTANCE_STEP_PASS","tests":{"total":14,"passed":14,"failed":0,"skipped":0,"failedCases":[]}}' | ConvertFrom-Json)
}
function Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++ }
    catch { $script:failed++; Write-Output ('FAIL=' + $Name) }
}
Case 'valid filtered test report and real exit code' {
    $result = ConvertTo-AcceptanceReport (Fixture) 'test' 7
    if ($result.exitCode -ne 7 -or $result.tests.total -ne 14 -or $result.status -ne 'UNKNOWN') { throw 'FAILED' }
}
$mutations = @(
    { param($r) $r | Add-Member NoteProperty extra 'SENSITIVE_SENTINEL' },
    { param($r) $r.tests | Add-Member NoteProperty extra 'SENSITIVE_SENTINEL' },
    { param($r) $r.tests = $null },
    { param($r) $r.PSObject.Properties.Remove('tests') },
    { param($r) $r.tests.total = '12' },
    { param($r) $r.tests.passed = 11 },
    { param($r) $r.tests.skipped = 1 },
    { param($r) $r.status = 'OTHER' },
    { param($r) $r.status = @('VERIFIED') },
    { param($r) $r.status = 'verified' },
    { param($r) $r.readiness = 'READY' },
    { param($r) $r.code = 'SENSITIVE_SENTINEL' },
    { param($r) $r.action = 'backup-restore' }
)
$index = 0
foreach ($mutation in $mutations) {
    $index++
    Case ('invalid-report-' + $index) {
        $r = Fixture
        & $mutation $r
        $refused = $false
        try { $null = ConvertTo-AcceptanceReport $r 'test' 0 } catch { $refused = $true }
        if (-not $refused) { throw 'FAILED' }
    }
}
Case 'fixed UNKNOWN preserves diagnostic without raw exception' {
    $r = '{"status":"UNKNOWN","readiness":"NOT_READY","action":null,"code":"IDENTITY_UNVERIFIED"}' | ConvertFrom-Json
    $result = ConvertTo-AcceptanceReport $r 'test' 1
    if ($result.code -ne 'IDENTITY_UNVERIFIED' -or $result.readiness -ne 'NOT_READY') { throw 'FAILED' }
}
Write-Output ('MOCK_PASS=' + $passed + ' MOCK_FAIL=' + $failed)
if ($failed -ne 0) { exit 1 }
