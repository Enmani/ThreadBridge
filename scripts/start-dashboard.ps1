param([ValidateRange(1024,65535)][int]$Port=17321)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime=(Get-Command node -ErrorAction Stop).Source
$configFile=Join-Path $projectRoot 'data/native-config.json'
$databasePath=Join-Path $projectRoot 'data/history.sqlite';$accountName='personal'
if(Test-Path -LiteralPath $configFile){$config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json;$databasePath=$config.db;$accountName=$config.account}
Push-Location $projectRoot
try{
  & $runtime 'src/cli.mjs' status --db $databasePath --account $accountName | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Unable to initialize the local database.'}
  $url="http://127.0.0.1:$Port"
  $running=$false
  $status=$null
  try{$status=Invoke-RestMethod -Uri "$url/api/status" -TimeoutSec 2}catch{}
  if($status){
    if($status.app -ne 'threadbridge' -or $status.account -ne $accountName){throw 'Port is occupied by another service or account. Choose another port.'}
    $running=$true
  }
  if(!$running){
    $quotedRoot='"'+(Join-Path $projectRoot 'src/dashboard.mjs')+'"'
    $arguments="$quotedRoot --db `"$databasePath`" --account `"$accountName`" --port $Port"
    $process=Start-Process -FilePath $runtime -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText((Join-Path $projectRoot 'data/dashboard.pid'),[string]$process.Id)
    for($attempt=0;$attempt -lt 20;$attempt++){try{$status=Invoke-RestMethod -Uri "$url/api/status" -TimeoutSec 1;break}catch{Start-Sleep -Milliseconds 200}}
    if(!$status -or $status.app -ne 'threadbridge' -or $status.account -ne $accountName){throw 'Dashboard did not start for this account. Check the port.'}
  }
  Write-Output "Dashboard running: $url"
  Write-Output 'Browser sync begins when the ThreadBridge extension is connected.'
}finally{Pop-Location}
