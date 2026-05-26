# 🎭 Multi-Agent Orchestration — Jarvis como Orquestrador

> **Objetivo:** transformar Jarvis (agente principal do OpenClaw) num orquestrador real que delega para especialistas (programação, escrita, design, análise…), revisa o resultado contra preferências aprendidas do usuário, e entrega um briefing final. Inclui dashboard de monitoramento em tempo real e Office3D reativo.

> **Princípio inegociável:** todo recurso novo deve sobreviver a um `git clone + install` 1-clique. Defaults sãos, downloads pesados sob demanda, SQLite local.

> **Status do documento:** 🎯 **TODAS AS 4 FASES IMPLEMENTADAS** (2026-05-25 → 2026-05-26). Plano concluído com 100% dos entregáveis + smoke tests verdes. TypeScript clean em todas as fases.

---

## 📊 Status & Contexto

- **Início do planejamento:** 2026-05-25
- **Inspiração arquitetural:** [Autensa / Mission-Control](https://github.com/crshdn/mission-control) — projeto que também roda sobre OpenClaw Gateway
- **Roadmap relacionado:** [jarvis-roadmap.md](./jarvis-roadmap.md) — esta feature avança Camada 2 (event bus) + Camada 5 (orquestração)
- **Estimativa total:** 14-18 dias úteis (4 fases)

---

## 🎚️ Meta-Regra Global — Modo Autônomo

> **Princípio condutor:** o sistema precisa ser simples pro leigo entender, mas com profundidade pro usuário técnico controlar. A linha de corte é uma flag global de autonomia.

**Flag em settings:** `autonomous_mode: boolean` (default: `false`)

| Etapa | `autonomous_mode = false` (técnico, default) | `autonomous_mode = true` (leigo) |
|---|---|---|
| Plano de execução (decompose) | Jarvis mostra DAG → usuário aprova/edita/rejeita | Jarvis executa direto |
| Entrega final | Marca "aguardando aprovação" → thumbs up/down | Entrega direto + briefing |
| Cost cap excedido | Pausa + pergunta se libera | Pausa silenciosamente + notifica no inbox |
| Re-delegação após review rejeitado | Pergunta se concorda com correções | Re-delega automaticamente |

**Onde aparece a flag:**
- `/settings` — toggle "Modo Autônomo (deixar Jarvis decidir tudo)"
- Aviso visual no header quando ON (badge "🚀 Autônomo")
- Por agente: opção opcional de override (`override_autonomous: "inherit" | "force_manual" | "force_auto"`) — usuários avançados podem forçar manual em tarefas sensíveis (ex: dev em produção sempre pede aprovação)

**Cobertura:** essa regra atravessa todas as fases. Onde houver "Jarvis pergunta", existe o atalho do modo autônomo.

---

## 🔍 Diagnóstico — Estado Atual

### ✅ O que JÁ existe (não refazer)

| Componente | Local |
|---|---|
| CRUD de agentes + LLM por agente (primary/fallback) | [src/app/api/agents/route.ts:285-296](../src/app/api/agents/route.ts#L285-L296) |
| Campo declarativo `subagents.allowAgents[]` | [src/app/api/agents/route.ts:293-295](../src/app/api/agents/route.ts#L293-L295) |
| Organograma SVG de hierarquia | [src/components/AgentOrganigrama.tsx](../src/components/AgentOrganigrama.tsx) |
| Chat streaming SSE multi-agente | [src/app/api/chat/stream/route.ts](../src/app/api/chat/stream/route.ts) |
| Activities SSE (eventos globais) | [src/app/api/activities/stream/route.ts](../src/app/api/activities/stream/route.ts) |
| Skills scanner (`~/.openclaw/agents/skills/*.md`) | [src/lib/skill-parser.ts](../src/lib/skill-parser.ts) |
| Office3D com estados `working/idle/thinking/error` | [src/components/Office3D/Office3D.tsx:75-78](../src/components/Office3D/Office3D.tsx#L75-L78) |
| Memória SQLite (`agent_memory.db`) + ingest histórico | commit `8e6c533` |
| Wake word + voz (Camada 1 do roadmap) | commit `aad0be2` |

### ❌ Gaps críticos para "Jarvis orquestrando"

| # | Gap | Por quê bloqueia |
|---|---|---|
| 1 | Sem runtime de delegação inter-agente | `allowAgents` é só metadata; não existe `POST /api/tasks/delegate` |
| 2 | Sem fila de tarefas com status rico | Sem como rastrear "em voo", "aguardando review", "rejeitada" |
| 3 | Sem campo `role`/`specialty` no agente | Jarvis não sabe que "dev" = programador (hoje infere por nome) |
| 4 | Sem tool definitions de delegação no prompt do Jarvis | LLM não recebe `delegate_to(agent_id, task)` como ferramenta |
| 5 | Sem callback/review loop | Sub-agente termina, resultado vira arquivo no workspace; não volta ao pai |
| 6 | Sem dashboard de tasks em flight | `/agents` mostra cards estáticos |
| 7 | Office3D não reage a tarefa real | Lê `currentTask` como string, sem animação de "trabalhando" |
| 8 | Status binário online/offline (mtime hack) | Não distingue "ocioso", "pensando", "delegando", "esperando review" |
| 9 | Sem inter-agent comm (mailbox) | Sub-agentes não conseguem coordenar entre si |
| 10 | Sem cost caps | Multi-agente = multi-custo, risco de surpresa no fim do mês |
| 11 | Sem preference model | Jarvis não sabe "o que o usuário vai gostar" |

---

## 🧭 Ideias absorvidas do Mission-Control / Autensa

| Ideia | Aplicação no AtlasDeck |
|---|---|
| **7-status flow** (Planning → Inbox → Assigned → In Progress → Testing → Review → Done) | Adotar tal qual no schema de `tasks.db`. "Planning" é onde Jarvis decompõe; "Review" é onde Jarvis avalia antes de entregar. |
| **Convoy Mode** com DAG (`depends_on: string[]`) | Pra "implementa feature X" o paralelismo backend+frontend+tests é natural. Schema desde Fase 1, UI na Fase 3. |
| **Mailbox SQLite** (`agent_mailbox`) | Tabela com `from_agent_id`, `to_agent_id`, `subject`, `body`, `read_at`. Polling no checkpoint do sub-agente + broadcast SSE. |
| **Queued Notes + Direct Messages** | Operator Chat: Queued = "entrega no próximo checkpoint", Direct = "interrompe agora". Cobre o "Jarvis vai entregar como vou gostar" — usuário corrige durante. |
| **Per-task `openclaw_sessions`** | Cada task gera sessão OpenClaw isolada. Hoje sessão é compartilhada → contexto polui. |
| **Cost caps** (daily/monthly) | Estender [data/usage-tracking.db](../data/usage-tracking.db). Auto-pause dispatch quando excede. |
| **Agent health table** (heartbeat real) | Substitui o hack de `mtime do memory.md < 5min`. |
| **Workspace ports & merges** | Sub-agentes paralelos em workspaces isolados (`workspace/tasks/<task_id>/`), merge no fim. |
| **Learner Agent + Preference Model** | Cron que olha aprovações/rejeições + thumbs up/down + sinal implícito do chat. Ajusta prompts dos especialistas. |
| **Work checkpoints** (crash recovery) | Se OpenClaw daemon morre no meio, retomada do último checkpoint. |
| **Dependency Graph UI** | Visual DAG dos subtasks na aba Live Mission. |

---

## 📋 Templates de Especialistas (pré-prontos, ativação 1-clique)

> Templates ficam em `data/agent-templates.json` (versionado no repo). Usuário escolhe na UI "Adicionar agente → A partir de template". O template gera o agente com prompt + personalidade + skills sugeridas, mas **tudo editável depois**. Templates não criam agentes sozinhos.

### Templates iniciais

| Template | Role | Specialty | Skills sugeridas | Personalidade default |
|---|---|---|---|---|
| 👨‍💻 **dev** | specialist | `["coding", "debugging", "refactoring"]` | git-workflow, code-review, testing | Técnico, direto, mostra trade-offs |
| ✍️ **writer** | specialist | `["writing", "docs", "marketing-copy"]` | markdown-formatting, tone-adapt | Criativo, adapta tom ao público |
| 📊 **analyst** | specialist | `["data-analysis", "reporting", "metrics"]` | sql, charts, summarization | Objetivo, baseado em evidência |
| 🎨 **designer** | specialist | `["ui-ux", "wireframes", "design-feedback"]` | mockup-gen, color-theory | Visual, prioriza usabilidade |
| 🔍 **researcher** | specialist | `["web-research", "comparison", "tech-evaluation"]` | web-search, fact-check | Cético, cita fontes |
| 📅 **pm** | specialist | `["planning", "prioritization", "coordination"]` | task-decomposition, deadline-mgmt | Organizado, foco em entrega |
| 🛡️ **reviewer** | reviewer | `["code-review", "content-review", "security"]` | security-audit, style-check | Crítico construtivo |

### Skills herdadas do Jarvis

- Jarvis tem um conjunto base de skills (ex: `web-search`, `read-memory`, `send-notification`)
- **Toggle por agente:** `inherit_jarvis_skills: boolean` (default: `true`)
- Quando ativo, sub-agente recebe automaticamente acesso às skills do Jarvis + as suas próprias
- UI: checkbox no modal de edição do agente "Herdar skills do Jarvis"

### Como funciona o "ativar template"

1. UI em `/agents` → botão "➕ Adicionar agente" → modal com 2 abas: "Em branco" / "A partir de template"
2. Aba template lista os 7 acima com preview do prompt + skills
3. Clicar em template pré-preenche o form (nome, role, specialty, prompt, skills sugeridas)
4. Usuário pode editar QUALQUER campo antes de salvar (prompt, personalidade, modelo LLM, skills)
5. Após salvar, é um agente normal — sem amarra ao template

---

## 🗺️ Plano em 4 Fases

### **Fase 1 — Fundação de tasks + mailbox** (~4-5 dias)

**Modelo de dados (`data/tasks.db`):**

```sql
-- Schema esboçado, ajustar na implementação

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT REFERENCES tasks(id),  -- NULL = root
  delegated_by TEXT,                         -- agent_id que delegou
  assigned_to TEXT,                          -- agent_id que executa
  status TEXT NOT NULL,                      -- planning|inbox|assigned|in_progress|testing|review|done|failed|cancelled
  prompt TEXT NOT NULL,
  result TEXT,
  review_verdict TEXT,                       -- approved|rejected|needs_revision
  review_notes TEXT,
  cost_cents INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  depends_on TEXT,                           -- JSON array of task IDs
  workspace_path TEXT,                       -- isolado: workspace/tasks/<task_id>/
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT                              -- JSON: custom fields
);

CREATE TABLE agent_mailbox (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),         -- contexto opcional
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL,                -- queued_note|direct_message|inter_agent|review_feedback
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  delivered_at INTEGER
);

CREATE TABLE agent_health (
  agent_id TEXT PRIMARY KEY,
  last_heartbeat INTEGER NOT NULL,
  current_task_id TEXT,
  state TEXT NOT NULL,                       -- idle|thinking|working|delegating|reviewing|stuck|offline
  state_changed_at INTEGER NOT NULL,
  metadata TEXT                              -- JSON
);

CREATE TABLE work_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  checkpoint_data TEXT NOT NULL,             -- JSON snapshot
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_mailbox_recipient ON agent_mailbox(to_agent_id, read_at);
CREATE INDEX idx_health_state ON agent_health(state);
```

**Mudança no schema de agente** (em [src/app/api/agents/route.ts](../src/app/api/agents/route.ts)):
- Adicionar `role: "orchestrator" | "specialist" | "reviewer"`
- Adicionar `specialty: string[]` (ex: `["coding", "python", "typescript"]`)
- Adicionar `inherit_jarvis_skills: boolean` (default: `true`)
- Adicionar `override_autonomous: "inherit" | "force_manual" | "force_auto"` (default: `inherit`)
- Adicionar `cost_caps: { per_task_cents, per_day_cents }`
- Armazenar em local storage (não em openclaw.json — schema strict)

**Workspace por task (isolamento):**
- Cada task tem workspace dedicado em `workspace/tasks/<task_id>/`
- Sub-agente trabalha lá; merge no workspace do agente quando task aprovada
- Evita corrupção cruzada quando Jarvis delega 3 tasks em paralelo

**Endpoints novos:**
- `POST /api/tasks/delegate` — cria task, status `inbox`, dispara dispatcher
- `GET /api/tasks` — lista com filtros (status, agent, parent)
- `GET /api/tasks/:id` — detalhe + filhos
- `POST /api/tasks/:id/checkpoint` — sub-agente reporta progresso
- `POST /api/tasks/:id/complete` — sub-agente sinaliza fim
- `POST /api/tasks/:id/review` — Jarvis aprova/rejeita
- `POST /api/tasks/:id/approve` — usuário aprova entrega final (thumbs up/down)
- `POST /api/mailbox/send` — envia mensagem
- `GET /api/mailbox/unread?agent_id=X` — busca não-lidas
- `POST /api/agents/:id/heartbeat` — agente reporta vida
- `GET /api/agents/:id/health` — estado atual

**Entregáveis Fase 1:**
- [x] `data/tasks.db` (schema + migrations) — auto-criado em `getDb()` com 3 tabelas: `tasks`, `agent_mailbox`, `work_checkpoints`, `agent_health`
- [x] `src/lib/tasks-db.ts` (CRUD) — createTask, listTasks, updateTask, addTaskUsage, checkpoints, stats, getAgentCostToday, getDispatchableChildren (DAG)
- [x] `src/lib/mailbox-db.ts` (CRUD) — sendMail, getUnreadFor, flushUnreadForDispatch (flush+format atomic), markRead/Delivered
- [x] `src/lib/agent-health.ts` (heartbeat + state machine) — 7 estados, STUCK/OFFLINE thresholds, sweepStaleStates() cron-ready
- [x] `src/lib/task-workspace.ts` — fallback automático: `OPENCLAW_DIR/workspace/tasks/` em prod, `data/task-workspaces/` em dev
- [x] Endpoints: `/api/tasks/*` (route, delegate, [id], checkpoint, complete, review, approve), `/api/mailbox/*`, `/api/agents/:id/heartbeat`, `/api/agents/:id/health`
- [x] Migração de agentes — `agents-meta.ts` (local storage fora do openclaw.json strict schema): `role`, `specialty[]`, `inherit_jarvis_skills`, `override_autonomous`, `cost_caps`, `template_id`
- [x] `data/agent-templates.json` (7 templates: dev, writer, analyst, designer, researcher, pm, reviewer)
- [x] UI: `AgentTemplatePicker` no modal + seção "Orquestração" colapsável com role/specialty/inherit/cost caps

---

### **Fase 2 — Jarvis orquestrador + Planning + Operator Chat** (~4-5 dias)

**Tool definitions injetadas no system prompt do Jarvis:**

```typescript
const ORCHESTRATOR_TOOLS = [
  {
    name: "delegate_to",
    description: "Delega uma tarefa para um sub-agente especialista",
    parameters: { agent_id: "string", task: "string", context: "string?" }
  },
  {
    name: "decompose",
    description: "Decompõe uma tarefa complexa em subtasks com dependências",
    parameters: { parent_task: "string", subtasks: "Subtask[]" }
  },
  {
    name: "check_progress",
    description: "Consulta status de tarefa(s) em voo",
    parameters: { task_id: "string?" }
  },
  {
    name: "send_note",
    description: "Envia mensagem para um sub-agente em execução",
    parameters: { agent_id: "string", note: "string", urgent: "boolean" }
  },
  {
    name: "review",
    description: "Avalia resultado de subtask",
    parameters: { task_id: "string", verdict: "approved|rejected|needs_revision", notes: "string?" }
  },
  {
    name: "notify_user",
    description: "Avisa o usuário via canal preferido (chat/telegram)",
    parameters: { message: "string", task_id: "string?", channels: "string[]?" }
  },
];
```

**Fluxo de execução (assíncrono, com Modo Autônomo):**

1. Usuário pede "Jarvis, refatora o módulo X"
2. Jarvis decompõe → DAG de subtasks
3. **Se `autonomous_mode = false`:** mostra plano no chat, pergunta "aprovo / replanejar / cancelar"
4. **Se `autonomous_mode = true`:** mostra plano resumido + executa imediatamente
5. **Jarvis pode delegar autonomamente sempre** — mas se usuário pedir explicitamente "passa pro dev", obedece
6. Jarvis responde: "Trabalho iniciado, acompanhe no dashboard"
7. Dashboard Kanban mostra tasks evoluindo em tempo real (colunas: Planning → Inbox → Assigned → In Progress → Testing → Review → Done)
8. Quando sub-agente completa → review do Jarvis (LLM call com contexto de preferências)
9. **Aprovação humana antes de "Done"** (sempre, exceto se `autonomous_mode = true`):
   - Status fica em `review` aguardando
   - Jarvis notifica via canal acionado (chat + Telegram se foi por lá)
   - Usuário dá 👍/👎 + comentário opcional
   - 👍 → Done. 👎 → volta pra `assigned` com correções
10. Telegram: quando acionado por lá, Jarvis avisa lá mesmo quando inicia + quando entrega

**Preference Model (aprendizado):**
- Sinal explícito: thumbs up/down nas entregas
- Sinal implícito: LLM extrai sentimento das respostas do usuário ("perfeito" vs "não era isso")
- Tabela `learnings` no `agent_memory.db`: `(id, agent_id, pattern, evidence, confidence, created_at)`
- Learner cron lê e ajusta system prompts dos especialistas (Fase 4)

**Operator Chat UI (painel lateral persistente no `/agents`):**
- Estilo Slack: lista de tasks ativas à esquerda, conversa à direita
- Toggle por mensagem: 🟡 Queued Note (entrega no próximo checkpoint) ou 🔴 Direct (interrompe agora)
- Histórico persistido em `agent_mailbox` (message_type = `queued_note` ou `direct_message`)
- Sempre visível enquanto está em `/agents` (independente de aba ativa: Cards/Organograma/Live Mission)
- Botão flutuante "💬" pra colapsar/expandir

**Cost caps:**
- Por agente: `cost_caps.per_task_cents`, `cost_caps.per_day_cents`
- Dispatcher consulta antes de iniciar task; se excedeu, pausa
- `autonomous_mode = false` → pergunta se libera. `autonomous_mode = true` → pausa silenciosamente + notifica.
- UI de config em `/agents` (editar agente)

**Entregáveis Fase 2:**
- [x] Tool definitions + injetadas via `orchestrator-injector.ts` no `MEMORY.md` do orquestrador (OpenClaw lê em boot) — 6 tools: delegate_to, decompose, check_progress, send_note, review, notify_user
- [x] `src/lib/orchestrator-tools.ts` (TOOL_DEFINITIONS + executeTool + validação manual sem zero-deps)
- [x] `src/lib/task-dispatcher.ts` (DAG-aware: depends_on satisfeitos + cost cap check + state machine bump)
- [x] `src/lib/preference-model.ts` (ingest explícito de approve + sentiment heurístico + distill patterns "evitar:"/"preferir:")
- [x] `src/lib/learnings-db.ts` (tabela learnings na tasks.db, idempotent — refforce bumps confidence)
- [x] `src/lib/orchestration-settings.ts` (autonomous_mode global + isAutonomousFor() resolver que combina com override do agente)
- [x] `src/lib/orchestrator-injector.ts` (escreve bloco gerenciado no MEMORY.md de cada orquestrador, com fallback dev `data/dev-workspaces/`)
- [x] `OperatorChatPanel.tsx` (painel lateral persistente no /agents, 🟡 Queued / 🔴 Direct toggle, polling 4s)
- [x] Botões 👍/👎 + comentário inline no Operator Chat quando task em `review`
- [x] `OrchestrationSettingsCard.tsx` em /agents (toggle autonomous_mode + 3 switches secundários)
- [x] Cost caps enforcement em `task-dispatcher.ts` (per_task + per_day, com bypass via settings.cost_caps_enforce)
- [x] Endpoints novos: `/api/settings/orchestration` (GET/PUT), `/api/orchestrator/tool-call` (POST), `/api/orchestrator/refresh` (POST), `/api/dispatcher/run` (POST), `/api/learnings` (GET/POST/PATCH/DELETE)
- [x] Wiring backend: ingest feedback em `/approve`, dispatcher kick em delegate+complete+approve, refresh orchestrators em /api/agents mutations
- [x] Telegram channel-origin: `task.metadata.origin_channel` persistido (default "chat") + roteamento automático em `notify_user`
- [ ] Bot Telegram inbound webhook (criação de thread + task com `origin_channel: "telegram"`) — *adiado pra Fase 2.5: precisa configurar webhook no BotFather*

---

### **Fase 3 — Dashboard "Live Mission" (nova aba `/agents`)** (~3-4 dias)

**Nova aba na página `/agents`** (ao lado de "Cards" e "Organograma"):

```
┌──────────────────────────────────────────────────────────────────┐
│ [Cards]  [Organograma]  [Live Mission] ← NOVA       [💬 Operator]│
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Kanban 7-column (drag-and-drop) ─────────────────────────┐  │
│  │ Planning │ Inbox │ Assigned │ In Prog │ Test │ Review │ Done │
│  │  [card]  │ [card]│  [card]  │  [card] │      │ [card] │      │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Task Detail (selected) ─────────────────────────────────┐   │
│  │ • Dependency graph (DAG visual)                          │   │
│  │ • Chat history + queued notes                            │   │
│  │ • Last log output (streaming)                            │   │
│  │ • Cost so far / Tokens / Duration                        │   │
│  │ • [Pause] [Kill] [Re-delegate] [Send Note] [👍] [👎]     │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**Stream `/api/agents/live`** (SSE):
- Eventos: `task.created`, `task.status_changed`, `task.checkpoint`, `task.completed`, `mailbox.message`, `agent.heartbeat`, `agent.state_changed`
- Persistência: últimos N eventos pra replay ao conectar

**Componentes novos:**
- `KanbanBoard.tsx` — drag-and-drop 7 colunas (atualiza status via API)
- `DependencyGraph.tsx` — DAG visual (cytoscape ou d3)
- `TaskDetailPanel.tsx` — lateral expandido com histórico + ações
- `LiveActivityFeed.tsx` — stream contínuo lateral (toggle)

**Entregáveis Fase 3:**
- [x] Aba "Live Mission" em `/agents` (LayoutGrid · GitBranch · Radio) com `LiveMissionTab.tsx` wrapper
- [x] Endpoint SSE `/api/agents/live` — replay de últimos N + subscribe ao EventEmitter + keepalive 15s + filter por event_types/task_id/agent_id
- [x] `src/lib/live-events.ts` — bus dual-layer: SQLite `live_events` table (durável) + in-process EventEmitter (zero-latency fanout); publishEvent + subscribe + listEvents
- [x] Wire publishEvent em: `tasks-db.createTask/updateTask/createCheckpoint`, `mailbox-db.sendMail`, `agent-health.recordHeartbeat` (split heartbeat × state_changed)
- [x] `KanbanBoard.tsx` (7 colunas + HTML5 drag-and-drop nativo, sem dep extra; cards mostram title, assignee, custo, elapsed, deps count, 👍/👎)
- [x] `DependencyGraph.tsx` (SVG hand-rolled: longest-path level layout, family BFS, edges com arrowhead, click pra navegar — segue padrão do AgentOrganigrama)
- [x] `TaskDetailPanel.tsx` (hero + dependency graph + result + review notes + approval inline + actions row + chat split em mensagens/checkpoints)
- [x] `LiveActivityFeed.tsx` (stream contínuo lado direito, filter por tipo, click navega pra task)
- [x] Filtros (por agente — dropdown no header; por tipo de evento — no LiveActivityFeed)
- [x] Botões de ação inline: Cancelar / Re-delegar (clone) / Send Note (Queued+Direct) / 👍 / 👎 + comentário pro preference model

---

### **Fase 4 — Office3D reativo + Learner Agent** (~3-4 dias)

**Office3D consome `/api/agents/live`:**

| Estado do agente | Animação no Office3D |
|---|---|
| `idle` | **Comportamento aleatório:** wander, ir pra cafeteira, conversar com outro agente (bolha de fala), olhar whiteboard, sentar em desk vazio. Rerolla a cada N segundos. |
| `assigned` | Caminha até seu desk |
| `working` / `in_progress` | Senta, MacMini com tela acesa, animação de digitação |
| `thinking` | Sentado, ícone de pensamento sobre cabeça |
| `delegating` (Jarvis) | Caminha até o desk do próximo sub-agente delegado |
| `reviewing` (Jarvis) | **Próximo do especialista que está sendo revisado** (em pé ao lado/atrás do desk) |
| `stuck` | Ícone de alerta + animação parada |

**Comportamento do Jarvis em delegações paralelas:**
- Se 3 sub-agentes trabalham simultaneamente, Jarvis **rotaciona** entre os desks (opção B confirmada)
- Tempo em cada desk: ~5-10s, depois move pro próximo
- Quando algum entra em `review`, Jarvis vai pra lá e fica até decidir verdict

**Mudanças em [src/components/Office3D/Office3D.tsx](../src/components/Office3D/Office3D.tsx):**
- Trocar polling `/api/office` (5s) por SSE `/api/agents/live` (push)
- Adicionar máquina de estado de posição/animação por agente
- Implementar wander aleatório (rerolls em `idle`)
- Implementar rotação do Jarvis entre desks ativos
- Implementar animação de supervisão (Jarvis próximo do desk em review)

**Learner Agent:**
- Cron diário (configurable) que olha:
  - Tasks completas + verdicts (approved/rejected)
  - Thumbs up/down explícitos
  - Sinal implícito (sentiment do chat após entrega)
- Extrai padrões: "usuário sempre rejeita quando agente X usa Y" → ajusta system prompt do X
- Escreve em `agent_memory.db` (tabela `learnings`)
- UI: timeline de aprendizados em `/agents` (botão "Ver o que Jarvis aprendeu")
- Edição manual: usuário pode confirmar/refutar cada aprendizado

**Entregáveis Fase 4:**
- [x] **Office3D conectado ao SSE `/api/agents/live`** — substitui polling 5s; replay de 80 eventos no connect; reconnect nativo do EventSource
- [x] **7 estados visuais** alinhados com `agent-health` (`idle`, `thinking`, `working`, `delegating`, `reviewing`, `stuck`, `offline`) + mapeamento de legacy "error"→stuck e "in_progress"→working
- [x] **Cores e pulses no `AgentDesk`** (verde/azul/roxo/laranja/vermelho/cinza-zinc-700) + pulse rápido pra `stuck`, pulse médio pra `thinking`/`reviewing`
- [x] **Wander idle aleatório** com `INTEREST_POINTS` ponderados (cafeteira 0.20, whiteboard 0.15, arquivador 0.10, plantas 2×0.10) + fallback random
- [x] **MovingAvatar com target guiado** — `working`/`thinking`/`stuck` → desk próprio; `delegating`/`reviewing` → desk do `focusAgentId` com offset lateral
- [x] **Rotação do Jarvis** (`delegating`) — focusAgentId roda entre agentes em flight a cada 7s (sort estável + índice circular)
- [x] **Supervisão (`reviewing`)** — quando algum sub-agente tem task em status `review`, Jarvis prioriza ir lá e fica próximo (offset 1.4 vs 1.0 de delegating)
- [x] **Speeds por estado** — idle 1.5, delegating 1.6, reviewing 1.2, working/thinking 0.8, stuck/offline 0.2
- [x] **Bootstrap snapshot** via `GET /api/agents/all/health` no mount pra não começar tudo "idle"
- [x] **Legenda atualizada** com 7 estados visuais
- [x] **Learner Agent cron** (`src/lib/learner-scheduler.ts`) — hourly default, kill switch via `LEARNER_SCHEDULER_DISABLED=1`, watermark em `data/learner-state.json` (idempotent + bounded scan cost)
- [x] **Endpoint `/api/learner/run`** (POST manual trigger + GET state)
- [x] **Bootstrap em `instrumentation.ts`** (root file — descobri 2 instrumentation files no projeto, só o root é o ativo)
- [x] **`LearningsTimeline.tsx`** — card colapsável no `/agents` com confidence bars, agrupamento por agente, botão refutar (✕), toggle "mostrar refutados", botão "Atualizar agora", "última ingestão: Xm atrás"

---

## ✅ Decisões Tomadas (todas as 16)

1. **DAG/Convoy** — Schema desde Fase 1; UI de dependency graph na Fase 3.
2. **Decomposição automática** — Jarvis decompõe, **mostra plano pro usuário aprovar ou pedir replanejamento** (bypass no Modo Autônomo).
3. **Quando delegar** — Jarvis decide sozinho quando delegar; obedece quando usuário pede explicitamente ("passa pro dev").
4. **Síncrono/Assíncrono** — **Assíncrono.** Jarvis avisa que iniciou; usuário acompanha no dashboard (Kanban evolui em tempo real).
5. **Aprovação humana antes de Done** — **Sim, com thumbs up/down + comentário.** Bypass no Modo Autônomo.
6. **Como aprende preferências** — **Ambos:** thumbs up/down explícito + sinal implícito (LLM extrai sentimento do chat).
7. **Queued Notes + Direct Messages** — Ambos no Operator Chat.
8. **UI Operator Chat** — **Painel lateral persistente** no `/agents` (estilo Slack), sempre visível independente da aba ativa. Justificativa: simples pro leigo entender (sempre lá) + Modo Autônomo cobre quem não quer interagir.
9. **Workspace** — **Por task** (`workspace/tasks/<task_id>/`). Isolamento garante paralelo sem corrupção; merge no workspace do agente após aprovação.
10. **Cost caps** — **Fase 2** (não depois). Multi-agente sem cap é risco financeiro real.
11. **Jarvis supervisor no Office3D** — Próximo do especialista durante review (em pé ao lado/atrás).
12. **Múltiplos paralelos no Office3D** — Jarvis **rotaciona** entre desks de quem está em flight.
13. **Ociosos** — **Comportamento aleatório:** wander, cafeteira, conversa entre agentes (bolha), whiteboard, desk vazio. Rerolla periodicamente.
14. **Telegram** — Jarvis avisa **no canal que foi acionado** (se foi via Telegram, responde lá; se foi via chat web, fica no chat). Não duplica.
15. **Especialistas iniciais** — **7 templates pré-prontos**: dev, writer, analyst, designer, researcher, pm, reviewer. Skills do Jarvis herdáveis (toggle `inherit_jarvis_skills`). Templates não criam agentes sozinhos — usuário ativa quando quiser; tudo editável.
16. **Salvar plano** — ✅ Este arquivo. Checkboxes em todos os entregáveis serão marcados durante a implementação.

### Meta-regra global: Modo Autônomo
- Flag `autonomous_mode` em `/settings` (default `false`)
- Quando `true`: pula aprovações de plano + entrega, executa direto
- Override por agente (`override_autonomous`): permite forçar manual em agentes sensíveis
- Cobre toda a UX de leigo vs técnico sem duplicar fluxos

---

## 📦 Entregáveis Cumulativos (marcar conforme avança)

### Fase 1 — Fundação ✅ CONCLUÍDA
- [x] `data/tasks.db` (schema + migrations)
- [x] `src/lib/tasks-db.ts`
- [x] `src/lib/mailbox-db.ts`
- [x] `src/lib/agent-health.ts`
- [x] `src/lib/task-workspace.ts`
- [x] Endpoints: `/api/tasks/*`, `/api/mailbox/*`, `/api/agents/:id/heartbeat`, `/api/agents/:id/health`
- [x] Migração de agentes (`role`, `specialty`, `inherit_jarvis_skills`, `override_autonomous`, `cost_caps`)
- [x] `data/agent-templates.json` (7 templates)
- [x] UI: template picker + seção "Orquestração" no modal

### Fase 2 — Orquestração ✅ CONCLUÍDA
- [x] Tool definitions injetadas no MEMORY.md do orquestrador (6 tools)
- [x] `src/lib/orchestrator-tools.ts`
- [x] `src/lib/orchestrator-injector.ts`
- [x] `src/lib/task-dispatcher.ts`
- [x] `src/lib/preference-model.ts` + `src/lib/learnings-db.ts`
- [x] `src/lib/orchestration-settings.ts`
- [x] Operator Chat UI (`OperatorChatPanel.tsx`) — painel lateral persistente
- [x] Cost caps schema + enforcement no dispatcher
- [x] Flag `autonomous_mode` via `OrchestrationSettingsCard.tsx` em /agents
- [x] Telegram channel-origin em `task.metadata` + roteamento automático em notify_user
- [x] Botões 👍/👎 + comentário inline no painel de review
- [ ] Telegram webhook inbound — *adiado para Fase 2.5*

### Fase 3 — Dashboard ✅ CONCLUÍDA
- [x] Aba "Live Mission" em `/agents`
- [x] SSE `/api/agents/live` + `src/lib/live-events.ts` (event bus dual-layer)
- [x] `KanbanBoard.tsx` (drag-and-drop nativo)
- [x] `DependencyGraph.tsx` (SVG hand-rolled)
- [x] `TaskDetailPanel.tsx` (hero + DAG + result + actions + chat split)
- [x] `LiveActivityFeed.tsx` (filter por tipo + click navega)

### Fase 4 — Office3D + Learner ✅ CONCLUÍDA
- [x] Office3D conectado ao SSE
- [x] 7 estados visuais com animações
- [x] Wander idle com interest points ponderados
- [x] Rotação do Jarvis entre desks ativos (7s)
- [x] Animação de supervisão (offset lateral)
- [x] Learner Agent (hourly cron + manual /api/learner/run) + tabela `learnings`
- [x] `LearningsTimeline.tsx` no /agents (refutar, confidence bars, agrupamento)

---

## ✅ Checkpoints de aceitação

### Fase 1 ✅
- [x] Crio task via `POST /api/tasks/delegate` e vejo no banco com status `inbox` — confirmado em smoke test
- [x] Heartbeat de agente atualiza `agent_health.state` em tempo real — `working` setado e lido via `/health`
- [x] Sub-agente manda mensagem pro pai via mailbox e o pai recebe — testado com queued_note + inter_agent + review_feedback
- [x] Crio agente a partir do template — picker + applyTemplate() pré-preenche 8 campos do form
- [x] Workspace isolado é criado em `<root>/tasks/<task_id>/` — fallback dev: `data/task-workspaces/<id>/` com README.md auto-seed
- [x] Bonus: path completo end-to-end testado — delegate → heartbeat → queued note → checkpoint (flush 3 mensagens) → complete → review approved → user thumbs up → status `done`
- [x] Bonus: path de rejeição testado — review verdict `rejected` faz status voltar pra `assigned` + mailbox feedback ao especialista

### Fase 2 ✅
- [x] **decompose** cria parent + DAG de subtasks com depends_on resolvidos por índice ou id — confirmado via smoke test
- [x] **Dispatcher DAG-aware** — SUB1 vai para `assigned`, SUB2 aguarda em `inbox`; após approve do SUB1, SUB2 automaticamente vai para `assigned`
- [x] **autonomous_mode** — flag global + override por agente (`inherit`/`force_manual`/`force_auto`); UI no OrchestrationSettingsCard
- [x] **Queued Note** (🟡) — UI envia, recipient pega no próximo checkpoint via `flushUnreadForDispatch` (transação read+mark+format atômica)
- [x] **Direct Message** (🔴) — UI marca `urgent: true` → message_type `direct_message` (recipient flush ainda no checkpoint, mas tipo permite interrupção downstream)
- [x] **Sub-agente termina** → status `review` → Jarvis review via tool → status mantém `review` (esperando user) → 👍/👎 inline
- [x] **👎 com feedback** → status volta pra `assigned` + mailbox `review_feedback` ao especialista + ingest no preference model (distill "evitar:"/"preferir:")
- [x] **Cost cap excedido** → dispatcher retorna `paused` + log `pending` + mailbox notification ao orquestrador
- [x] **Channel-origin propaga em metadata** → `notify_user` roteia automaticamente pro canal de origem (chat ou telegram)
- [ ] **Telegram inbound webhook end-to-end** — adiado pra Fase 2.5
- [x] **Bonus:** orchestrator MEMORY.md gerado automaticamente em mutações de agentes (3.8 KB com tool docs + lista de sub-agentes + preferências aprendidas + estado em voo)
- [x] **Bonus:** preference model captura 5 learnings após 1 rejeição com feedback ("evitar X", "preferir Y", "rejeições recentes — revisar estilo")

### Fase 3 ✅
- [x] **SSE end-to-end testado**: 8 frames capturados em 6s (1 connected + 6 event + 1 replay_done), 4 tipos de eventos publicados (task.created, task.status_changed, agent.state_changed, mailbox.message)
- [x] **Tabela live_events populada**: 6 eventos com timestamps consistentes (task.created=1, task.status_changed=1, agent.state_changed=2, mailbox.message=2)
- [x] **Aba "Live Mission" renderiza**: Kanban 7-colunas, drag-and-drop nativo HTML5, cards com title/assignee/custo/elapsed/deps count
- [x] **TaskDetailPanel**: hero + dependency graph (SVG) + result + review notes + approval inline + send-note composer + chat/checkpoints split
- [x] **LiveActivityFeed**: stream contínuo com filter por tipo + click navega pra task
- [x] **Auto-reconnect**: EventSource nativo reconecta sozinho em queda; replay window evita gap
- [x] **Debounced refetch**: múltiplos eventos em curto intervalo (ex: decompose com 4 tasks) disparam 1 só GET após 300ms
- [x] **TypeScript clean** (`npx tsc --noEmit` zero output)

### Fase 4 ✅
- [x] **SSE Office3D end-to-end testado**: 24 frames event + connected + replay_done em 5s. event_type distribution: agent.state_changed=7, mailbox.message=6, task.status_changed=6, task.created=3, task.reviewed=1, task.approved=1
- [x] **`/api/agents/all/health` snapshot** funciona — 3 agentes (dev: offline, devops: idle, coder: idle) lidos no bootstrap do Office3D
- [x] **Learner manual trigger**: scaneou 3 tasks aprovadas, ingerou todas, gerou 5 learnings; após nova approval com feedback "perfeito, prefiro respostas curtas" → +2 learnings com confidence escalonada
- [x] **Learner watermark idempotent**: 2ª chamada após mais 1 task ingere só a nova (scanned=1)
- [x] **Top learnings agrupados por agente** com confidence ordenada: `devops [0.90] entregas no estilo recente foram aprovadas`, `[0.50] usuário reforçou: preferir: respostas curtas`, etc.
- [x] **Cron bootstrapped** — `[learner-scheduler] started (interval=3600000ms)` confirmado no startup log (após descobrir que existem 2 instrumentation.ts no projeto e editar o root)
- [x] **Visual**: Jarvis com role=orchestrator vê `focusAgentId` setado pelo orchestratorFocus state quando algum sub-agente está em review (priority) ou rotação a cada 7s entre in_flight agents
- [x] **MovingAvatar anchored**: working/thinking/stuck anchor próprio desk (offset +1z), delegating anchor desk do focusAgentId (offset +1x), reviewing anchor offset +1.4x
- [x] **TypeScript clean** (`npx tsc --noEmit` zero output)

---

## 🔗 Referências

- Inspiração arquitetural: https://github.com/crshdn/mission-control
- OpenClaw Gateway docs: ver [src/lib/openclaw-ws-client.ts](../src/lib/openclaw-ws-client.ts)
- Roadmap macro: [jarvis-roadmap.md](./jarvis-roadmap.md)
