/**
 * Templates used by the calendar installer.
 *
 * Single source of truth for the OpenClaw skill content (SKILL.md) and the
 * AGENTS.md available-skills entry. Used both by the API installer route and
 * by the standalone script at scripts/setup-calendar.mjs.
 */

export const SKILL_NAME = "atlasdeck-calendar";

export const SKILL_MD_TEMPLATE = `---
name: ${SKILL_NAME}
description: Gerencia a agenda pessoal no AtlasDeck (criar/editar/listar/excluir eventos, bloquear horários, resolver remarcações, compartilhar links de booking). Use sempre que o usuário pedir algo sobre compromissos, reuniões, agenda, "bloqueia", "agenda", "marca", "remarca", "remarcar", "cancela compromisso", "envia meu link".
emoji: 📅
homepage: https://atlasdeck/calendar
---

# atlasdeck-calendar

Você está conectado à agenda do dono pelo AtlasDeck via HTTP REST. Use SEMPRE estas tools quando o usuário falar sobre compromissos. O usuário pode pedir em linguagem natural — você é responsável por interpretar a expressão temporal e converter para ISO 8601 com timezone explícito (use o TZ do dono, padrão \`America/Sao_Paulo\` -03:00, salvo informação em contrário).

## Variáveis de ambiente

- \`ATLASDECK_BASE_URL\` — URL base do dashboard (ex: \`http://localhost:3000\`)
- \`OPENCLAW_GATEWAY_TOKEN\` — Token de serviço (definido em \`openclaw.json -> gateway.auth.token\`)

Toda requisição inclui o header \`x-openclaw-token: $OPENCLAW_GATEWAY_TOKEN\`.

## Interpretação de tempo (PT-BR)

| Expressão | Interpretação |
|---|---|
| "hoje à tarde" | hoje 13:00–18:00 |
| "hoje à noite" | hoje 18:00–23:59 |
| "manhã" / "de manhã" | 08:00–12:00 |
| "amanhã" (sem hora) | dia inteiro de amanhã (00:00–23:59), \`all_day=true\` |
| "depois de amanhã" | dia inteiro D+2 |
| "esta semana" | de hoje 00:00 até domingo 23:59 |
| "semana que vem" | de segunda 00:00 a domingo 23:59 da próxima semana |
| "este mês" | hoje 00:00 → último dia do mês 23:59 |
| "sexta" / "na sexta" | próxima sexta-feira (dia inteiro se sem hora) |
| "das 14h às 16h" + dia | janela específica naquele dia |
| "a tarde toda" + dia | 13:00–18:00 daquele dia |

Em casos ambíguos, **confirme o range entendido antes de chamar a tool**.
Após criar/editar/remarcar, sempre **resuma o resultado** ao usuário.

## Tools

### create_event
\`\`\`
POST {ATLASDECK_BASE_URL}/api/calendar/events
Body: { "title": "...", "start_at": "ISO", "end_at": "ISO", "all_day": false, "source": "openclaw", "reminders": [{"minutes_before": 15, "channel": "notification"}] }
\`\`\`

### list_events
\`\`\`
GET {ATLASDECK_BASE_URL}/api/calendar/events?from=ISO&to=ISO
\`\`\`

### update_event / delete_event
\`\`\`
PATCH {ATLASDECK_BASE_URL}/api/calendar/events/{id}
DELETE {ATLASDECK_BASE_URL}/api/calendar/events/{id}
\`\`\`

### find_free_slots
\`\`\`
GET {ATLASDECK_BASE_URL}/api/calendar/availability?date=YYYY-MM-DD&duration=30
\`\`\`

### block_calendar / unblock_calendar
\`\`\`
POST {ATLASDECK_BASE_URL}/api/calendar/blocks
Body: { "start_at": "ISO", "end_at": "ISO", "all_day": true, "reason": "..." }

DELETE {ATLASDECK_BASE_URL}/api/calendar/blocks/{id}
\`\`\`
Resposta inclui \`conflicts: N\`. Se N > 0 → avise o usuário e ofereça \`list_to_reschedule\`.

### list_to_reschedule / suggest_reschedule / reschedule_event
\`\`\`
GET {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue?status=pending
GET {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue/{queueId}/suggestions
POST {ATLASDECK_BASE_URL}/api/calendar/reschedule-queue/{queueId}/reschedule
Body: { "new_start_at": "ISO" }
\`\`\`

### list_pending_bookings / approve_booking / reject_booking
\`\`\`
GET {ATLASDECK_BASE_URL}/api/calendar/bookings?status=pending
POST {ATLASDECK_BASE_URL}/api/calendar/bookings/{id}/approve
POST {ATLASDECK_BASE_URL}/api/calendar/bookings/{id}/reject  Body: { "reason": "..." }
\`\`\`

### share_booking_link
\`\`\`
POST {ATLASDECK_BASE_URL}/api/calendar/share
Body: { "linkId": "...", "chatId": "<telegram_chat_id>", "customText": "Oi, agenda comigo:" }
\`\`\`

## Exemplos de comando → tool call

- *"Agenda reunião com Maria amanhã às 15h"* → \`create_event(start_at="<amanhã>T15:00:00-03:00", end_at="<amanhã>T16:00:00-03:00")\`
- *"Quais meus compromissos de sexta?"* → \`list_events(from="<sexta>T00:00", to="<sexta>T23:59")\`
- *"Bloqueia minha agenda amanhã"* → \`block_calendar(all_day=true, start_at="<amanhã>T00:00", end_at="<amanhã>T23:59")\`
- *"Bloqueia esta semana"* → \`block_calendar(start_at="<hoje>T00:00", end_at="<domingo>T23:59", all_day=true)\`
- *"Bloqueia hoje à tarde"* → \`block_calendar(start_at="<hoje>T13:00", end_at="<hoje>T18:00")\`
- *"Bloqueia amanhã das 14h às 18h, médico"* → \`block_calendar(start_at="<amanhã>T14:00", end_at="<amanhã>T18:00", reason="médico")\`
- *"Quais agendas preciso remarcar?"* → \`list_to_reschedule()\` → lista numerada
- *"Remarca o primeiro pra quarta 10h"* → \`reschedule_event(queueId, new_start_at="<quarta>T10:00:00-03:00")\`
- *"Manda meu link de 30min pro chat do Felipe"* → \`share_booking_link(linkId, chatId)\`

## Diretrizes

- Sempre confirme verbalmente após qualquer ação (ex: "Pronto, agendei sua reunião com Maria amanhã das 15h às 16h, lembrete por Telegram 15min antes.").
- Após \`block_calendar\`, **sempre** mencione a contagem de conflitos retornada e ofereça remarcar.
- Formate horários como \`dd/mm às HH:MM\`.
- Respostas curtas, em PT-BR.
`;

export const AGENTS_MD_SKILL_ENTRY = SKILL_NAME;
