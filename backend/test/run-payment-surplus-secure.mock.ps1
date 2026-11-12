[CmdletBinding()]
param([string]$TestDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
# Extract function definitions only. Never execute or dot-source the entrypoint.
$path=Join-Path $TestDirectory 'run-payment-surplus-secure.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'MOCK_SYNTAX_FAILED'}
$definitions=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)
foreach($name in @('Assert-SurplusTestConfiguration','New-SurplusChildStartInfo','ConvertTo-SurplusApprovalRequest','Confirm-SurplusRunApproval','Write-SurplusRunnerDiagnostics')){
    $definition=@($definitions|Where-Object Name -ceq $name)
    if($definition.Count -ne 1){throw 'MOCK_DEFINITION_MISSING'}
    . ([scriptblock]::Create($definition[0].Extent.Text))
}
$script:passed=0
function Assert-Mock {param([bool]$Value);if(-not $Value){throw 'MOCK_ASSERTION_FAILED'};$script:passed++}
function Assert-Rejected {param([scriptblock]$Action);$rejected=$false;try{& $Action|Out-Null}catch{$rejected=$true};Assert-Mock $rejected}
$request=[ordered]@{version=1;type='PREFLIGHT_CHALLENGE';runId='11111111-1111-4111-8111-111111111111';mode='READ_TESTS';
    target=('ttv_surplus_it_'+('a'*32));runnerPid=123;challenge=('b'*64);observationMode='OBSERVER'}
$json=$request|ConvertTo-Json -Compress
$safe=ConvertTo-SurplusApprovalRequest $json 123 'READ_TESTS' 'OBSERVER'
Assert-Mock ($safe.runId -ceq $request.runId)
foreach($field in @('version','type','runId','mode','target','runnerPid','challenge','observationMode')){
    $bad=[ordered]@{};foreach($key in $request.Keys){$bad[$key]=$request[$key]};$bad[$field]='MOCK_SENTINEL'
    $badJson=$bad|ConvertTo-Json -Compress
    Assert-Rejected {ConvertTo-SurplusApprovalRequest $badJson 123 'READ_TESTS' 'OBSERVER'}
}
$extra=($json|ConvertFrom-Json);$extra|Add-Member -NotePropertyName unexpected -NotePropertyValue 'MOCK_SENTINEL'
Assert-Rejected {ConvertTo-SurplusApprovalRequest ($extra|ConvertTo-Json -Compress) 123 'READ_TESTS' 'OBSERVER'}
Assert-Rejected {ConvertTo-SurplusApprovalRequest '{}' 123 'READ_TESTS' 'OBSERVER'}
Assert-Rejected {ConvertTo-SurplusApprovalRequest ('x'*2049) 123 'READ_TESTS' 'OBSERVER'}
foreach($field in @('mode','type','observationMode')){
    $bad=[ordered]@{};foreach($key in $request.Keys){$bad[$key]=$request[$key]};$bad[$field]=@($request[$field])
    $badJson=$bad|ConvertTo-Json -Compress
    Assert-Rejected {ConvertTo-SurplusApprovalRequest $badJson 123 'READ_TESTS' 'OBSERVER'}
}

$script:reply=$null;$script:confirmation='CONFIRM '+$request.runId+' READ_TESTS '+$request.target+' EXCLUSIVE'
function Read-Host {param([string]$Prompt);return $script:confirmation}
$script:lineTask=New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'
$script:lineTask.SetResult($json)
$stdout=[pscustomobject]@{}
$stdout|Add-Member ScriptMethod ReadLineAsync {return $script:lineTask.Task}
$stdin=[pscustomobject]@{}
$stdin|Add-Member ScriptMethod WriteLine {param($value);$script:reply=$value}
$stdin|Add-Member ScriptMethod Flush {}
$child=[pscustomobject]@{StandardOutput=$stdout;StandardInput=$stdin;Id=123;HasExited=$false}
Confirm-SurplusRunApproval $child 'READ_TESTS' 'OBSERVER'
$reply=$script:reply|ConvertFrom-Json
Assert-Mock ($reply.confirmRun -eq $true -and $reply.confirmExclusive -eq $true -and $reply.runId -ceq $request.runId)
$script:reply=$null;$script:confirmation='NO'
Assert-Rejected {Confirm-SurplusRunApproval $child 'READ_TESTS' 'OBSERVER'}
Assert-Mock ($null -eq $script:reply)
$script:confirmation='CONFIRM '+$request.runId+' READ_TESTS '+$request.target+' EXCLUSIVE'
$child.HasExited=$true
Assert-Rejected {Confirm-SurplusRunApproval $child 'READ_TESTS' 'OBSERVER'}
$child.HasExited=$false
$script:lineTask=New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'
$script:lineTask.SetResult($null)
Assert-Rejected {Confirm-SurplusRunApproval $child 'READ_TESTS' 'OBSERVER'}
$timeoutTask=[pscustomobject]@{}
$timeoutTask|Add-Member ScriptMethod Wait {param($milliseconds);return $false}
$timeoutOut=[pscustomobject]@{Task=$timeoutTask}
$timeoutOut|Add-Member ScriptMethod ReadLineAsync {return $this.Task}
$child.StandardOutput=$timeoutOut
Assert-Rejected {Confirm-SurplusRunApproval $child 'READ_TESTS' 'OBSERVER'}

