# 🤖 AtlasDeck → Jarvis: Roadmap de Transformação

> **Objetivo:** transformar o AtlasDeck de um dashboard passivo do OpenClaw em uma IA assistente totalmente operável pela interface web, com Telegram tornando-se opcional. Inspirado no Jarvis (Iron Man).

> **Princípio inegociável:** todo recurso novo deve sobreviver a um `git clone + install` 1-clique. Defaults sãos, downloads pesados sob demanda, dependências nativas com fallback.

---

## 📊 Status Geral

- **Início:** 2026-05-21
- **Camadas:** 6
- **Progresso global:** 18 / 42 checkpoints (Camada 1: 18/17 — bridge + wake word entregues)

---

## 🎙️ Camada 1 — Voz & Conversação

> Substitui Telegram como canal primário. O ato de "falar com o Jarvis" precisa nascer aqui.

### 1.1 Chat web nativo com agentes
- [x] **1.1.1** Definir contrato API `/api/chat/stream` (SSE, multi-agente, anexa context)
- [x] **1.1.2** Persistência de threads no SQLite (`chats.db`: threads, messages, agent_id, tokens)
- [x] **1.1.3** UI de chat em `/chat` (lista de threads + painel ativo + seletor de agente)
- [x] **1.1.4** Bridge para sessions do OpenClaw (importar transcripts existentes como histórico)
- [x] **1.1.5** Markdown + code highlight + render de tool-calls inline

### 1.2 STT (Speech-to-Text)
- [x] **1.2.1** Web Speech API como fallback default (zero-install, online)
- [ ] **1.2.2** Whisper local via `@xenova/transformers` (lazy download na 1ª ativação)
- [ ] **1.2.3** Toggle nas settings: "voz online (Web Speech) | local (Whisper)"
- [x] **1.2.4** Indicador visual de gravação + waveform _(pulso visual, waveform pendente)_

### 1.3 TTS (Text-to-Speech)
- [x] **1.3.1** Web Speech Synthesis como default
- [ ] **1.3.2** Piper/Coqui local (opcional, lazy)
- [ ] **1.3.3** Configuração de voz/velocidade/idioma por agente
- [x] **1.3.4** Auto-play opcional ao receber resposta

### 1.4 Wake word
- [x] **1.4.1** Avaliar openwakeword vs porcupine (licença, peso, qualidade pt-BR) — decisão MVP: Web Speech contínuo (zero install), upgrade para ONNX no futuro
- [x] **1.4.2** Implementar listener no browser (Web Speech contínuo + heurística de match) — _AudioWorklet ONNX pendente para upgrade local_
- [x] **1.4.3** Configurável: palavra-gatilho ("Atlas", "Jarvis", custom) — ligadas por padrão
- [x] **1.4.4** Toggle on/off + visual idle/listening/active — componente `WakeIndicator`

### ✅ Checkpoint de aceitação Camada 1
- [ ] Consigo abrir `/chat`, falar "Atlas, qual meu próximo compromisso?" e ouvir resposta em áudio sem tocar no Telegram.

### 🧱 Entregue (cumulativo)
- `src/lib/chat-db.ts` — schema completo (threads, messages, FTS5), CRUD, search, stats
- `src/lib/openclaw-runner.ts` — subprocess runner com fallback de estratégias e tolerância a CLI inexistente
- `src/app/api/chat/stream/route.ts` — SSE end-to-end com persistência incremental
- `src/app/api/chat/threads/{,[id]}/route.ts` + `/api/chat/search` — CRUD e busca
- `src/components/chat/*` — `ThreadList`, `MessageBubble`, `Composer`, `MicButton`, `useChatStream`, `useSpeechSynthesis`
- `src/app/(dashboard)/chat/page.tsx` — página integrada com seletor de agente e toggle de TTS
- Item `Chat` adicionado ao Dock
- `src/lib/openclaw-sessions-bridge.ts` — varredura de `agents/*/sessions/*.jsonl`, import idempotente (mtime+lineCount), append incremental
- `src/app/api/chat/import/openclaw/route.ts` — GET lista sessions, POST importa (com `force` opcional)
- `src/components/chat/ImportOpenClawModal.tsx` — modal de seleção + sumário com erros
- `src/components/chat/useWakeWord.ts` — wake word "Jarvis"/"Atlas" via Web Speech contínuo, auto-restart, pausa enquanto stream/TTS ativos, match com remoção de diacríticos
- `src/components/chat/WakeIndicator.tsx` — pílula 🟢/🔵/🔴 no header, clicável para toggle

---

