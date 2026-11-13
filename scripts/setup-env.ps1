<#
  Assistente para preencher as variáveis do Board GLPI, uma a uma (Windows / PowerShell 5+).
  - Segredos são lidos com -AsSecureString (não aparecem na tela).
  - O .env recebe ACL restrita ao seu usuário.
  - Opcional: grava como variáveis de ambiente do usuário do Windows em vez de .env.
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$EnvFile = Join-Path (Get-Location) '.env'
$V = [ordered]@{}
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | Where-Object { $_ -and -not $_.StartsWith('#') -and $_.Contains('=') } | ForEach-Object {
    $i = $_.IndexOf('='); $V[$_.Substring(0,$i)] = $_.Substring($i+1) }
  Write-Host "Arquivo .env existente encontrado. ENTER mantém o valor atual." -ForegroundColor Yellow
}
function Mask($s) { if ([string]::IsNullOrEmpty($s)) { '(vazio)' } else { "definido ($($s.Length) caracteres)" } }
function Ask($Name, [bool]$Secret, [bool]$Required, $Help) {
  while ($true) {
    Write-Host "`n──────── $Name ────────" -ForegroundColor Cyan; Write-Host $Help
    $cur = $V[$Name]
    if ($Secret) {
      Write-Host "Atual: $(Mask $cur)"
      $ss = Read-Host 'Valor (não será exibido)' -AsSecureString
      $val = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($ss))
    } else { $val = Read-Host "Valor [$cur]" }
    if ([string]::IsNullOrEmpty($val)) { $val = $cur }
    if ($Required -and [string]::IsNullOrEmpty($val)) { Write-Host '  ✗ Obrigatório.' -ForegroundColor Red; continue }
    $V[$Name] = $val
    if ($Secret) { Write-Host "  ✓ $(Mask $val)" -ForegroundColor Green } else { Write-Host "  ✓ $val" -ForegroundColor Green }
    return
  }
}

Write-Host '=== Configuração do Board GLPI ===' -ForegroundColor Cyan
do {
  Ask 'GLPI_URL' $false $true "URL da API REST, terminando em /apirest.php. Ex.: https://glpi.suaempresa.com.br/apirest.php`nConfira em Configurar > Geral > API ('URL da API'). HTTPS obrigatório."
} until ($V['GLPI_URL'] -match '^https://' -or $V['GLPI_URL'] -match '^http://(localhost|127\.0\.0\.1)')

Ask 'GLPI_APP_TOKEN' $true $false "Token do CLIENTE DA API. Configurar > Geral > API > Adicionar cliente da API:`n  Nome: Board Gerencial | Ativo: Sim | Faixa de IP: IP do servidor do board`n  Token da aplicação: 'Regenerar' e copiar. Vazio só se o cliente não exigir app_token."

Write-Host "`nAutenticação do usuário de serviço:`n  1) Token de API do usuário (RECOMENDADO)`n  2) Usuário e senha"
$mode = Read-Host 'Opção [1]'; if (-not $mode) { $mode = '1' }
if ($mode -eq '1') {
  Ask 'GLPI_USER_TOKEN' $true $true "Usuário dedicado (ex.: svc_board), perfil SOMENTE LEITURA (Chamados: ver todos; Usuários, Grupos, Tipos de solução: ler).`nLogado como ele: Meus ajustes > Chaves de acesso remoto > Token de API > Regenerar."
  $V['GLPI_USERNAME'] = ''; $V['GLPI_PASSWORD'] = ''
} else {
  Ask 'GLPI_USERNAME' $false $true "Login do usuário de serviço (exige 'Habilitar login com credenciais' na API)."
  Ask 'GLPI_PASSWORD' $true $true 'Senha do usuário de serviço.'
  $V['GLPI_USER_TOKEN'] = ''
}
Ask 'GLPI_TIMEZONE' $false $false 'Fuso do servidor GLPI (IANA). Padrão: America/Sao_Paulo'
if (-not $V['GLPI_TIMEZONE']) { $V['GLPI_TIMEZONE'] = 'America/Sao_Paulo' }
Ask 'BOARD_CANCELLED_SOLUTIONTYPE_IDS' $false $false "ID(s) do 'Tipo de solução' que significa CANCELADO (Configurar > Listas suspensas > Tipos de solução; ID na URL). Ex.: 3 ou 3,7"
Ask 'BOARD_AUTH_USER' $false $true 'Usuário para acessar o board no navegador (não é usuário do GLPI).'
do { Ask 'BOARD_AUTH_PASSWORD' $true $true 'Senha do board (mínimo 12 caracteres).' } until ($V['BOARD_AUTH_PASSWORD'].Length -ge 12)

$defaults = @{ BOARD_DONE_DAYS='30'; BOARD_AGE_WARN_HOURS='72'; BOARD_AGE_CRITICAL_HOURS='168'; BOARD_CACHE_SECONDS='300'; BOARD_REFRESH_MIN_INTERVAL_SECONDS='15'; BOARD_AUTH_DISABLED='false' }
foreach ($k in $defaults.Keys) { if (-not $V[$k]) { $V[$k] = $defaults[$k] } }

Write-Host "`nOnde gravar?`n  1) Arquivo .env nesta pasta (desenvolvimento / servidor próprio)`n  2) Variáveis de ambiente do usuário Windows"
$dest = Read-Host 'Opção [1]'
if ($dest -eq '2') {
  foreach ($k in $V.Keys) { [Environment]::SetEnvironmentVariable($k, $V[$k], 'User') }
  Write-Host '✓ Variáveis gravadas no perfil do usuário. Abra um novo terminal para carregá-las.' -ForegroundColor Green
} else {
  $lines = @("# Gerado por scripts/setup-env.ps1 em $(Get-Date -Format s). NÃO versionar.") + ($V.Keys | ForEach-Object { "$_=$($V[$_])" })
  [IO.File]::WriteAllLines($EnvFile, $lines)
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  Write-Host "✓ .env gravado com acesso restrito a $($env:USERNAME)." -ForegroundColor Green
}

if ((Read-Host 'Testar a conexão com o GLPI agora? [S/n]') -notmatch '^[nN]') {
  $h = @{}
  if ($V['GLPI_APP_TOKEN']) { $h['App-Token'] = $V['GLPI_APP_TOKEN'] }
  if ($V['GLPI_USER_TOKEN']) { $h['Authorization'] = "user_token $($V['GLPI_USER_TOKEN'])" }
  else { $h['Authorization'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($V['GLPI_USERNAME']):$($V['GLPI_PASSWORD'])")) }
  $base = $V['GLPI_URL'].TrimEnd('/')
  try {
    $r = Invoke-RestMethod -Uri "$base/initSession" -Headers $h -Method Get
    $h['Session-Token'] = $r.session_token
    try { Invoke-RestMethod -Uri "$base/killSession" -Headers $h | Out-Null } catch {}
    Write-Host '✓ Autenticação OK no GLPI.' -ForegroundColor Green
  } catch {
    Write-Host "✗ Falha: $($_.ErrorDetails.Message)" -ForegroundColor Red
    Write-Host '  ERROR_WRONG_APP_TOKEN_PARAMETER → app token / faixa de IP; ERROR_GLPI_LOGIN_USER_TOKEN → user token inválido;'
    Write-Host '  ERROR_LOGIN_PARAMETERS_MISSING → login por credenciais desabilitado na API.'
  }
}
