# Deploy do AtlasDeck nativo no VPS (sem container)

Este é o modo como o AtlasDeck roda hoje no VPS do dono, e a opção para clientes
que querem usar o **próprio VPS** em vez do Coolify. Aqui o app roda **nativo**
(Node + PM2/systemd) ao lado de uma instalação do OpenClaw no mesmo host.

> Para o método padrão (containerizado, 1 projeto por cliente), veja
> [DEPLOY-COOLIFY.md](./DEPLOY-COOLIFY.md). **Nada neste modo é afetado** pela
> containerização — `ATLASDECK_DEPLOY_MODE` fica ausente (= `native`).

---

## Requisitos

- **Node.js ≥ 22.19** (o OpenClaw exige; testado com v22/v24).
- **OpenClaw** instalado e rodando no mesmo host.
- **PM2** ou **systemd** para manter os processos vivos.
- **Caddy/Nginx** (ou outro reverse proxy) para HTTPS.

---

## 1. Instalar o OpenClaw

```bash
# one-liner oficial (instala Node + OpenClaw):
curl -fsSL https://openclaw.ai/install.sh | bash
# ou, se já tem Node ≥ 22.19:
npm i -g openclaw@latest

openclaw setup --wizard         # config + workspace + auth do modelo
openclaw daemon install         # instala o serviço (systemd) do gateway
openclaw daemon start
```

O gateway sobe na porta **18789**. O AtlasDeck fala com ele por
`OPENCLAW_GATEWAY_URL` (default `http://127.0.0.1:18789`).

## 2. Clonar e configurar o AtlasDeck

```bash
cd /root/.openclaw/workspace
git clone https://github.com/felipeandrade55/AtlasDeck.git mission-control
cd mission-control
npm install
cp .env.example .env.local
```

Edite `.env.local` — no mínimo:

```env
ADMIN_PASSWORD=uma-senha-forte
AUTH_SECRET=$(openssl rand -base64 32)
# OPENCLAW_DIR=/root/.openclaw   # default já funciona
```

## 3. Build e subir

```bash
npm run build
pm2 start npm --name "atlasdeck" -- start
pm2 save && pm2 startup
```

Ou via **systemd** (`/etc/systemd/system/atlasdeck.service`) com
`ExecStart=/usr/bin/npm start`, `WorkingDirectory` no diretório do app e
`NODE_ENV=production`.

## 4. Reverse proxy (HTTPS)

```caddy
seu-dominio.com {
    reverse_proxy localhost:3000
}
```

## 5. Onboarding

Acesse o domínio, faça login com `ADMIN_PASSWORD` e siga o wizard. No modo
nativo o passo **Instalar** detecta/instala o OpenClaw no host (já feito no
passo 1, então ele segue), e o restante é igual ao fluxo do Coolify.

---

## Atualização

```bash
cd /caminho/do/app
git pull
npm install
npm run build
pm2 restart atlasdeck
```

## Diferenças vs. Coolify

| | VPS nativo | Coolify (container) |
|--|-----------|---------------------|
| OpenClaw | instalado no host (você) | embutido na imagem |
| Gateway | systemd/PM2 no host | PM2 dentro do container |
| `ATLASDECK_DEPLOY_MODE` | ausente (`native`) | `coolify` |
| Atualização | `git pull` + build manual | auto-deploy on push |
| Dados | em `data/` + `~/.openclaw` no host | volumes persistentes |
