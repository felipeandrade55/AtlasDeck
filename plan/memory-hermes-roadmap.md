# Roadmap: Memória estilo Hermes Agent

**Objetivo:** levar o sistema de memória do AtlasDeck ao patamar do
[Hermes Agent](https://hermes-ai.net/) (Nous Research) — um assistente que
**aprende sozinho e evolui**, sem o usuário precisar pedir ou mandar `/new`.
A base já existe (extração + FTS + embeddings + injection + learner); falta
torná-la proativa e dar a ela a capacidade de virar experiência em skill.

> Contexto de como chegamos aqui: a memória do Jarvis estava quebrada em 3
> camadas (codex-home/config.toml, alias `@/` sob tsx, app-server de vida
> longa) — corrigido. E o motor de extração automática estava DESLIGADO por
> duas `instrumentation.ts` divergentes — corrigido (commit 0323b2f).
> Detalhes nas memórias do projeto.

---

## Itens

### 1. Guidance proativa de memória  🚧 EM ANDAMENTO
Fazer o Jarvis salvar memória **proativamente** (sem esperar "lembre disso")
e **nunca alucinar** que salvou sem chamar a tool.

- [x] Reforçar `TOOL_GUIDANCE` (memory-injector.ts) com: regra inviolável
      (nunca dizer "salvei" sem chamar `memory_add`), captura proativa de
      fatos duráveis, e reflexo de fim de turno estilo Hermes. _(commit
      pendente nesta leva)_
- [ ] Deploy via auto-update + re-injetar guidance no MEMORY.md (botão
      "Atualizar AUTO-RECALL nos MEMORY.md" ou esperar o injection scheduler
      ~30min, agora que ele voltou a rodar).
- [ ] Validar no Telegram: conversa normal (sem pedir) gera `memory_add`.

### 2. Skills-from-experience  ⬜ PENDENTE
O diferencial do Hermes: quando algo funciona, virar **skill reutilizável**
que é carregada da próxima vez que um problema parecido aparece.

- [ ] Definir formato de "skill aprendida" (arquivo/registro + quando carregar).
- [ ] Job periódico que revisa sessões/sucessos e propõe skills (LLM).
- [ ] Carregamento das skills no contexto do agente (via MEMORY.md ou MCP).
- [ ] UI pra revisar/aprovar skills aprendidas.

### 3. Round-2 do MCP (blindagem)  ⬜ PENDENTE
Remover a dependência da edição manual e fechar o ponto cego do diagnose.

- [ ] "Ativar memória avançada" projeta o bloco `[mcp_servers]` direto no
      `codex-home/config.toml` do agente (hoje depende da projeção do
      OpenClaw a partir do openclaw.json, ou da edição manual).
- [ ] Diagnose checar `ListTools` **não-vazio** (não só "boot ok") — pra
      "registra 0 tools mas diz pronto" nunca mais passar batido.
- [ ] Botão de respawn real do Codex app-server (não só `systemctl restart`).

---

_Atualizado conforme avançamos. Itens concluídos viram ✅._
