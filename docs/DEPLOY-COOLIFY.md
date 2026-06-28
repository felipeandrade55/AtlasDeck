# Deploy do AtlasDeck no Coolify (padrão SaaS — 1 projeto por cliente)

Este é o método **padrão** para entregar o AtlasDeck a um cliente novo. Cada
cliente vira **um projeto** dedicado no Coolify, com seu próprio domínio, dados
e bot. O sistema sobe **containerizado** (AtlasDeck + OpenClaw juntos, sob PM2),
e o onboarding (modelo de IA, personalidade do bot, dados do dono, Telegram) é
feito por um **wizard web** no primeiro acesso — o cliente leigo não toca em
terminal nem em container.

> O modo **VPS nativo** (como o produto roda no VPS do dono) continua disponível
> e inalterado — veja [DEPLOY-VPS-NATIVO.md](./DEPLOY-VPS-NATIVO.md).

---

## Como funciona a imagem

A raiz do repo tem uma imagem **all-in-one** (`Dockerfile`) que empacota:

- **AtlasDeck** (Next.js, porta 3000) — a interface/dashboard.
- **OpenClaw** (`openclaw@latest`, gateway WebSocket na porta 18789) — o runtime do bot.
- Ambos supervisionados por **PM2** (`pm2-runtime` como PID 1), via
  [`docker/atlasdeck/ecosystem.config.js`](../docker/atlasdeck/ecosystem.config.js).

Pontos-chave (já resolvidos, não precisa mexer):

- **Node 22** é obrigatório — o OpenClaw exige Node ≥ 22.19 (em Node 20 o pacote npm vira um placeholder vazio).
- O gateway roda em foreground com `openclaw gateway run` (não usamos o serviço systemd dentro do container).
- O nome do processo PM2 `openclaw-gateway` é reconhecido pelo `gateway-control.ts`, então o botão "Reiniciar Gateway" e o self-heal funcionam dentro do container.
- O [`docker-entrypoint.sh`](../docker/atlasdeck/docker-entrypoint.sh) é idempotente: cria os diretórios, semeia segredos (`AUTH_SECRET`/`ADMIN_PASSWORD` se não vierem do painel), cria a config baseline do OpenClaw e valida antes de subir.
- Dois **volumes persistentes** guardam tudo entre re-deploys:
  - `atlasdeck-data` → `/app/data` (SQLite, segredos gerados, configs JSON)
  - `openclaw-home` → `/root/.openclaw` (openclaw.json, workspace, auth do modelo)

O **módulo Pentest** (sidecar Kali pesado) fica sob o profile `pentest` no
[`docker-compose.coolify.yml`](../docker-compose.coolify.yml) e **não** sobe por
padrão — ative só para clientes que contratarem.

---

## Caminho A — Automatizado (recomendado, rotineiro)

Provisiona um cliente inteiro via API do Coolify com um comando.

```bash
export COOLIFY_URL="http://SEU_IP:8000"
export COOLIFY_TOKEN="seu-token-da-api"   # Coolify → Keys & Tokens → API tokens

node scripts/provision-client.mjs --name "Cliente XYZ" --slug cliente-xyz
# opcional: --domain app.cliente.com   (senão o Coolify gera um domínio sslip.io com SSL)
# opcional: --no-deploy                (cria tudo mas não dispara o build)
```

O script ([scripts/provision-client.mjs](../scripts/provision-client.mjs)):

1. cria o **projeto** `AtlasDeck — Cliente XYZ`;
2. cria a **aplicação** a partir do repo público, `build_pack=dockercompose`,
   lendo `docker-compose.coolify.yml`, com **auto-deploy on push** ligado;
3. injeta as **envs** (`ATLASDECK_DEPLOY_MODE=coolify`, `ADMIN_PASSWORD` e
   `AUTH_SECRET` aleatórios, branding);
4. dispara o **primeiro deploy**;
5. imprime a **URL** e a **senha de admin**.

Ao final, acesse a URL, faça login com a senha impressa e siga o wizard.

---

## Caminho B — Manual pela interface do Coolify

Use quando quiser fazer na mão ou entender o que o script faz.

1. **Novo projeto:** Coolify → Projects → **+ New** → nome `AtlasDeck — Cliente XYZ`.
2. **Novo recurso:** dentro do projeto (ambiente `production`) → **+ New Resource**
   → **Public Repository**.
   - Repository: `https://github.com/felipeandrade55/AtlasDeck.git`
   - Branch: `main`
   - Build Pack: **Docker Compose**
   - Docker Compose Location: `/docker-compose.coolify.yml`
