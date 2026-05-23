# OpenClaw Realtime Chat — diagnóstico do "Respondi no chat"

**Status:** em investigação · **Última atualização:** 2026-05-23
**Owner:** Felipe + Claude (sessão Opus 4.7)
**Branch base:** `main`

---

## 1. Sintoma

Ao perguntar qualquer coisa no chat do AtlasDeck (`https://atlasdeck.egis.app.br/chat`), o agente devolve um stub do tipo:

> "Respondi no chat com uma explicação de `BGP` em 3 linhas."

em vez da resposta real. A latência do turno é altíssima (11s–55s) — incompatível com uma resposta de poucos tokens.

Telemetria do badge na bolha: `WS · handshake=2ms · hello-ok=12ms · 1st-delta=55.9s · final=55.9s · buffered`.

Dois banners amarelos aparecem por causa disso:
1. **Latência: gateway está bufferizando** (heurística: `first-delta ≈ final`).
2. **Agente respondeu como notificação ("Respondi no chat")** (heurística: a resposta começa com "respondi no chat" / "respondi via chat" / "já respondi").

---

## 2. Mudanças já aplicadas no AtlasDeck

### Commit [`01ac885`](https://github.com/felipeandrade55/AtlasDeck/commit/01ac885) — fix(chat): banners stub/buffered com ações + badge na bolha + forceInline
- `MessageBubble.tsx`: badge amarelo "Stub de notificação" inline quando `stubReply=true`, para deixar claro que aquela bolha **não é a resposta real**.
- Banner buffered: botão **Copiar JSON** (clipboard do snippet `blockStreamingDefault/Break/Chunk`).
- Banner stubReply: botão **Forçar resposta direta** — reenvia a última pergunta do usuário com `forceInline: true`.
- `/api/chat/stream`: aceita `forceInline` no body e anexa um `FORCE_INLINE_HINT` **somente ao prompt enviado ao runner** (a mensagem persistida no chat-db continua sendo o texto original — histórico não é poluído pelo hint).
- `useChatStream.ts`: propaga `forceInline`.
- `src/components/chat/MessageBubble.tsx`, `src/components/chat/useChatStream.ts`, `src/app/(dashboard)/chat/page.tsx`, `src/app/api/chat/stream/route.ts`.

### Commit [`525fe10`](https://github.com/felipeandrade55/AtlasDeck/commit/525fe10) — fix(actions): restart-gateway funciona sem systemd
- `src/app/api/actions/route.ts` `case 'restart-gateway':` agora tem 2 estratégias:
  1. **systemd** — `systemctl restart openclaw-gateway` (compat com setup original).
  2. **fallback pgrep+respawn** — quando a unit não está `active`:
     - `pgrep -f 'openclaw.*gateway|openclaw/dist/index\.js gateway'`
     - lê `argv`/`cwd`/`env` de `/proc/<pid>/` (cmdline NUL-separated)
     - `SIGTERM` → 5s de graça → `SIGKILL` se ainda vivo
     - `child_process.spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore' })` + `unref()`
     - confirma com `pgrep` de novo

### Banners e detecções (já existiam antes desta sessão)
- `src/app/api/chat/stream/route.ts`:
  - `stubReplyDetected` (linhas ~270): regex sobre a resposta assembled — `startsWith("respondi no chat" | "respondi via chat" | "já respondi" | "ja respondi")`.
  - `bufferedDetected` (linhas ~335): `Math.abs(timings.final - timings["first-delta"]) < 100`.
  - Ambos emitidos no evento SSE `done` + atualizados live no evento `provider`.

---

## 3. O que descobrimos no servidor (sessão de debug)

### 3.1 Gateway NÃO é systemd, é processo direto

