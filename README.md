# Board Gerencial GLPI

Kanban de acompanhamento gerencial lido **diretamente da API REST do GLPI** (somente leitura).
Backend **ASP.NET Core 8 (C#)** + frontend **React (Vite/TypeScript)**, publicados como um único serviço.

```
Navegador ──HTTPS + login──► ASP.NET Core (serve o React + /api) ──HTTPS + tokens──► GLPI /apirest.php
```
Os tokens do GLPI ficam **somente no servidor**; o navegador nunca os recebe.

## 1. Colunas e regras

| Coluna | Regra aplicada (GLPI 9.5 / 10.x) |
|---|---|
| 1 · Sem atribuição | Status 1–3 (Novo / Em atendimento) **sem nenhum técnico (usuário) atribuído**. Chamado só com grupo atribuído entra aqui com o alerta "Atribuído só a grupo". |
| 2 · Em andamento | Status 1–3 **com técnico atribuído**, agrupado por técnico. Mostra o tempo aberto e o item mais antigo de cada pessoa. Chamado com 2 técnicos aparece nas duas raias ("Divide com"), mas o KPI conta o chamado uma vez só. |
| 3 · Completos | Status 5 (Solucionado) ou 6 (Fechado) com data de solução nos últimos `BOARD_DONE_DAYS` dias, menos os cancelados. Mostra o tempo de resolução. |
| 4 · Bloqueados | Status 4 (**Pendente**). |
| 5 · Cancelados | Status 5/6 cuja última solução (não recusada) tem **Tipo de solução** em `BOARD_CANCELLED_SOLUTIONTYPE_IDS`. |

**Técnico e observador:** o vínculo vem de `Ticket/{id}/Ticket_User`, e só entra quem tem `type = 2` (Técnico atribuído).
`type = 1` (Requerente) e `type = 3` (Observador) **são descartados**.

**Tempo aberto:** tempo corrido desde a **data de abertura** (`date`), 24×7. Ele é recalculado no navegador a cada minuto.
As cores seguem `BOARD_AGE_WARN_HOURS` (amarelo) e `BOARD_AGE_CRITICAL_HOURS` (vermelho).

## 2. Ambiguidades: decida e ajuste

1. **Cancelado não existe no GLPI.** Não há status nativo. A regra adotada é o *Tipo de solução*. Se a sua equipe cancela de outro jeito (categoria, etiqueta, ticket na lixeira, texto da solução), a coluna precisa de outra regra. **Sem configuração, a coluna mostra "não configurado" e nada é inferido.**
2. **Pendente ≠ bloqueado.** No GLPI, "Pendente" também significa "aguardando o usuário" ou "aguardando fornecedor". O board trata todo Pendente como bloqueado. Se vocês separam os motivos (por exemplo, por categoria ou etiqueta), dá para refinar.
3. **Atribuição só a grupo.** Fica em "Sem atribuição", porque não há uma *pessoa* responsável. Isso aparece sinalizado no card.
4. **Status Novo com técnico.** Acontece por importação ou regra de negócio. O chamado vai para "Em andamento" com o alerta correspondente.
5. **Tempo aberto contado desde a abertura**, e não desde a atribuição ao técnico. O GLPI não expõe a data da atribuição em um campo simples (ela está só no histórico/log).
6. **SLA/horário útil não é considerado.** Para isso seria preciso ler `time_to_resolve` e o calendário da entidade.
7. **Entidades.** O board enxerga o que o perfil do usuário de serviço enxerga, na entidade padrão dele. Dê ao usuário a entidade raiz **com recursão** se quiser ver tudo.
8. **"Pendente desde quando".** Não é exibido (ele está em `begin_waiting_date`, que ainda não é lido).
9. **Fuso horário.** O GLPI grava as datas sem fuso, e `GLPI_TIMEZONE` precisa refletir o fuso do servidor GLPI.

## 3. Variáveis de ambiente

| Variável | Obrigatória | Segredo | Descrição |
|---|---|---|---|
| `GLPI_URL` | sim | não | `https://…/apirest.php` (HTTPS obrigatório) |
| `GLPI_APP_TOKEN` | se o cliente da API exigir | **sim** | Token do cliente da API |
| `GLPI_USER_TOKEN` | um dos modos | **sim** | Token de API do usuário de serviço (**recomendado**, tem prioridade) |
| `GLPI_USERNAME` / `GLPI_PASSWORD` | um dos modos | **sim** (senha) | Alternativa ao user token |
| `GLPI_TIMEZONE` | não | não | Padrão `America/Sao_Paulo` |
| `BOARD_CANCELLED_SOLUTIONTYPE_IDS` | não | não | Ex.: `3` ou `3,7` |
| `BOARD_DONE_DAYS` | não | não | Padrão 30 |
| `BOARD_AUTH_USER` / `BOARD_AUTH_PASSWORD` | **sim** | **sim** (senha) | Login do board no navegador |
| `BOARD_AUTH_DISABLED` | não | não | `true` só se o board estiver atrás de VPN/SSO |

Demais variáveis: veja `.env.example`.

### Preenchimento guiado (uma a uma)
```bash
./scripts/setup-env.sh
```
```powershell
.\scripts\setup-env.ps1
```
Os segredos são digitados sem eco. O `.env` é gravado com permissão restrita, e o script oferece um teste de autenticação no GLPI.

### Boas práticas de segurança
- Crie um **usuário de serviço dedicado** (ex.: `svc_board`) com um **perfil somente leitura**: Chamados → *Ver todos*; Usuários, Grupos e Tipos de solução → *Ler*. **Nunca** use uma conta pessoal ou de administrador.
- Prefira **`GLPI_USER_TOKEN`**: ele é revogável e não expõe senha. Deixe `GLPI_USERNAME`/`GLPI_PASSWORD` vazios.
- No cliente da API do GLPI, restrinja a **faixa de IP** ao servidor do board.
- **Nunca** versione o `.env`, que já está no `.gitignore`. Em produção, cadastre as variáveis no painel da hospedagem (App Settings, Secrets etc.), e não em arquivo.
- Faça rotação dos tokens periodicamente e sempre que alguém com acesso sair da equipe.
- O endpoint `/api/config-status` mostra apenas **se** cada variável está definida, nunca o valor.

## 4. Rodar localmente
```bash
cd frontend
```
```bash
npm ci
```
```bash
npm run build
```
O build sai em `backend/GlpiBoard.Api/wwwroot`.
```bash
cd ../backend/GlpiBoard.Api
```
```bash
dotnet run --urls http://localhost:5080
```
O `dotnet run` lê o `.env` da raiz do projeto. Depois, abra http://localhost:5080.
Para desenvolver o front com hot reload, rode `npm run dev` em `frontend/` com o backend rodando em `:5080`.

## 5. Publicar (acesso de qualquer computador)

> ⚠️ **Pré-requisito crítico:** o servidor do board precisa **alcançar o GLPI**. Se o GLPI está só na rede interna, um host na nuvem não vai conseguir chegar até ele.

| Cenário | Recomendação |
|---|---|
| GLPI só na rede interna | Publicar no **IIS de um servidor interno** e expor via proxy reverso com HTTPS ou via VPN |
| GLPI acessível pela internet | **Azure App Service**, Render, Railway, Fly.io ou uma VM com Docker |

**Docker Compose** (recomendado — app + banco do Planejamento):
```bash
docker compose up -d --build
```
O board sobe em `http://localhost:5080` e o PostgreSQL do Planejamento fica no volume nomeado `itsm-board-plan-data`.
Os dados sobrevivem a restart, `docker compose down`, rebuild e reinício da máquina (os dois serviços usam `restart: unless-stopped`).
Defina `PLAN_DB_PASSWORD` no `.env` antes da primeira subida.

> ⚠️ **Nunca** use `docker compose down -v`: o `-v` apaga o volume com o planejamento.

Backup e restauração do planejamento:
```bash
docker compose exec -T db pg_dump -U board board > backup-planejamento.sql
docker compose exec -T db psql -U board -d board < backup-planejamento.sql
```
Para rodar o app fora do Docker (desenvolvimento), suba só o banco com `docker compose up -d db`. O app usa `PLAN_DB_HOST=localhost` e `PLAN_DB_PORT=5433`.

**Docker sem compose** (sem a aba Planejamento, ou com um PostgreSQL externo via `PLAN_DB_*`):
```bash
docker build -t glpi-board .
```
```bash
docker run -d -p 8080:8080 --env-file .env --restart unless-stopped glpi-board
```
Coloque um proxy com HTTPS na frente (Nginx, Caddy, Traefik ou o TLS do próprio provedor). O login Basic exige HTTPS.

**IIS:** rode `dotnet publish -c Release -o publish` depois de buildar o front. Instale o *ASP.NET Core Hosting Bundle 8* e defina as variáveis em *Configuration Editor → system.webServer/aspNetCore → environmentVariables* ou nas variáveis do App Pool.

**Azure App Service:** use o deploy do container ou do `publish`. Cadastre as variáveis em *Configuração → Configurações de aplicativo* (ou referências ao Key Vault).

## 6. Endpoints
- `GET /api/board`: snapshot em cache (`BOARD_CACHE_SECONDS`).
- `GET /api/reports/sla?from=AAAA-MM&to=AAAA-MM`: tickets abertos no período (até 12 meses) com prazos de SLA, flags "excedido" do ITSM e tempos (assumido, solução útil, pendente, lançado em tarefas). Base da aba **Relatórios SLA**.
- `GET /api/plan?month=AAAA-MM`: itens planejados do mês (técnico × dia), mais a contagem de dias planejados por ticket.
- `POST /api/plan` `{techId, techName, ticketId, title, day}`: planeja um ticket num dia. `PUT /api/plan/{id}` `{day}` move o item. `DELETE /api/plan/{id}` remove o item.
- `GET /api/plan/health`: diz se o banco do planejamento está configurado e acessível.
- `POST /api/board/refresh`: botão **Ressincronizar**. Força a leitura no GLPI, com no máximo 1 leitura a cada `BOARD_REFRESH_MIN_INTERVAL_SECONDS` para proteger o GLPI.
- `GET /api/config-status`: diagnóstico da configuração (sem valores).
- `GET /healthz`: health check público.

Se o GLPI falhar, o board continua mostrando a **última leitura válida** e exibe o erro com a data e a hora da falha.
