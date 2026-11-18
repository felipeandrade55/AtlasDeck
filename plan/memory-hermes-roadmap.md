# Roadmap: Memória estilo Hermes Agent

**Objetivo:** um assistente que **lembra** do que foi dito e **aprende com o uso**
(preferências, clientes, identidade visual, procedimentos) — e pergunta antes de
reaproveitar trabalho de um cliente em outro.

Motor v2 implementado na branch `feat/memory-engine` (nov/2026). Antes dele, a
extração chamava `openclaw ask|chat|complete` (inexistentes) e caía numa
heurística que salvava "Usuário pediu: …"; o recall era uma lista fixa de
títulos no MEMORY.md; preferências só vinham de aprovação de tasks e nunca
chegavam aos especialistas; não havia modelo de clientes/marcas.

---

## Arquitetura v2

```
Telegram/WhatsApp ─► Gateway OpenClaw ─► plugin atlasdeck-bridge (opt-in)
                                           before_prompt_build → /api/memory/turn-context
                                           agent_end           → /api/memory/turn-capture
                                           session_end         → /api/memory/session-event
Chat web ─────────► /api/chat/stream (injeta turn-context direto)

chats.db (transcrição canônica) ─► extrator (fila, idle ≥90s, 1 chamada por vez)
   └─ llm-oneshot: `openclaw infer model run` → fallback `openclaw agent`
   └─ ops ADD/UPDATE/SUPERSEDE/NOOP contra memórias existentes
   └─ entities / deliverables / preferences / session_summary
memories.db: memories (+FTS5, e5 multilíngue), entities, deliverables,
             recall_log, turn_sessions, extraction_runs, memory_jobs
reflexão noturna: dedupe + perfil no USER.md + procedimentos em teste
```

Arquivos principais: `src/lib/memory-extractor.ts`, `memory-service.ts`,
`turn-context.ts`, `reuse-context.ts`, `entity-db.ts`, `llm-oneshot.ts`,
`reflection-job.ts`, `delegation-context.ts`, `openclaw-plugin/atlasdeck-bridge/`.
UI: Memória → **Aprendizado**.

## Status

| Fase | Item | Status |
|---|---|---|
| 0 | Diagnóstico no VPS (versão OpenClaw, JSONL vs SQLite, hooks, `infer`) | ⬜ pendente — precisa de acesso SSH |
| 1 | Extração via OpenClaw real, sem heurística, cursores corrigidos, falhas visíveis | ✅ |
| 1 | Busca híbrida FTS5 + e5 multilíngue, dedupe semântico, MCP via HTTP | ✅ |
| 1 | Instrução única de memória, trava no MEMORY.md, sem nome fixo | ✅ |
| 2 | Contexto por turno no chat web | ✅ |
| 2 | Plugin bridge (Telegram) + rotas + instalador com validação/rollback | ✅ código · ⬜ validar no VPS |
| 2 | Continuidade ao trocar de sessão (resumos recentes + preferências) | ✅ |
| 2 | Rotação do watchdog via compactação em vez de rename | ⬜ depende da Fase 0 |
| 3 | `conversation_search` / `conversation_get` | ✅ |
| 4 | Clientes, brand kit, entregas, pergunta de reaproveitamento | ✅ |
| 5 | Preferências da conversa, reforço por similaridade, perfil no USER.md | ✅ |
| 6 | Contexto para especialistas na delegação | ✅ |
| 7 | Procedimentos em período de teste; export SKILL.md | ✅ (export opt-in `ATLAS_AUTO_SKILLS=1`) |
| 8 | Reprocessar últimos 90 dias (botão com estimativa) | ✅ |

## Para validar no VPS (Fase 0 — somente leitura)

```
openclaw --version
ls -lat ~/.openclaw/agents/main/sessions | head; ls -la ~/.openclaw/agents/main/agent/
openclaw infer model run --help
openclaw plugins list; openclaw hooks list
openclaw infer model run --prompt "Responda exatamente: pong" --json   # gasta poucos tokens
```

Depois: Memória → Aprendizado → **Instalar plugin**, mandar uma mensagem no
Telegram e conferir "Plugin ativo".

## Variáveis de ajuste

- `MEMORY_LLM_MODEL` — modelo para extração/reflexão (padrão: o do gateway)
- `MEMORY_LLM_AGENT` — agente usado no fallback `openclaw agent` (padrão `main`)
- `MEMORY_EXTRACTION_INTERVAL_MS` (3 min), `MEMORY_EXTRACTION_MAX_BATCHES` (6)
- `ATLAS_EMBEDDING_MODEL` (padrão `Xenova/multilingual-e5-small`)
- `ATLAS_SIM_RELEVANT` / `ATLAS_SIM_RELATED` / `ATLAS_SIM_DUPLICATE`
- `ATLAS_AUTO_SKILLS=1` — exporta procedimentos promovidos como SKILL.md
- `ATLAS_MEMORY_WHATSAPP=1` — libera memória no WhatsApp (padrão: bloqueado, modo assessor fala com terceiros)
