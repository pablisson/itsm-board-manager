# Board Gerencial GLPI

**Painel de gestão para equipes de suporte que usam o GLPI.** Ele transforma os chamados do ITSM em um quadro visual, em relatórios de desempenho e em planejamento da equipe, e ainda inclui um módulo de gestão de projetos integrado ao GLPI.

Feito para quem **coordena** um time de atendimento: gerente de projetos, coordenador de suporte ou líder técnico. Quem gerencia precisa enxergar a operação inteira sem montar planilha e sem abrir chamado por chamado.

![.NET 8](https://img.shields.io/badge/.NET-8-512BD4) ![React 19](https://img.shields.io/badge/React-19-61DAFB) ![MySQL 8.4](https://img.shields.io/badge/MySQL-8.4-4479A1) ![GLPI 9.5 / 10](https://img.shields.io/badge/GLPI-9.5%20%2F%2010-orange) ![Docker](https://img.shields.io/badge/Docker-compose-2496ED)

---

## Sumário

- [Por que este projeto existe](#por-que-este-projeto-existe)
- [Ganhos para o gerente de projetos](#ganhos-para-o-gerente-de-projetos)
- [Funcionalidades](#funcionalidades)
- [Como usar](#como-usar)
- [Funcionalidades futuras](#funcionalidades-futuras)
- [Arquitetura e segurança](#arquitetura-e-segurança)
- [Documentação técnica](#documentação-técnica)

---

## Por que este projeto existe

O GLPI é ótimo para **registrar** chamados, mas responder a perguntas de gestão exige exportar dados e montar planilhas. Perguntas como estas:

- *O que está parado agora, e com quem?*
- *Quem está sobrecarregado e quem tem espaço para mais?*
- *Quanto tempo levamos para começar a atender? E para resolver?*
- *Que tipo de problema cada técnico domina? Onde temos uma pessoa só que sabe resolver?*
- *Quais clientes mais abrem chamados, e por quê?*

O Board Gerencial lê os dados **diretamente da API do GLPI** e responde a essas perguntas em telas prontas, atualizadas e com filtros. O GLPI continua sendo a fonte oficial: o board não altera nenhum chamado.

---

## Ganhos para o gerente de projetos

| Ganho | Como o board entrega |
|---|---|
| **Visão da operação em segundos** | Um quadro Kanban com todos os chamados por situação e por técnico, com alertas visuais de tempo aberto e de SLA. |
| **Fim das planilhas manuais** | Relatórios mensais, de SLA, de desempenho e por técnico, gerados do GLPI com um clique e exportáveis em CSV. |
| **Distribuição justa da carga** | Mostra quantos chamados cada técnico tem em andamento, qual é o mais antigo e quanto cada um resolveu no período. |
| **Decisão baseada em tempos reais** | Tempo médio e mediano até iniciar o atendimento e até a solução, em horário útil (o mesmo do SLA) ou corrido. |
| **Mapa de conhecimento do time** | Matriz técnico × tema mostra quem já atendeu cada assunto. Revela pontos únicos de conhecimento e orienta treinamentos e substituições em férias. |
| **Atendimento proativo aos clientes** | Problemas mais recorrentes por cliente e requerentes que mais abrem chamados, para atacar a causa e não só o sintoma. |
| **Planejamento da semana** | Agenda técnico × dia com os chamados planejados, para fazer a reunião diária com dados. |
| **Projetos sob controle** | Cronograma com Gantt, dependências, marcos e planejado × realizado, sincronizado com o módulo de Projetos do GLPI. |
| **Prestação de contas** | Números consistentes para reuniões com a diretoria e com clientes: volume, prazos, atendimento em paralelo e evolução mês a mês. |

---

## Funcionalidades

### 1. Board de chamados (Kanban)
- **Colunas:** Sem atribuição · Em andamento (uma raia por técnico) · Bloqueados (Pendente) · Completos · Cancelados.
- **Tempo aberto** em cada card, com cores de alerta configuráveis (amarelo e vermelho).
- **Situação de SLA:** prazos de primeiro atendimento e de solução, com destaque para os atrasados e os que estão perto de vencer.
- **Sinais de atenção:** chamado atribuído só a grupo, status incoerente e chamado dividido entre técnicos.
- **Filtros:** texto livre (#id, título, técnico, grupo, entidade), entidades e técnicos, com a seleção memorizada.
- **Proteção do GLPI:** a leitura fica em cache e a ressincronização manual tem intervalo mínimo. Se o GLPI cair, a tela mostra a última leitura válida.

### 2. Entidades
- Visão dos chamados por cliente ou entidade, para saber rapidamente onde está a demanda.

### 3. Linha do tempo por técnico
- Histórico de cada chamado do técnico: mudanças de status, acompanhamentos, tarefas, soluções e atribuições, em ordem cronológica.

### 4. Planejamento (técnico × dia)
- Agenda mensal com os chamados planejados para cada técnico em cada dia.
- Arrastar para mover, copiar o planejamento de um dia e preencher a partir do backlog.
- **Importar os chamados solucionados** do GLPI no dia da solução, para comparar o planejado com o realizado.

### 5. Relatórios
| Relatório | O que responde |
|---|---|
| **Relatório mensal** | Chamados abertos por entidade e por mês. Mostra a tendência de demanda de cada cliente. |
| **Relatórios de SLA** | Por técnico: prazos de SLA, chamados que estouraram o prazo, tempo até ser assumido, tempo de solução e tempo pendente. |
| **Desempenho** | Para qualquer período: chamados resolvidos por técnico e por dia, tempos médios e medianos (horário útil ou corrido), os 10 mais lentos para iniciar e para resolver, os 10 mais rápidos e o **atendimento em paralelo** na mesma empresa (pico de simultaneidade e técnicos envolvidos). |
| **Por técnico** | Temas e categorias que cada técnico já atendeu (matriz de cobertura), empresas atendidas, problemas mais recorrentes em cada empresa, requerentes atendidos e quem mais abre chamados. |

Todos os relatórios têm escolha de período, gráficos com detalhes ao passar o mouse e exportação em **CSV**.

> **Classificação inteligente de temas:** muitos chamados ficam registrados só no 1º nível da categoria ou sem categoria nenhuma. Nesses casos, o relatório Por técnico **deduz o 2º nível pelo título**, aprendendo com os chamados já bem classificados. A dedução só é aplicada com alta confiança e com uma palavra-chave forte; nos testes, acertou de 93% a 99%. Os chamados deduzidos aparecem marcados, e um botão mostra só a categoria original do GLPI.

### 6. Gestão de Projetos
- Projetos por entidade, com tarefas e subtarefas em até 3 níveis, criadas e reorganizadas pelo teclado (`Enter`, `Tab`, `Shift+Tab`).
- **Quatro datas por tarefa:** início e fim planejados e executados.
- **Dependências:** término→início, início→início, término→término e início→término, com folga. Mostra conflitos e ajusta datas.
- **Marcos** com situação calculada: no prazo, em risco, atrasado ou atingido.
- **Planejado × realizado** por tarefa e por projeto, ponderado pela duração das tarefas.
- Checklist e anexos em cada tarefa.
- **Gráfico de Gantt** com as barras de planejado e executado, dependências e linha de hoje, e **exportação em PDF** (A3 paisagem).
- **Integração com o GLPI:** cria projeto, tarefas, equipe e dependências no módulo de Projetos e sincroniza nos dois sentidos.

---

## Como usar

### Pré-requisitos
- GLPI 9.5 ou 10.x com a **API REST habilitada**: *Configurar → Geral → API*.
- Um **usuário de serviço** no GLPI com perfil **somente leitura**: chamados (ver todos), usuários, grupos, categorias e tipos de solução. Para a integração de projetos, o perfil também precisa de escrita no módulo Projetos.
- Docker e Docker Compose. Também é possível rodar sem Docker, com .NET 8, Node 22 e MySQL 8.

### 1. Configure
```bash
git clone <url-deste-repositório>
cd itsm-board-manager
cp .env.example .env
```
Preencha o `.env`: o endereço da API do GLPI, os tokens, o login do board e a senha do banco. Também dá para usar o assistente, que pede um valor por vez e testa a conexão:
```bash
./scripts/setup-env.sh        # Linux / macOS
.\scripts\setup-env.ps1       # Windows
```

### 2. Suba
```bash
docker compose up -d --build
```
Abra **http://localhost:5080** e entre com o usuário e a senha definidos em `BOARD_AUTH_USER` e `BOARD_AUTH_PASSWORD`.

### 3. Use no dia a dia
| Momento | Onde ir | O que fazer |
|---|---|---|
| **Início do dia** | Board | Ver o que está sem técnico, o que está bloqueado e os SLAs perto de vencer. Distribuir os chamados. |
| **Reunião diária** | Planejamento | Revisar o que cada técnico planejou para hoje e mover o que ficou para trás. |
| **Acompanhamento de um técnico** | Linha do tempo | Ver o histórico recente dos chamados dele. |
| **Fechamento da semana ou do mês** | Desempenho | Volume resolvido, tempos médios, chamados mais lentos e atendimento em paralelo. |
| **Gestão do time** | Por técnico | Mapa de conhecimento, clientes atendidos e requerentes. Define treinamentos e redistribui temas. |
| **Reunião com cliente ou diretoria** | Relatório mensal e SLA | Tendência de demanda e cumprimento de prazos, exportados em CSV. |
| **Projetos** | Gestão de Projetos (clique no título da página) | Atualizar tarefas, conferir o Gantt e sincronizar com o GLPI. |

> **Dica:** os filtros do topo (texto, entidades e técnicos) valem para todas as abas e ficam memorizados no navegador.

### 4. Publique para a equipe
O board pode rodar em um servidor interno (IIS ou Docker) ou na nuvem (Azure App Service, VM com Docker etc.). O servidor só precisa alcançar o GLPI e estar atrás de **HTTPS**. O passo a passo completo está em [docs/INSTALACAO.md](docs/INSTALACAO.md#5-publicar-acesso-de-qualquer-computador).

---

## Funcionalidades futuras

### Planejadas

| # | Funcionalidade | Descrição | Ganho esperado |
|---|---|---|---|
| 1 | **Login integrado pelo GLPI** | Cada pessoa entra com o próprio usuário do GLPI (credenciais ou token pessoal), no lugar do login único do board. O que cada um vê respeita o perfil e as entidades dele no GLPI. | Acesso individual e auditável, sem senha compartilhada. Cada técnico vê o próprio painel e o gestor vê tudo. |
| 2 | **Criação de chamados** | Abrir chamados direto pelo board, com entidade, categoria, requerente, urgência e descrição, gravados no GLPI pela API. | Registro mais rápido, inclusive de demandas que chegam por telefone ou em reunião, sem trocar de sistema. |
| 3 | **Fila e técnico definidos automaticamente pela categoria** | Regras *categoria → fila (grupo) → técnico*. Quando um chamado chega, o board escolhe o técnico considerando quem domina o tema (matriz de cobertura), a carga atual e a disponibilidade no Planejamento, e grava a atribuição no GLPI. | Fim da triagem manual, menor tempo até o início do atendimento e distribuição equilibrada da carga. |

### Em avaliação (sugestões)

| Funcionalidade | Descrição |
|---|---|
| **Alertas de SLA** | Aviso por e-mail ou Microsoft Teams quando um chamado está perto de estourar o prazo ou está sem técnico há muito tempo. |
| **Sugestão de categoria** | Usar a mesma inferência dos relatórios para sugerir a categoria correta no momento da abertura e na revisão dos chamados mal classificados. |
| **Capacidade da equipe** | Comparar horas planejadas com horas disponíveis por técnico (férias, plantões) e alertar sobrecarga antes que ela aconteça. |
| **Relatórios agendados** | Envio automático do resumo semanal ou mensal (Desempenho e SLA) para gestores e clientes. |
| **Problemas recorrentes → Problema ITIL** | Detectar grupos de chamados repetidos no mesmo cliente e tema e propor a abertura de um *Problema* no GLPI. |

---

## Arquitetura e segurança

```
Navegador ──HTTPS + login──► ASP.NET Core 8 (React + /api) ──HTTPS + tokens──► GLPI /apirest.php
                                       │
                                       └──► MySQL 8.4 (planejamento e projetos)
```

- **Backend:** ASP.NET Core 8 (C#, minimal API). **Frontend:** React 19 + Vite + TypeScript. **Banco:** MySQL 8.4, usado só para os dados próprios do board (planejamento e projetos).
- Os tokens do GLPI ficam **apenas no servidor**; o navegador nunca os recebe.
- A leitura de chamados é **somente leitura**. Escrita no GLPI acontece apenas na integração de projetos, por ação explícita do usuário.
- O board exige login e HTTPS. As alterações pela API exigem um cabeçalho específico, como proteção contra CSRF.
- Segredos ficam no `.env` (fora do versionamento) ou no cofre de segredos da hospedagem.
- Cabeçalhos de segurança (CSP, X-Frame-Options, nosniff) vêm ativados.

---

## Documentação técnica

O guia completo está em **[docs/INSTALACAO.md](docs/INSTALACAO.md)**:
- regras de cada coluna do board e decisões de interpretação do GLPI;
- variáveis de ambiente e boas práticas de segurança;
- execução local, publicação (Docker, IIS, Azure), backup e restauração;
- detalhes do módulo de Gestão de Projetos;
- referência das rotas da API.

---

## Contribuindo

Sugestões e correções são bem-vindas: abra uma *issue* descrevendo o cenário ou envie um *pull request*. Para mudanças maiores, descreva a proposta numa *issue* antes.