```
root  599325  /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

PM2 só gerencia `atlasdeck` (id 0). `systemctl list-units | grep -i claw` retorna vazio. Por isso o botão "Reiniciar Gateway" antigo falhava com `Unit openclaw-gateway.service not found` — o commit `525fe10` resolveu isso.

### 3.2 Confirmamos que respawn funciona

Após o usuário executar manualmente via SSH:
```bash
PID=$(pgrep -f "openclaw.*gateway" | head -1)
CMDLINE=$(tr '\0' ' ' </proc/$PID/cmdline)
CWD=$(readlink /proc/$PID/cwd)
kill $PID; sleep 2
( cd "$CWD" && setsid nohup $CMDLINE </dev/null >/tmp/openclaw-gateway.log 2>&1 & )
```

PID mudou de `599325` para `618275`. Gateway voltou a aceitar requests.

### 3.3 Apesar do restart, o stub persistiu

Pergunta válida testada: `me explique BGP em 3 linhas`. Resposta: `"Respondi no chat com uma explicação curta de BGP em 3 linhas."` Tempo: 55.9s.

### 3.4 AGENTS.md tem a regra no topo, mas é ignorado

Usuário ajustou `~/.openclaw/workspace/AGENTS.md` adicionando ANTES de qualquer outra seção:

```markdown
## Roteamento de resposta

- Quando `sessionKey` começa com `web:` (ex.: `web:atlasdeck`), responda diretamente nesta sessão com o conteúdo completo.
- NÃO use `sessions_send` para outro canal nesses casos.
- NÃO envie stub como "Respondi no chat".
- `sessions_send` só deve ser usado quando explicitamente solicitado pelo usuário ou para encaminhar para `telegram:` em background.
```

Mesmo assim o stub continua.

### 3.5 TOOLS.md e openclaw.json estão limpos

```
grep -in "sessions_send\|web:\|respondi\|chat" ~/.openclaw/workspace/TOOLS.md
→ (sem matches)

grep -A 3 -iE "agents\.main|defaultDestination|fallbackChannel|notification|sessions_send" ~/.openclaw/openclaw.json
→ (vazio)
```

Não há regra de roteamento conflitante nesses arquivos.

---

## 4. Hipótese principal (a peça que mudou tudo)

**Este NÃO é um setup OpenClaw "padrão" — é um sistema multi-agente autônomo em Python sobre o OpenClaw gateway.**

O `head -100 ~/.openclaw/workspace/AGENTS.md` revelou:

> **# AGENTS.md - Sistema Multi-Agente (10 Agentes Autonomos)**
>
> ### @jarvis — Agente Principal
> - **Model**: deepseek-v3.2 | **Iterations**: 50 | **Tools**: 18
> - **Funcao**: Coordenador geral, busca PNCP, analise AI, **Telegram**, automacao
> - **Capabilities**: pncp_search, ai_analysis, **telegram**, shell, vm_access, enrich_project
>
> ## Arquitetura
> - **Base**: `autonomous_base.py` — loop DeepSeek tool-use compartilhado (AutonomousAgent class)
> - **Execucao**: `agent_executor.py` — dispatcher que roda o handler de cada agente
> - **Heartbeat**: a cada 15 min, verifica WORKING.md + @mentions + executa tasks pendentes
> - **Memory Engine**: 4 camadas (File Memory → Redis cache → SQLite persistente → Ollama embeddings semantico)
> - **Models**: configurados em `/root/.openclaw/openrouter.json` campo `agent_models`

O que isso implica:

1. **AGENTS.md é documentação humana, não config carregada pelo gateway.** O loop autônomo é Python; o `system_prompt` real enviado a `deepseek-v3.2` é construído em código, não lido do markdown.
2. O agente `@jarvis` tem a tool **`telegram`** registrada como capability. Quando recebe uma pergunta, o loop autônomo (até 50 iterações de tool-use) escolhe usar `sessions_send`/`telegram` para entregar a resposta real ao Telegram, e devolve "Respondi no chat" como meta-resposta para a sessão originadora.
3. A latência de 55.9s é coerente com **isso**: é o agente rodando seu loop, possivelmente chamando ferramentas (pncp_search, ai_analysis, telegram, …) antes de declarar concluído.
4. A regra de roteamento que o Felipe colocou em AGENTS.md foi vista pelo modelo como **texto de contexto**, não como restrição executável — o dispatcher Python continua expondo a tool `telegram` no tool registry da chamada.

**Conclusão:** o fix precisa ser no **código Python do agente**, não em markdown.

---

## 5. Estado da workspace do servidor

```
~/.openclaw/workspace/
├── AGENTS.md            ← documentação (foi onde tentamos colocar a regra)
├── TOOLS.md             ← limpa, sem regras conflitantes
├── MEMORY.md, IDENTITY.md, SOUL.md, USER.md, WORKING.md, HEARTBEAT.md
├── mission-control/     ← provavelmente onde mora o código Python (autonomous_base.py, agent_executor.py, agentes individuais)
├── memory/              ← persistência semântica
├── skills/, plugins/, scripts/, dashboard/, state/, config/
└── …
```

Models em `/root/.openclaw/openrouter.json` campo `agent_models`.

---

## 6. Próximos passos (onde parar e retomar)

### 6.1 Investigação imediata pendente

Pedi ao Felipe (e ainda preciso da resposta) o output de:

```bash
# 1. Estrutura do mission-control
ls ~/.openclaw/workspace/mission-control/

