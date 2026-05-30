# WhatsApp Operation Modes

AtlasDeck expõe 5 modos de operação para o canal WhatsApp via UI (`WhatsappSetupModal`) e via API (`POST /api/integrations/whatsapp/mode`). Cada modo traduz numa combinação específica de campos do `channels.whatsapp` no `~/.openclaw/openclaw.json` + um `messagePrefix` que injeta instruções de persona/comportamento que o agente LLM segue.

## Modos

### 🔇 Passive (default)
- `dmPolicy = "disabled"` — gateway nunca encaminha DM ao agente.
- `groupPolicy = "disabled"` — grupos também ignorados.
- Bot fica conectado, lê tudo, **nunca responde**.

### 👤 Owner — "responder como você"
- `dmPolicy = "open"`, `groupPolicy = "allowlist"` com `groupAllowFrom = ["*"]`.
- `selfChatMode = true` — permite Felipe se auto-comandar pelo número pareado.
- `messagePrefix` instrui o agente a:
  - Falar em primeira pessoa, tom casual, gírias do Felipe.
  - Buscar memórias antes de responder.
  - Considerar áudio quando o remetente mandou áudio (uses Fish Audio cloned voice — **ver "Voice TODO" abaixo**).
  - Não responder em grupo sem menção; quando responde, breve.
  - Nunca revelar que é bot.

### 🤝 Assistant — "responder como meu assessor"
- `dmPolicy = "open"`, `groupPolicy = "allowlist"` com `groupAllowFrom = ["*"]`.
- `selfChatMode = true` — Felipe pode pedir briefing pelo próprio número.
- `messagePrefix` instrui o agente a:
  - Apresentar-se como assessor pessoal no primeiro contato (1x por 24h).
  - Sempre terceira pessoa, profissional, atencioso.
  - Anotar recados.
  - Marcar reuniões via tool de calendário (**ver "Calendar TODO"**).
  - **NUNCA** acessar memórias pessoais do Felipe.
  - Comandos administrativos só do número do próprio Felipe.
  - Servir briefing quando Felipe pedir (**ver "Briefing TODO"**).
  - Grupos: mesma regra (só responde se mencionado).

### 🌐 Open — "bot livre"
- `dmPolicy = "open"`, `groupPolicy = "open"`, sem prefix.
- Bot responde com a voz padrão do agente. Sandbox/testes.

### 🔐 Pairing — legado
- `dmPolicy = "pairing"` — manda código pra desconhecidos. Evite.

## Regras globais (todos os modos não-passive)

`SHARED_RULES` no início do `messagePrefix`:

```
[REGRAS GERAIS — sempre aplicam]
• GRUPO sem @mention de Felipe → NÃO responda. Silêncio total.
• GRUPO com @mention → resposta em até 2 frases, endereçada à pessoa.
• Considere histórico recente da conversa, não responda mecânico.
• Áudio recebido → áudio enviado (mesmo formato).
```

## Como o gateway aplica isso

OpenClaw lê `channels.whatsapp.messagePrefix` e prepende-o ao conteúdo de cada DM antes de mandar ao agente LLM. O agente lê o prefix como contexto/instrução e ajusta a resposta. Validação acontece dentro do agente (LLM), não no gateway — então as regras são "soft enforcement" (mas modelos modernos as seguem bem).

`groupPolicy = "allowlist"` com `groupAllowFrom = ["*"]` significa "canal aceita grupos" — o gateway encaminha mensagens de grupo ao agente. A regra de "só responder se mencionado" é responsabilidade do agente (via `messagePrefix`).

`selfChatMode = true` libera mensagens vindas do próprio número pareado (Felipe → Felipe via self-chat do WhatsApp). Sem isso, OpenClaw filtra essas mensagens pra evitar loops.

## Follow-ups (não implementados ainda)

### Voice TODO — Fish Audio TTS pra modo Owner
- Usuário tem voz clonada no Fish Audio.
- Quando agente em modo Owner gerar texto, pipeline:
  1. Detectar se deveria responder em áudio (regra: remetente mandou áudio OU contexto pede).
  2. Chamar Fish Audio API com texto + `voice_id` do usuário.
  3. Receber MP3/OGG.
  4. Enviar via OpenClaw como áudio do WhatsApp (Baileys `sendMessage` com `audio`).
- Precisa de:
  - `FISHAUDIO_API_KEY` em settings.
  - Endpoint `POST /api/integrations/fishaudio/tts` que recebe texto e retorna URL/blob.
  - Tool `whatsapp_send_audio` que o agente possa chamar (via MCP ou via openclaw plugin custom).
  - Detection heuristic: agente decide quando usar áudio (prompt já instrui).

### Briefing TODO — log de conversas pro assessor
- Modo Assistant precisa registrar quem conversou + sumário.
- Schema (nova tabela em `data/whatsapp-briefing.db` ou `tasks.db`):
  ```
  CREATE TABLE assessor_conversations (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    started_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    summary TEXT,
    urgency TEXT CHECK(urgency IN ('low','medium','high','urgent')),
    action_taken TEXT,
    requires_followup BOOLEAN DEFAULT 0,
    raw_messages TEXT  -- JSON array (para reconstrução)
  )
  ```
- Tools a expor pro agente:
  - `whatsapp_briefing_log(sender_id, sender_name, summary, urgency, action_taken)` — chamada após cada conversa do assessor.
  - `whatsapp_briefing_get(since?: ISO timestamp)` — retorna lista estruturada, agente formata como markdown pro Felipe.
- Endpoint:
  - `POST /api/integrations/whatsapp/briefing` — log entry (agente chama).
  - `GET /api/integrations/whatsapp/briefing?since=...` — list (agente chama quando Felipe pede).
- UI: card no dashboard mostrando "Recados pendentes (3)" com link pra ver briefing completo.

### Calendar TODO — book_meeting pro assessor
- Usuário tem `scripts/setup-calendar.ts` (Google Calendar OAuth já existe).
- Precisa expor como tool MCP pro agente:
  - `calendar_check_availability(date_range)` — retorna slots livres.
  - `calendar_create_event(title, start, end, attendees, description)` — cria evento.
- Provavelmente via `scripts/atlasdeck-memory-mcp.mts` ou MCP novo (`atlasdeck-calendar-mcp`).
- Endpoint REST existe? Verificar `src/app/api/calendar/*` se tem.

### Owner-number-allowlist enforcement
- Hoje a restrição "comandos só do número do Felipe" é via prompt apenas (soft).
- Hard enforcement: ler o número remetente do WhatsApp metadata (Baileys passa em `key.remoteJid`) e bloquear no PRÓPRIO openclaw via `channels.whatsapp.allowFrom = [felipe_phone]`.
- MAS: assessor precisa receber de TODOS pra anotar recados — então `allowFrom` global é ruim.
- Solução: deixar `allowFrom` aberto + agente verifica `remoteJid === FELIPE_JID` antes de aceitar comando admin.
- Variável `FELIPE_PHONE` no settings, agente lê via tool `get_owner_phone`.