$config=@{
    PAYMENT_SURPLUS_TEST_ADMIN_URL='postgresql://ttv_surplus_lifecycle:MOCK_ONLY@127.0.0.1:55432/postgres';
    PAYMENT_SURPLUS_TEST_WRITER_URL='postgresql://ttv_surplus_writer:MOCK_ONLY@127.0.0.1:55432/postgres';
    PAYMENT_SURPLUS_TEST_READER_URL='postgresql://ttv_surplus_reader:MOCK_ONLY@127.0.0.1:55432/postgres';
    PAYMENT_SURPLUS_TEST_OBSERVATION_URL='postgresql://ttv_surplus_observer:MOCK_ONLY@127.0.0.1:55432/postgres';
    PAYMENT_SURPLUS_TEST_OBSERVATION_MODE='OBSERVER';PAYMENT_SURPLUS_TEST_PORT='55432';
    PAYMENT_SURPLUS_TEST_CLUSTER_ID='7703979600700924132';PAYMENT_SURPLUS_TEST_DATA_DIRECTORY='D:/text-to-voice/pg-test-cluster'
}
# ProcessStartInfo is configuration only; never construct/start a Process.
$info=New-SurplusChildStartInfo $config 'MOCK_NODE' 'MOCK_RUNNER' 'MOCK_BACKEND' 'YES'
Assert-Mock ($info.RedirectStandardInput -and $info.RedirectStandardOutput -and $info.RedirectStandardError)
Assert-Mock (-not $info.Arguments.Contains('MOCK_ONLY'))
Assert-Mock (-not $info.EnvironmentVariables.ContainsKey('DATABASE_URL'))
Assert-Rejected {New-SurplusChildStartInfo $config 'MOCK_NODE' 'MOCK_RUNNER' 'MOCK_BACKEND' 'NO'}
$config.PAYMENT_SURPLUS_TEST_OBSERVATION_URL=$config.PAYMENT_SURPLUS_TEST_OBSERVATION_URL.Replace(':55432/',':5432/')
Assert-Rejected {New-SurplusChildStartInfo $config 'MOCK_NODE' 'MOCK_RUNNER' 'MOCK_BACKEND' 'YES'}
$diagnostic=@(Write-SurplusRunnerDiagnostics '{"surplusStatus":"PREFLIGHT_RESULT","verification":"UNKNOWN","readiness":"NOT_READY","code":"PREFLIGHT_EVIDENCE_INVALID","extra":"MOCK_SENTINEL"}')
Assert-Mock ($diagnostic.Count -eq 1 -and $diagnostic[0] -notmatch 'MOCK_SENTINEL' -and $diagnostic[0] -match 'PREFLIGHT_EVIDENCE_INVALID')
$source=[IO.File]::ReadAllText($path)
Assert-Mock ($source.Contains('if (-not $ExecuteHarness)'))
Assert-Mock ($source.Contains('if ($ExecuteHarness -and $VerifyConnection)'))
Assert-Mock ($source.Contains('$Child.StandardInput.WriteLine($reply)'))
$info.EnvironmentVariables.Clear();$config.Clear();$script:reply=$null
Write-Output ('SECURE_PREFLIGHT_MOCK_PASS='+$script:passed+' FAIL=0')