# 2. Onde mora o agent_executor + autonomous_base + jarvis
find ~/.openclaw/workspace/mission-control -maxdepth 4 \
  -name "agent_executor.py" -o -name "autonomous_base.py" -o -name "jarvis*"

# 3. Onde sessions_send/telegram é registrado
grep -rn "sessions_send\|'telegram'\|\"telegram\"" \
  ~/.openclaw/workspace/mission-control --include="*.py" | head -30

# 4. Onde o system prompt é montado
grep -rn "system_prompt\|SYSTEM_PROMPT\|build_prompt\|sessionKey" \
  ~/.openclaw/workspace/mission-control --include="*.py" | head -30

# 5. Config dos modelos
cat /root/.openclaw/openrouter.json | head -40
```

### 6.2 Pontos de ataque possíveis (após ver o código)

Em ordem de preferência:

**A. Skip tools no tool registry quando `sessionKey.startswith("web:")`**
Edita `autonomous_base.py` (ou onde quer que `TOOL_REGISTRY` seja filtrado antes da chamada). Algo como:
```python
if session_key.startswith("web:"):
    tools = [t for t in tools if t.name not in {"sessions_send", "telegram_send"}]
```
**Vantagem:** o modelo não tem como rotear porque a tool não está disponível. Resposta vem inline forçadamente.
**Risco:** baixo — só remove opções de roteamento, não muda comportamento de outras tools.

**B. Injetar instrução no `system_prompt` por sessão**
Quando `sessionKey.startswith("web:")`, prepend ao system prompt:
> "Esta sessão é uma interface web ativa. Responda EXCLUSIVAMENTE com a resposta final em texto. NÃO chame `sessions_send`, `telegram_send` ou qualquer tool de notificação. Não diga 'Respondi no chat'."

**Vantagem:** menos invasivo.
**Risco:** modelo pode ignorar (foi o que aconteceu com a regra em AGENTS.md).

**C. Wrapper na tool `sessions_send`/`telegram`**
Faz a tool retornar erro/no-op quando `sessionKey.startswith("web:")` E `target` é outro canal.

**Vantagem:** defesa em profundidade.
**Risco:** o modelo pode entrar em loop tentando outras tools.

**D. (Já está pronto no AtlasDeck — só aguarda o fix B/C/D) Forçar inline pelo cliente**
O botão **Forçar resposta direta** (commit `01ac885`) já está pronto e ativo. Reenvia a pergunta com `FORCE_INLINE_HINT` anexado. Mas é workaround manual, não o fix real.

### 6.3 Validação após fix

```
Pergunta: "me explique BGP em 3 linhas"
Esperado:
  - bolha SEM badge stubReply
  - banner amarelo de stub NÃO aparece
  - latência < 10s (sem loop de tool-use desnecessário)
  - resposta com conteúdo técnico real sobre BGP
  - badge no rodapé sem flag "buffered" (precisa fix separado em openclaw.json)