3. **Domínio:** deixe o Coolify gerar (sslip.io, já com SSL) **ou** informe um
   domínio próprio. Para padronizar como SaaS, configure um **wildcard**
   `*.seudominio.com` apontando para o IP do servidor (Coolify → Server →
   Settings → *Wildcard Domain*); aí cada cliente vira `cliente.seudominio.com`.
   O serviço que recebe o domínio é o **`app`** (porta 3000).
4. **Variáveis de ambiente** (Environment Variables):
   | Chave | Valor |
   |-------|-------|
   | `ATLASDECK_DEPLOY_MODE` | `coolify` |
   | `ADMIN_PASSWORD` | (uma senha forte — será a senha de login) |
   | `AUTH_SECRET` | (32+ bytes aleatórios; `openssl rand -base64 32`) |
   | `NEXT_PUBLIC_AGENT_NAME` | nome do assistente (branding) |

   > Se você **não** definir `ADMIN_PASSWORD`/`AUTH_SECRET`, o container gera e
   > persiste no volume (`/app/data/.container-secrets.env`) — mas aí você precisa
   > ler o log/arquivo para descobrir a senha. Definir no painel é mais prático.
5. **Auto-deploy:** garanta que *Auto Deploy* está ligado (deploy automático a
   cada push na `main`). Para repos públicos, adicione o **webhook** do Coolify
   nas configurações do repositório GitHub (Coolify mostra a URL do webhook na
   aba do recurso).
6. **Deploy.** Acompanhe o build; o `start_period` do healthcheck é generoso
   (~90s) porque o gateway do OpenClaw leva alguns segundos para subir.
7. Acesse a URL → login com `ADMIN_PASSWORD` → **wizard de onboarding**.

---

## O wizard de onboarding (primeiro acesso)

No modo `coolify`, o wizard:

1. **Instalar** → detecta que o OpenClaw já vem embutido e segue (sem `npm install`).
2. **Modelo de IA** → padrão **"Entrar com OpenAI"** (OAuth *device-code*): mostra
   um link + código; o cliente autoriza no navegador, sem comandos. Alternativa:
   colar uma chave de API (Anthropic/OpenAI/Google) ou usar Ollama.
3. **Personalidade** → entrevista guiada que coleta nome do bot, personalidade e
   dados do dono (gera IDENTITY.md/SOUL.md/USER.md).
4. **Aplicar configuração** → barra de progresso que sanea a config, reinicia o
   gateway e espera ficar pronto (com auto-recuperação se demorar).
5. **Telegram** → passo a passo de criar o bot no @BotFather, colar token e parear
   o chat (QR/deep-link) automaticamente.
6. **Pronto.**

---

## Atualização (CI/CD)

Todos os clientes seguem a **mesma `main`** do GitHub. Um `git push` na `main`
faz o Coolify **re-deployar automaticamente** cada projeto (auto-deploy on push).
Os **volumes persistem**, então dados e configuração do cliente são preservados.

---

## Self-healing / anti-falha

- `restart: unless-stopped` (container) + `autorestart` (PM2) recuperam processos que caem.
- `HEALTHCHECK` do Docker + `/api/health` informam o Coolify quando algo degrada.
- O `health-monitor` do app gera notificação e reinicia o gateway via PM2 sozinho.
- O entrypoint roda `openclaw config validate` no boot (evita boot-loop por schema inválido).

---

## Solução de problemas

| Sintoma | Verificar |
|--------|-----------|
| App "healthy" mas domínio dá 404 / "no available server" | O domínio precisa estar **mapeado ao serviço `app`** do compose (`docker_compose_domains`). O `provision-client.mjs` faz isso automaticamente; na UI, configure o domínio no serviço `app` (porta 3000) e re-deploye. |
| App não fica "healthy" | Logs do deploy no Coolify; o gateway leva ~30s na 1ª subida. `/api/health` mostra o status de cada dependência. |
| Não sei a senha de admin | Defina `ADMIN_PASSWORD` nas envs do app; ou leia `/app/data/.container-secrets.env` no volume. |
| OAuth da OpenAI não conclui | Confirme que o cliente autorizou o **código** mostrado; o passo "Usar chave de API" é o fallback. |
| Gateway não sobe | Veja os logs do app (PM2 `openclaw-gateway`); o botão "Reiniciar Gateway" em /settings também funciona no container. |
| Domínio sem SSL | DNS do domínio precisa apontar para o IP antes do Let's Encrypt emitir. Domínio sslip.io já vem com SSL. |