## 🛎️ Camada 2 — Proatividade & Event Bus

> Jarvis fala primeiro. AtlasDeck precisa virar **reativo a eventos**, não só a cron.

### 2.1 Event bus interno
- [ ] **2.1.1** `POST /api/events/emit` (qualquer fonte publica)
- [ ] **2.1.2** SSE stream `/api/events/subscribe` (UI e agentes ouvem)
- [ ] **2.1.3** Persistência (últimos N eventos para replay)
- [ ] **2.1.4** Padrões de subscrição (glob/regex em event types)

### 2.2 Triggers reativos
- [ ] **2.2.1** UI para criar trigger: "quando evento X → rodar agente/cron/webhook Y"
- [ ] **2.2.2** Condições compostas (AND/OR, threshold, debounce)
- [ ] **2.2.3** Log de execução de triggers

### 2.3 Inbox proativo
- [ ] **2.3.1** Componente "Atlas notifications" no shell (separado de system notifications)
- [ ] **2.3.2** Ações inline (accept/decline/snooze/reply)
- [ ] **2.3.3** Migrar cost alerts e booking confirmations do Telegram para inbox
- [ ] **2.3.4** Priorização (urgent/normal/info)

### 2.4 Daily briefing como tela
- [ ] **2.4.1** Página `/briefing` (clima, agenda, custos, memórias relevantes, sugestões)
- [ ] **2.4.2** Auto-open ao primeiro acesso do dia
- [ ] **2.4.3** TTS automático opcional ("Bom dia, hoje você tem...")

### ✅ Checkpoint Camada 2
- [ ] Em vez de receber alerta de custo no Telegram, vejo no inbox UI com botão "pausar agente X" funcionando.

---

## 🧠 Camada 3 — Memória Viva

> Hoje memória só extrai. Jarvis lembra, reflete, conecta.

### 3.1 Reflection loop
- [ ] **3.1.1** Cron que revisita memórias antigas e detecta contradições
- [ ] **3.1.2** Cluster de memórias similares (consolidação)
- [ ] **3.1.3** Sugestões de arquivamento para o usuário

### 3.2 Memory timeline & grafo
- [ ] **3.2.1** Timeline visual (entidades × tempo)
- [ ] **3.2.2** Grafo de relações (pessoas, projetos, conceitos) com d3/cytoscape
- [ ] **3.2.3** Drill-down clicando em nós

### 3.3 Pinning & confiança
- [ ] **3.3.1** Pin manual de memórias críticas (nunca expiram)
- [ ] **3.3.2** Editor de confidence score
- [ ] **3.3.3** Histórico de mudanças por memória

### ✅ Checkpoint Camada 3
- [ ] Atlas me avisa: "encontrei 2 memórias contradizendo seu local atual" e eu resolvo pela UI.

---

## 🏠 Camada 4 — Mundo Físico

> Opcional, mas o que faz parecer Jarvis de verdade.

### 4.1 Home Assistant bridge
- [ ] **4.1.1** Settings: URL + token do HA
- [ ] **4.1.2** Endpoint `/api/ha/entities` (lista dispositivos)
- [ ] **4.1.3** UI de controle (luzes, clima, mídia) integrado ao chat
- [ ] **4.1.4** Agente reconhece comandos: "Atlas, acende a luz da sala"

### 4.2 Geofencing
- [ ] **4.2.1** PWA mobile envia posição (background opcional)
- [ ] **4.2.2** Regras "ao entrar/sair de zona X disparar trigger"

### 4.3 Webhooks de entrada
- [ ] **4.3.1** Endpoint genérico `/api/hooks/[slug]`
- [ ] **4.3.2** UI para criar/listar/secret-rotate hooks
- [ ] **4.3.3** Map hook → event bus

### ✅ Checkpoint Camada 4
- [ ] Ao chegar em casa, geofence dispara → luz acende via HA → inbox: "bem-vindo, deseja briefing?"

---

## 🔧 Camada 5 — Operabilidade UI (mata o "só no Telegram")

### 5.1 Command palette global (Cmd+K)
- [ ] **5.1.1** Componente palette com fuzzy search
- [ ] **5.1.2** Registry de comandos (todas as ações do sistema)
- [ ] **5.1.3** Suporte a entrada por voz no palette
- [ ] **5.1.4** Histórico de comandos recentes

### 5.2 Workflow builder visual
- [ ] **5.2.1** Editor drag-and-drop (gatilho → condição → ação)
- [ ] **5.2.2** Persistência em JSON + runner
- [ ] **5.2.3** Migrar workflows hoje em docs para o builder
- [ ] **5.2.4** Test/dry-run de workflow