```

### 6.4 Buffered (paralelo, mas independente)

O banner `buffered` (`first-delta ≈ final`) é problema **separado** do stub. Mesmo após resolver o roteamento, vai continuar até o Felipe editar `~/.openclaw/openclaw.json`:

```json
"agents": {
  "defaults": {
    "blockStreamingDefault": "on",
    "blockStreamingBreak": "text_end",
    "blockStreamingChunk": { "minChars": 50, "maxChars": 200 }
  }
}
```

Depois: respawn do gateway (botão `Reiniciar Gateway` ou comando SSH).

---

## 7. Workarounds em vigor enquanto não há fix no Python

| Workaround | Onde | Status |
|---|---|---|
| Badge visual "Stub de notificação" na bolha | `MessageBubble.tsx` | ✅ deployado (`01ac885`) |
| Botão "Forçar resposta direta" no banner stubReply | `chat/page.tsx` | ✅ deployado |
| Hint `FORCE_INLINE_HINT` anexado ao prompt quando `forceInline=true` | `api/chat/stream/route.ts` | ✅ deployado |
| Botão "Copiar JSON" para a config de streaming | `chat/page.tsx` banner buffered | ✅ deployado |
| Restart de gateway via pgrep+respawn (sem systemd) | `api/actions/route.ts` | ✅ deployado (`525fe10`) |

Estes paliativos cobrem a UX, mas **não eliminam** a chamada desnecessária ao Telegram, nem reduzem latência para perguntas web. O fix real está bloqueado em (6.2).

---

## 8. Como retomar esta investigação no futuro

Se você (Claude) está lendo isso numa próxima sessão:

1. Cheque se os outputs da seção **6.1** já foram coletados — se sim, devem estar como mensagens recentes no transcript ou anexados aqui.
2. Caso ainda não tenha o código Python do jarvis, peça os mesmos `find`/`grep`/`cat` da seção 6.1.
3. Cole o arquivo `autonomous_base.py` (ou equivalente) aqui no plan.md numa nova seção "9. Código do agente".
4. Identifique a função/método que constrói o tool registry por chamada — esse é o ponto de injeção do fix A (skip tools por `sessionKey`).
5. Identifique a função/método que constrói o `system_prompt` — ponto de injeção do fix B.
6. Implemente A (preferencial) ou B; teste com "me explique BGP em 3 linhas" no chat web; confirme que o badge stubReply some, latência cai e a resposta é real.
7. Não esqueça do **buffered** — passo paralelo na seção 6.4 (editar `openclaw.json` server-side).

### Pistas relevantes do AtlasDeck (apenas leitura, não deve ser editado neste fix)

- `src/lib/openclaw-ws-client.ts`: WS protocol `connect → chat.send`. `sessionKey` que vai pra esse setup é `web:atlasdeck` (confirmado pelo banner). Ver `chat.send params` (linhas ~222-238) — `thinking` e `fastMode` são opt-in via env, atualmente não enviados.
- `src/lib/openclaw-runner.ts:62`: `chatChannelTarget()` retorna `process.env.ATLAS_CHAT_TO || "web:atlasdeck"`. É esse valor que vai no `--to` do CLI e no `sessionKey` do WS.
- A heurística stubReply pode pegar falsos positivos se o agente legitimamente começar uma resposta com "Respondi no chat com…". Após o fix Python, vale considerar tornar a detecção mais conservadora (ex.: exigir resposta `< 200 chars` E começar com a frase).

---

## 9. Histórico de tentativas que NÃO funcionaram

| # | Tentativa | Resultado |
|---|---|---|
| 1 | Editar AGENTS.md adicionando "Roteamento de resposta" no topo | ❌ Ignorado pelo agente |
| 2 | `systemctl restart openclaw-gateway` | ❌ Unit não existe |
| 3 | SSH manual: `kill PID && setsid nohup ... &` | ✅ Gateway respawnou (PID `599325` → `618275`), mas stub persistiu |
| 4 | Testar com pergunta clara digitada (`me explique BGP em 3 linhas`) | ❌ Continuou stub com latência 55.9s |

A persistência do stub mesmo após restart confirma que **AGENTS.md não é a fonte de verdade** — o comportamento vive no código Python do agente.
