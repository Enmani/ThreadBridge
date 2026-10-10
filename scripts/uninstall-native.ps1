param([ValidateSet('Chrome','Edge')][string]$Browser='Chrome')
$ErrorActionPreference='Stop'
$vendor='Google\Chrome';if($Browser -eq 'Edge'){$vendor='Microsoft\Edge'}
$registryPath="HKCU:\Software\$vendor\NativeMessagingHosts\com.threadbridge.history"
if(Test-Path -LiteralPath $registryPath){Remove-Item -LiteralPath $registryPath}
Write-Output 'Native host registration removed. Local history is retained.'
