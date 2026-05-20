# OpenClaw Skill: `atlasdeck-calendar`

Esta skill registra no OpenClaw a integração com o módulo de agenda do AtlasDeck. O OpenClaw recebe comandos em linguagem natural (Telegram, etc.) e usa as ferramentas abaixo para criar/listar/editar/excluir compromissos, bloquear horários e resolver remarcações.

## Instalação

Crie o diretório no host onde o OpenClaw está instalado:

```bash
mkdir -p /root/.openclaw/workspace-infra/skills/atlasdeck-calendar
```

Copie o conteúdo de `SKILL.md` abaixo para `/root/.openclaw/workspace-infra/skills/atlasdeck-calendar/SKILL.md`.

Adicione `atlasdeck-calendar` ao `AGENTS.md` do workspace principal do OpenClaw dentro de `<available_skills>...</available_skills>`.

O token de serviço lido pelo middleware do AtlasDeck vem de `openclaw.json -> gateway.auth.token` (já existente). Nenhuma configuração adicional é necessária.

A URL base do AtlasDeck deve estar disponível para o OpenClaw via variável `ATLASDECK_BASE_URL` (ex: `http://localhost:3000`) no shell em que ele executa.

---

## SKILL.md (conteúdo)

```markdown
---
name: atlasdeck-calendar
description: Gerencia a agenda pessoal no AtlasDeck (criar/editar/listar/excluir eventos, bloquear horários, resolver remarcações, compartilhar links de booking). Use sempre que o usuário pedir algo sobre compromissos, reuniões, agenda, "bloqueia", "agenda", "marca", "remarca", "remarcar", "cancela compromisso", "envia meu link".
emoji: 📅
homepage: https://atlasdeck/calendar
---

# atlasdeck-calendar

Você está conectado à agenda do dono pelo AtlasDeck via HTTP REST. Use SEMPRE estas tools quando o usuário falar sobre compromissos. O usuário pode pedir em linguagem natural — você é responsável por interpretar a expressão temporal e converter para ISO 8601 com timezone explícito (use o TZ do dono, padrão `America/Sao_Paulo` -03:00, salvo informação em contrário).

## Variáveis de ambiente

- `ATLASDECK_BASE_URL` — URL base do dashboard (ex: `http://localhost:3000`)
- `OPENCLAW_GATEWAY_TOKEN` — Token de serviço (já existe em `openclaw.json -> gateway.auth.token`)

Toda requisição inclui o header `x-openclaw-token: $OPENCLAW_GATEWAY_TOKEN` para autenticação service-to-service.

## Interpretação de tempo (PT-BR)

| Expressão | Interpretação |
|---|---|
| "hoje à tarde" | hoje 13:00–18:00 |
| "hoje à noite" | hoje 18:00–23:59 |
| "manhã" / "de manhã" | 08:00–12:00 |
| "amanhã" (sem hora) | dia inteiro de amanhã (00:00–23:59), `all_day=true` |
| "depois de amanhã" | dia inteiro D+2 |
| "esta semana" | de hoje 00:00 até domingo 23:59 |
| "semana que vem" | de segunda 00:00 a domingo 23:59 da próxima semana |
| "este mês" | hoje 00:00 → último dia do mês 23:59 |
| "sexta" / "na sexta" | próxima sexta-feira (dia inteiro se sem hora) |
| "das 14h às 16h" + dia | janela específica naquele dia |
| "a tarde toda" + dia | 13:00–18:00 daquele dia |

Em casos ambíguos, **confirme o range entendido com o usuário antes de chamar a tool**.

Sempre que uma tool retornar algo relevante (contagem de conflitos, sugestões), **responda ao usuário com resumo + próximos passos sugeridos**.

## Tools

### create_event

```
POST {ATLASDECK_BASE_URL}/api/calendar/events
Headers: x-openclaw-token: $OPENCLAW_GATEWAY_TOKEN, Content-Type: application/json
Body: {
  "title": "Reunião com Maria",
  "description": "Discutir contrato",
  "location": "Google Meet",
  "start_at": "2026-05-21T15:00:00-03:00",
  "end_at": "2026-05-21T16:00:00-03:00",
  "all_day": false,
  "color": "#FF3B30",
  "source": "openclaw",
  "reminders": [
    { "minutes_before": 15, "channel": "notification" },
    { "minutes_before": 60, "channel": "telegram" }
  ]
}
```

