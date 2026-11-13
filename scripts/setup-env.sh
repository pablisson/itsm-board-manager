#!/usr/bin/env bash
# Assistente para preencher as variáveis do Board GLPI, uma a uma.
# - Segredos são digitados sem eco (não aparecem na tela nem no histórico do shell).
# - O arquivo .env é criado com permissão 600 (só o seu usuário lê).
# - Nada é enviado a terceiros; o teste opcional fala apenas com o SEU GLPI.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
ENV_FILE=".env"

declare -A V
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r k v; do [[ -z "$k" || "$k" == \#* ]] && continue; V["$k"]="$v"; done < "$ENV_FILE"
  echo "Arquivo .env existente encontrado. ENTER mantém o valor atual."
fi

mask() { local s="$1"; [[ -z "$s" ]] && echo "(vazio)" || echo "definido (${#s} caracteres)"; }

ask() { # nome secreto obrigatório explicação
  local name="$1" secret="$2" required="$3" help="$4" cur="${V[$1]:-}" val=""
  echo; echo "──────── $name ────────"; echo -e "$help"
  if [[ "$secret" == 1 ]]; then
    echo "Atual: $(mask "$cur")"
    read -r -s -p "Valor (não será exibido): " val; echo
  else
    read -r -p "Valor [${cur}]: " val
  fi
  [[ -z "$val" ]] && val="$cur"
  if [[ "$required" == 1 && -z "$val" ]]; then echo "  ✗ Obrigatório."; ask "$@"; return; fi
  V["$name"]="$val"
  [[ "$secret" == 1 ]] && echo "  ✓ $(mask "$val")" || echo "  ✓ $val"
}

echo "=== Configuração do Board GLPI ==="
ask GLPI_URL 0 1 "URL da API REST do GLPI, terminando em /apirest.php.\nEx.: https://glpi.suaempresa.com.br/apirest.php\nVerifique em Configurar > Geral > API (\"URL da API\")."
if [[ ! "${V[GLPI_URL]}" =~ ^https:// && ! "${V[GLPI_URL]}" =~ ^http://(localhost|127\.0\.0\.1) ]]; then
  echo "  ✗ Use HTTPS — tokens trafegam nos cabeçalhos."; ask GLPI_URL 0 1 "Informe a URL com https://"; fi

ask GLPI_APP_TOKEN 1 0 "Token do CLIENTE DA API (identifica este sistema no GLPI).\nConfigurar > Geral > API > Adicionar cliente da API:\n  • Nome: Board Gerencial  • Ativo: Sim\n  • Faixa de IP: restrinja ao IP do servidor onde o board rodará\n  • Token da aplicação (app_token): clique em 'Regenerar' e copie.\nDeixe vazio só se o cliente da API do GLPI não exigir app_token."

echo; echo "Autenticação do usuário de serviço — escolha UM modo:"
echo "  1) Token de API do usuário (RECOMENDADO: revogável, não expõe senha)"
echo "  2) Usuário e senha"
read -r -p "Opção [1]: " mode; mode="${mode:-1}"
if [[ "$mode" == 1 ]]; then
  ask GLPI_USER_TOKEN 1 1 "Crie um usuário dedicado (ex.: svc_board) com perfil SOMENTE LEITURA:\n  Chamados (ver todos), Usuários (ler), Grupos (ler), Tipos de solução (ler).\nDepois, logado como ele: Meus ajustes > Chaves de acesso remoto > Token de API > Regenerar."
  V[GLPI_USERNAME]=""; V[GLPI_PASSWORD]=""
else
  ask GLPI_USERNAME 0 1 "Login do usuário de serviço (dedicado, somente leitura).\nExige 'Habilitar login com credenciais' em Configurar > Geral > API."
  ask GLPI_PASSWORD 1 1 "Senha do usuário de serviço."
  V[GLPI_USER_TOKEN]=""
fi

ask GLPI_TIMEZONE 0 0 "Fuso horário do servidor GLPI (IANA). Padrão: America/Sao_Paulo"
V[GLPI_TIMEZONE]="${V[GLPI_TIMEZONE]:-America/Sao_Paulo}"
ask BOARD_CANCELLED_SOLUTIONTYPE_IDS 0 0 "ID(s) do 'Tipo de solução' que significa CANCELADO (o GLPI não tem status Cancelado).\nConfigurar > Listas suspensas > Tipos de solução > abra o item e veja o ID na URL (id=...).\nVários: 3,7. Vazio = coluna Cancelados mostrará 'não configurado'."
ask BOARD_AUTH_USER 0 1 "Usuário para acessar o board pelo navegador (não é usuário do GLPI)."
ask BOARD_AUTH_PASSWORD 1 1 "Senha do board (mín. 12 caracteres; use um gerenciador de senhas)."
while (( ${#V[BOARD_AUTH_PASSWORD]} < 12 )); do echo "  ✗ Mínimo 12 caracteres."; ask BOARD_AUTH_PASSWORD 1 1 "Senha do board."; done

KEYS=(GLPI_URL GLPI_APP_TOKEN GLPI_USER_TOKEN GLPI_USERNAME GLPI_PASSWORD GLPI_TIMEZONE BOARD_DONE_DAYS BOARD_CANCELLED_SOLUTIONTYPE_IDS BOARD_AGE_WARN_HOURS BOARD_AGE_CRITICAL_HOURS BOARD_CACHE_SECONDS BOARD_REFRESH_MIN_INTERVAL_SECONDS BOARD_AUTH_USER BOARD_AUTH_PASSWORD BOARD_AUTH_DISABLED)
: "${V[BOARD_DONE_DAYS]:=30}" "${V[BOARD_AGE_WARN_HOURS]:=72}" "${V[BOARD_AGE_CRITICAL_HOURS]:=168}" "${V[BOARD_CACHE_SECONDS]:=300}" "${V[BOARD_REFRESH_MIN_INTERVAL_SECONDS]:=15}" "${V[BOARD_AUTH_DISABLED]:=false}"
tmp="$(mktemp .env.XXXX)"
{ echo "# Gerado por scripts/setup-env.sh em $(date -Iseconds). NÃO versionar."; for k in "${KEYS[@]}"; do echo "$k=${V[$k]:-}"; done; } > "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
echo; echo "✓ $ENV_FILE gravado (permissão 600)."

read -r -p "Testar a conexão com o GLPI agora? [S/n]: " t
if [[ "${t:-S}" =~ ^[SsYy]$ ]]; then
  hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT    # cabeçalhos em arquivo: tokens não aparecem em 'ps'
  [[ -n "${V[GLPI_APP_TOKEN]}" ]] && echo "App-Token: ${V[GLPI_APP_TOKEN]}" >> "$hdr"
  if [[ -n "${V[GLPI_USER_TOKEN]}" ]]; then echo "Authorization: user_token ${V[GLPI_USER_TOKEN]}" >> "$hdr"
  else echo "Authorization: Basic $(printf '%s:%s' "${V[GLPI_USERNAME]}" "${V[GLPI_PASSWORD]}" | base64 | tr -d '\n')" >> "$hdr"; fi
  out="$(curl -sS -w '\n%{http_code}' -H @"$hdr" "${V[GLPI_URL]%/}/initSession" || true)"
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "$code" == 200 ]]; then
    st="$(sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p' <<<"$body")"
    echo "Session-Token: $st" >> "$hdr"
    curl -sS -o /dev/null -H @"$hdr" "${V[GLPI_URL]%/}/killSession" || true
    echo "✓ Autenticação OK no GLPI."
  else
    echo "✗ Falha ($code): ${body:0:200}"
    echo "  Dicas: ERROR_WRONG_APP_TOKEN_PARAMETER → app token/faixa de IP do cliente da API;"
    echo "         ERROR_GLPI_LOGIN_USER_TOKEN → user token inválido; ERROR_LOGIN_PARAMETERS_MISSING → login por credenciais desabilitado."
  fi
fi
