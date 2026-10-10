param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [ValidateSet('Chrome','Edge')][string]$Browser='Chrome',
  [ValidatePattern('^[A-Za-z0-9_-]{1,80}$')][string]$Account='personal',
  [string]$Workspace='',
  [ValidateSet('chatgpt','claude','gemini')][string[]]$Providers=@('chatgpt'),
  [ValidatePattern('^$|^[A-Za-z0-9_-]{1,160}$')][string]$ClaudeOrganization='',
  [ValidateRange(0,99)][int]$GeminiAccount=0
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime=(Get-Command node -ErrorAction Stop).Source
$major=[int]((& $runtime --version).TrimStart('v').Split('.')[0]);if($major -lt 24){throw 'Node.js 24 or newer is required.'}
if($projectRoot -match '[%"\r\n]' -or $runtime -match '[%"\r\n]'){throw 'Unsupported path characters.'}
if($Workspace -and $Workspace -notmatch '^[A-Za-z0-9_-]{1,160}$'){throw 'Invalid workspace.'}
$data=Join-Path $projectRoot 'data';New-Item -ItemType Directory -Path $data -Force | Out-Null
$configPath=Join-Path $data 'native-config.json';$launcher=Join-Path $data 'native-host.cmd';$manifestPath=Join-Path $data 'native-host.json'
$workspaceValue=$null;if($Workspace){$workspaceValue=$Workspace}
if(!$Providers.Count -or @($Providers | Select-Object -Unique).Count -ne $Providers.Count){throw 'Choose each provider once.'}
$providerConfigs=@(foreach($provider in $Providers){
  $entry=@{provider=$provider}
  if($provider -eq 'chatgpt'){$entry.workspace=$workspaceValue}
  if($provider -eq 'claude' -and $ClaudeOrganization){$entry.workspace=$ClaudeOrganization}
  if($provider -eq 'gemini'){$entry.authuser=$GeminiAccount}
  $entry
})
$config=@{extensionId=$ExtensionId;account=$Account;db=(Join-Path $data 'history.sqlite');workspace=$workspaceValue;
  providers=$providerConfigs;paceMs=90000;directoryIntervalMs=900000;projectIntervalMs=3600000;maxDirectoryPages=3;pendingIntervalMs=15000;maxPerRun=5;cooldownMs=120000}
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$command='@echo off'+[Environment]::NewLine+'"'+$runtime+'" "'+(Join-Path $projectRoot 'src\browser-host.mjs')+'" --config "'+$configPath+'" %*'+[Environment]::NewLine
[IO.File]::WriteAllText($launcher,$command,[Text.Encoding]::Default)
$manifest=@{name='com.threadbridge.history';description='ThreadBridge local history sync';path=$launcher;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$vendor='Google\Chrome';if($Browser -eq 'Edge'){$vendor='Microsoft\Edge'}
$registryPath="HKCU:\Software\$vendor\NativeMessagingHosts\com.threadbridge.history"
New-Item -Path $registryPath -Force | Out-Null;Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output 'Native host registered for the specified extension. Reload ThreadBridge in the browser.'