### list_events

```
GET {ATLASDECK_BASE_URL}/api/calendar/events?from=ISO&to=ISO
```

### update_event

```
PATCH {ATLASDECK_BASE_URL}/api/calendar/events/{id}
Body: { ... campos a alterar ... }
```

### delete_event

```
DELETE {ATLASDECK_BASE_URL}/api/calendar/events/{id}
```

### find_free_slots

```
GET {ATLASDECK_BASE_URL}/api/calendar/availability?date=YYYY-MM-DD&duration=30
```

### block_calendar

```
POST {ATLASDECK_BASE_URL}/api/calendar/blocks
Body: {
  "start_at": "2026-05-21T00:00:00-03:00",
  "end_at": "2026-05-21T23:59:59-03:00",
  "all_day": true,
  "title": "Consulta médica",
  "reason": "Médico"
}
```

Resposta inclui `conflicts: N`. Se N > 0, **avisar o usuário** e oferecer `list_to_reschedule`.

### unblock_calendar

```
DELETE {ATLASDECK_BASE_URL}/api/calendar/blocks/{id}
```

### list_to_reschedule

```
GET {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue?status=pending
```

Retorna `items[]` com `id`, `original_start`, `original_event.title`, `block.reason`. Apresente como lista numerada.

### suggest_reschedule

```
GET {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue/{queueId}/suggestions
```

Retorna `suggestions[]` (até 6 slots livres). Apresente como opções numeradas.

### reschedule_event

```
POST {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue/{queueId}/reschedule
Body: { "new_start_at": "2026-05-26T10:00:00-03:00", "new_end_at": "2026-05-26T11:00:00-03:00" }
```

### list_pending_bookings / approve_booking / reject_booking

```
GET {ATLASDECK_BASE_URL}/api/calendar/bookings?status=pending
POST {ATLASDECK_BASE_URL}/api/calendar/bookings/{id}/approve
POST {ATLASDECK_BASE_URL}/api/calendar/bookings/{id}/reject  Body: { "reason": "..." }
```

### share_booking_link

```
POST {ATLASDECK_BASE_URL}/api/calendar/share
Body: { "linkId": "...", "chatId": "<telegram_chat_id>", "customText": "Oi, agenda comigo aqui:" }
```

## Exemplos de comando → tool call (linguagem natural)

- *"OpenClaw, agenda reunião com Maria amanhã às 15h"* → `create_event(title="Reunião com Maria", start_at="<amanhã>T15:00:00-03:00", end_at="<amanhã>T16:00:00-03:00")`
- *"Quais meus compromissos de sexta?"* → `list_events(from="<sexta>T00:00", to="<sexta>T23:59")`
- *"Bloqueia minha agenda amanhã"* → `block_calendar(start_at="<amanhã>T00:00", end_at="<amanhã>T23:59", all_day=true)`
- *"Bloqueia esta semana"* → `block_calendar(start_at="<hoje>T00:00", end_at="<domingo>T23:59", all_day=true)`
- *"Bloqueia hoje à tarde"* → `block_calendar(start_at="<hoje>T13:00", end_at="<hoje>T18:00", all_day=false)`
- *"Bloqueia amanhã das 14h às 18h, médico"* → `block_calendar(start_at="<amanhã>T14:00", end_at="<amanhã>T18:00", reason="médico")`
- *"Quais agendas preciso remarcar?"* → `list_to_reschedule()` → lista numerada
- *"Remarca o primeiro pra quarta 10h"* → identificar queueId, depois `reschedule_event(queueId, new_start_at="<quarta>T10:00:00-03:00")`
- *"Manda meu link de 30min pro chat do Felipe"* → `share_booking_link(linkId, chatId)`
- *"Aprova o pedido da Maria"* → `list_pending_bookings()` → identificar id → `approve_booking(id)`

## Diretrizes de resposta

- Após criar/editar/excluir, **confirme verbalmente** (ex: "Pronto, agendei sua reunião com Maria amanhã das 15h às 16h. Ativei lembrete por Telegram 1h antes.").
- Após `block_calendar`, **sempre** mencione a contagem de conflitos retornada e ofereça remarcar.
- Em consultas, formate horários como `dd/mm às HH:MM`.
- Mantenha respostas curtas e em PT-BR.

```