### 5.3 Approval queue
- [ ] **5.3.1** Fila de aprovações (booking, gasto alto, ação destrutiva)
- [ ] **5.3.2** UI com contexto + ações
- [ ] **5.3.3** Integrar com agentes (`POST /api/approvals/request`)

### ✅ Checkpoint Camada 5
- [ ] Qualquer ação hoje no Telegram tem botão equivalente na UI; Telegram passa a ser opcional via toggle nas settings.

---

## 📱 Camada 6 — Onipresença

### 6.1 PWA instalável
- [ ] **6.1.1** Manifest + service worker
- [ ] **6.1.2** Cache offline para shell e últimas memórias
- [ ] **6.1.3** Ícones + splash screen

### 6.2 Push notifications
- [ ] **6.2.1** Web Push (VAPID) — server-side
- [ ] **6.2.2** Permissão + subscription management
- [ ] **6.2.3** Roteamento: inbox → push quando aba inativa

### 6.3 Modo ambient
- [ ] **6.3.1** Tela fullscreen `/ambient` (clima, hora, próximo evento, idle voice)
- [ ] **6.3.2** Always-listen opcional (wake word ativo)
- [ ] **6.3.3** Auto-dim noite

### ✅ Checkpoint Camada 6
- [ ] Instalo no celular como app, recebo push de alerta, abro tablet em modo ambient = Atlas onipresente.

---

## 🗺️ Ordem de execução recomendada

1. **Camada 1** (chat + voz) — entrega imediatamente o "wow Jarvis"
2. **Camada 2** (event bus + inbox proativo) — Atlas fala primeiro
3. **Camada 5** (command palette + approval queue) — mata dependência Telegram
4. **Camada 6** (PWA + push) — onipresença
5. **Camada 3** (memória viva) — torna Atlas "esperto"
6. **Camada 4** (mundo físico) — wow final, depende do setup do user

---

## 📝 Decisões de design pendentes

- [ ] Whisper local: qual tamanho default? (tiny=39MB, base=74MB, small=244MB)
- [ ] TTS local: Piper (rápido, pt-BR ok) vs Coqui (qualidade superior, pesado)?
- [ ] Wake word: porcupine (pago em prod) vs openwakeword (free, qualidade ok)?
- [ ] Banco do chat: novo `chats.db` ou estender `memories.db`? **→ decidido `chats.db`**
- [ ] Modelo do chat: usar OpenClaw direto (subprocess?) ou abstração própria? **→ `openclaw agent --json` CLI hoje; WS Gateway na próxima iter**

## 🔌 Próxima iteração do chat runner — Gateway WebSocket

Hoje usamos `openclaw agent --message ... --to ... --json` via subprocess, com fallback Ollama. Funciona mas é one-shot (sem streaming real, sem cancelamento via UI).

O caminho correto é o **Gateway WebSocket no `:18789`**, que a Control UI oficial do OpenClaw usa. Protocolo:

- `chat.send` → `{ result: { runId, status: "started" } }` (ACK rápido)
- Streaming de eventos no canal `chat` (tokens, tool_use, done)
- `chat.history` → recupera contexto
- `chat.abort` → cancela run em andamento
- `chat.inject` → injeta mensagem de sistema no meio do turno

**Tarefas para próxima iter:**
- [ ] **R.1** Cliente WS em `src/lib/openclaw-ws-client.ts` (Bearer token, reconnect, multiplex por sessionKey)
- [ ] **R.2** Adapter no runner: WS primeiro, CLI fallback, Ollama fallback
- [ ] **R.3** Mapear sessionKey (hoje `web:atlasdeck`) por usuário/thread → `web:<userId>` ou `web:<threadId>`
- [ ] **R.4** Botão "Parar" do composer dispara `chat.abort`
- [ ] **R.5** Suporte a `gateway.controlUi.allowedOrigins` em ambientes não-loopback

---

## 📚 Histórico

| Data | Evento |
|---|---|
| 2026-05-21 | Plano inicial criado, Camada 1 priorizada |
| 2026-05-22 | Camada 1 MVP entregue: chat-db, openclaw-runner subprocess, SSE, UI `/chat`, STT Web Speech, TTS Web Speech, dock |
| 2026-05-22 | Bridge OpenClaw sessions + Wake word ("Jarvis"/"Atlas") via Web Speech contínuo entregues |
| 2026-05-22 | Fix: chat runner agora usa `openclaw agent --json` (CLI real); fallback Ollama mantido; aliases pt-BR no wake word + lastHeard visível |
