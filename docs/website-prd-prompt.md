# PRD-Prompt — Site de Apresentação e Vendas do AtlasDeck

> **Como usar este documento:** cole o conteúdo abaixo (da seção "PROMPT" em diante)
> em uma ferramenta de geração de sites/UI (v0, Lovable, Bolt, Cursor, Claude Code)
> ou entregue a um time de design/dev como briefing. Ele contém o contexto do produto,
> os objetivos do site, a arquitetura de informação, a copy sugerida, o design system
> (alinhado ao app real) e os requisitos técnicos. Está em PT-BR porque o produto é
> primariamente pt-BR; há uma nota sobre i18n EN.

---

## PROMPT

### 1. Papel e missão

Você é um(a) **designer de produto + engenheiro(a) front-end sênior + copywriter de growth**.
Sua missão é **projetar e construir o site institucional/marketing do AtlasDeck** — uma
landing page de alta conversão (com páginas de apoio) cujo objetivo é **apresentar o produto,
gerar confiança técnica e converter visitantes** em (a) instalações self-host (estrelas no
GitHub + deploys) e (b) leads/assinantes de uma futura oferta gerenciada ("Cloud/Pro") e de
suporte. O resultado deve parecer feito por uma empresa de DevTools de primeira linha
(referências de qualidade: Vercel, Linear, Resend, Railway, Supabase, Raycast).

### 2. O que é o AtlasDeck (brief do produto)

**AtlasDeck** (codinome interno _"Mission Control"_) é um **painel de controle e centro de
operações em tempo real para agentes de IA** — um "Jarvis" web auto-hospedado construído sobre
o runtime **OpenClaw**. Ele transforma uma instalação passiva de agentes em um assistente
**operável pela web, com chat, voz, proatividade, memória que aprende sozinha e orquestração
multi-agente**.

- **Auto-hospedado / privado:** roda no seu próprio VPS. Instalação em ~1 clique / `git clone`.
  Sem banco externo obrigatório — o OpenClaw é o backend; SQLite local cuida de chat, tarefas,
  memória, custos e calendário.
- **Stack:** Next.js 16 (App Router) · React 19 · Tailwind CSS v4 · React Three Fiber (3D) ·
  Recharts · SQLite (better-sqlite3) · MCP (Model Context Protocol) · Node.js 22.
- **Licença:** Open source (MIT). Repositório: `github.com/felipeandrade55/AtlasDeck`.
- **Idioma primário:** Português (pt-BR), com vocação para EN.

**Posicionamento em uma frase:**
> _"Mission Control para seus agentes de IA — transforme o OpenClaw no seu Jarvis: chat, voz,
> memória viva, orquestração multi-agente e observabilidade total, rodando no seu próprio servidor."_

### 3. Catálogo de funcionalidades (use para montar as seções de features)

Agrupe as features assim no site. Cada grupo vira um bloco/sub-seção com ícone, título curto
e 1–2 linhas de benefício (não só descrição técnica).

**A) Conversa & Voz ("seu Jarvis")**
- **Chat web nativo** com streaming em tempo real (SSE), multi-agente, threads persistidas,
  markdown + highlight de código + render de tool-calls inline.
- **Voz completa:** fala→texto (Web Speech / Whisper local), texto→fala (Web Speech / ElevenLabs
  / Fish Audio) e **wake word** ("Atlas"/"Jarvis") — converse sem tocar no teclado.
- Importa o histórico de sessões existentes do OpenClaw como contexto.

**B) Orquestração Multi-Agente ("Live Mission")**
- O agente principal **delega tarefas a especialistas** (dev, writer, analyst, designer,
  researcher, pm, reviewer — 7 templates prontos, 1 clique).
- **Kanban de 7 status** (Planning → Inbox → Assigned → In Progress → Testing → Review → Done)
  atualizando em tempo real, com **DAG de dependências**, **mailbox entre agentes**, **cost caps**
  por tarefa/dia, **Operator Chat** estilo Slack e **modo autônomo** (leigo) vs aprovação (técnico).
- **Learner Agent + Preference Model:** o sistema aprende com seus 👍/👎 e ajusta os agentes.

**C) Memória Viva (estilo Hermes)**
- **Extração automática** de fatos das conversas (sem você pedir), **busca semântica** (embeddings
  locais Xenova) + **FTS5**, **AUTO-RECALL** injetado no `MEMORY.md`, **wizard de identidade**
  (gera IDENTITY/SOUL/USER.md por entrevista em PT-BR), **servidor MCP de memória** e memória proativa.

**D) Observabilidade & Operação**
- **Dashboard** com visão geral: status dos agentes, atividade recente, custos do mês, briefing diário, clima, notepad.
- **System Monitor:** CPU/RAM/Disco/Rede em tempo real, PM2/Docker, firewall, Tailscale, serviços.
- **Sessões:** todas as conversas dos agentes com contador de tokens, barra de contexto e transcript viewer.
- **Activity Feed** com heatmap e gráficos; **Logs ao vivo** (tail PM2); **Terminal** read-only com allowlist; **Git**.
- **Busca global** unificada (memórias + atividades).

**E) Custos & Analytics**
- Análise de custo real das sessões do OpenClaw, **orçamento mensal**, **alertas** (Telegram),
  **trava automática** ao estourar limite, breakdown por modelo e por agente, projeções.

**F) Automação & Produtividade**
- **Cron Manager** visual (timeline semanal, histórico, disparo manual), **Workflows**,
  **Ações Rápidas**, **Lembretes**, **Relatórios**, **Notificações** em tempo real.
- **Calendário** com eventos, bookings e links de agendamento compartilháveis (integração Google Calendar).
- **E-mail** (cliente IMAP/SMTP nativo), **WhatsApp** e **Telegram** (contas, rotação de sessão,
  diagnóstico "Doctor", ingestão de briefing).

**G) Escritório 3D (feature flagship / "wow")**
- Ambiente 3D interativo (React Three Fiber) com **um avatar por agente**, reagindo em tempo real
  ao estado real de cada agente (idle/working/thinking/delegating/reviewing/stuck) — o Jarvis até
  "anda até a mesa" do especialista que está supervisionando.

**H) Setup, Segurança & Manutenção**
- **Wizard de setup 1-clique:** instala OpenClaw, configura modelo (inclui **Ollama local grátis**),
  entrevista de identidade, pareia Telegram.
- **Segurança:** todas as rotas autenticadas, rate-limiting (5 tentativas → lockout 15min), cookie
  httpOnly/secure, allowlist no terminal.
- **Auto-update, backup/restore, recovery, "AI Rescue"** e diagnóstico de gateway. **PWA instalável.**

### 4. Objetivos do site e métricas

**Objetivo primário:** converter visitante → instalação self-host (clique em "Deploy"/"GitHub")
**e** → lead da lista de espera "Cloud/Pro".
**Secundários:** comunicar a profundidade técnica sem assustar; ranquear em SEO para
"OpenClaw dashboard", "AI agent control panel", "self-hosted Jarvis"; servir de hub para docs/Discord.

**KPIs sugeridos:** taxa de clique no CTA primário, conversão da lista de espera, estrelas no
GitHub atribuídas ao site (UTM), tempo na página da seção 3D, scroll-depth até pricing.

### 5. Público-alvo / personas

1. **Builder técnico / indie hacker / dev de IA** — já usa OpenClaw ou agentes; quer
   observabilidade, controle de custo e orquestração. Decide por demonstração técnica e GitHub.
2. **Power user / "self-host enthusiast"** — quer um "Jarvis" privado no próprio servidor;
   valoriza privacidade, 1-clique e voz.
3. **Líder técnico / pequena empresa** — avalia adotar para o time; precisa de segurança, custos
   previsíveis e a futura oferta gerenciada/suporte.

### 6. Mensagens-chave (hierarquia)

1. **"Seu centro de comando para agentes de IA."** (o quê)
2. **"Transforme o OpenClaw num Jarvis: chat, voz, memória e orquestração."** (como/diferencial)
3. **"Roda no seu servidor. Seus dados, seu controle, custo sob controle."** (confiança/privacidade)
4. **"Instalação em 1 clique. Open source."** (fricção baixa)

### 7. Tom de voz

Confiante, técnico mas acessível, direto, levemente "sci-fi/mission control" sem exagero.
Frases curtas. Mostre, não prometa (use números, screenshots, GIFs, snippets). Evite jargão
de marketing vazio. PT-BR natural (o app usa pt-BR), com opção de alternar para EN.

### 8. Arquitetura de informação (páginas)

- **/** (Landing — principal; ver seção 9)
- **/features** (ou âncoras na landing) — detalhe por grupo de features (A–H acima)
- **/docs** (link externo para o repositório/README ou um hub de documentação)
- **/pricing** — Self-host (Grátis / OSS) · Cloud (lista de espera) · Suporte/Sponsor
- **/changelog** (opcional — alimentado pelo ROADMAP/commits)
- **/sobre** (opcional — visão, OpenClaw, comunidade)
- Rodapé com: GitHub, Discord, OpenClaw, licença MIT, política de privacidade.

### 9. Estrutura da landing (seções em ordem, com copy sugerida)

1. **Nav fixa** — logo "AtlasDeck", links (Features, Escritório 3D, Preços, Docs, GitHub ⭐),
   toggle PT/EN, CTA "Instalar".
2. **Hero** —
   - Headline: **"Mission Control para seus agentes de IA."**
   - Sub: "Transforme o OpenClaw no seu Jarvis — chat, voz, memória que aprende sozinha e
     orquestração multi-agente. Auto-hospedado, open source, instalação em 1 clique."
   - CTAs: primário **"Instalar agora"** (→ comando `git clone`/deploy) · secundário **"Ver no GitHub ⭐"**.
   - Visual: screenshot/loop animado do dashboard real (ou do Escritório 3D). Badge "MIT · Self-hosted · Next.js".
   - Faixa de prova: "Construído sobre OpenClaw" + ícones do stack.
3. **Problema → Solução** — 2–3 linhas: "Agentes de IA são caixas-pretas: você não vê custo,
   não controla, não conversa direto. O AtlasDeck dá olhos, voz e comando."
4. **Bloco de features principais** (cards/tabs para os grupos A–G), cada um com micro-screenshot/GIF.
5. **Seção destaque "Escritório 3D"** — embed/vídeo interativo, copy sobre visualizar agentes
   trabalhando em tempo real (o "wow factor").
6. **"Como funciona"** — 3–4 passos: (1) `git clone` no workspace OpenClaw, (2) configure `.env`
   + senha, (3) `npm run build && start`, (4) abra e converse. Mostrar snippet de terminal real.
7. **Memória & Orquestração** — seção mais técnica com diagrama (extração → embeddings → AUTO-RECALL;
   delegação → Kanban → review → learner).
8. **Privacidade & Segurança** — "Roda no seu servidor", rotas autenticadas, rate-limit, sem telemetria oculta.
9. **Prova social / comunidade** — estrelas GitHub, Discord, depoimentos (placeholders), contribuidores.
10. **Pricing** — 3 colunas: **Self-host (Grátis, MIT)** · **Cloud (em breve — lista de espera)** ·
    **Suporte/Sponsor**. CTA de e-mail para a lista de espera.
11. **FAQ** — "Preciso do OpenClaw?", "Funciona sem GPU?", "Roda local com Ollama?", "Meus dados saem do servidor?",
    "Quais modelos suporta?", "É realmente grátis?".
12. **CTA final** — repete hero CTA + Discord.
13. **Rodapé** — links, licença, social, e-mail.

### 10. Design system (ALINHAR ao app real — não inventar)

Use exatamente a linguagem visual do produto para consistência:

- **Tema:** dark-first.
  - Fundo `#0C0C0C` · superfícies `#1A1A1A` / elevado `#242424` · bordas `#2A2A2A`/`#3A3A3A`.
  - **Accent (vermelho de assinatura):** `#FF3B30` (hover `#FF524A`, soft `rgba(255,59,48,0.12)`).
  - Texto: primário `#FFFFFF`, secundário `#8A8A8A`, mudo `#525252`.
  - Semânticos: sucesso `#32D74B`, erro `#FF453A`, warning `#FFD60A`, info `#0A84FF`.
- **Tipografia:** títulos **Sora** (tracking negativo ~-0.02em), corpo **Inter**, mono **JetBrains Mono**.
- **Forma:** raios 4/8/12px, sombras suaves, cards com borda 1px sutil, "accent-line" como detalhe.
- **Estética:** "OS / mission control" — topbar, dock, status bar, badges com emoji, micro-interações
  (hover scale ~1.02–1.05), gradientes sutis no accent. Nada de cores pastel/claras dominantes.
- **Ícones:** Lucide (o app usa Lucide React) — manter coerência.
- **Movimento:** transições suaves, parallax leve, animação de entrada por scroll; um loop/vídeo do 3D.

### 11. Requisitos técnicos do site

- **Stack sugerido:** Next.js (App Router) + Tailwind + Framer Motion. (Coerente com o produto;
  pode ser estático/SSG e hospedado em Vercel/Cloudflare.)
- **Performance:** Lighthouse 95+ em mobile; imagens otimizadas (next/image), lazy-load do 3D/vídeo,
  fontes via next/font.
- **Responsivo:** mobile-first; o app já é responsivo, o site também precisa ser impecável no celular.
- **Acessibilidade:** contraste AA no dark theme, foco visível, alt text, navegação por teclado.
- **i18n:** PT-BR default + EN (toggle). Estrutura de strings pronta para traduzir.
- **Analytics & conversão:** UTM nos CTAs, evento de clique em "Instalar"/"GitHub"/lista de espera,
  formulário de e-mail (Resend/Buttondown/Formspree) para o Cloud/Pro.
- **SEO:** metadados OpenGraph/Twitter cards, título "AtlasDeck — Mission Control para agentes de IA",
  descrição com keywords ("OpenClaw dashboard", "self-hosted AI agent control panel", "Jarvis open source"),
  sitemap, favicon (já existe paleta de ícones 192/512 no produto), JSON-LD SoftwareApplication.

### 12. Conteúdo/assets a produzir

- Screenshots reais (já existem em `docs/screenshots/`: dashboard, sessions, costs, system, office3d).
- GIFs/loops curtos: chat com voz, Kanban Live Mission evoluindo, Escritório 3D, memória AUTO-RECALL.
- Diagrama "como funciona" e diagrama de arquitetura (OpenClaw + AtlasDeck + SQLite + MCP).
- Logo/wordmark "AtlasDeck" (derivar do accent vermelho + tipografia Sora).

### 13. Entregáveis

1. Landing page completa (todas as seções da §9), responsiva, com o design system da §10.
2. Páginas de apoio: /pricing, /features (ou âncoras), FAQ, rodapé com links reais.
3. Componentes reutilizáveis (nav, hero, feature card, pricing card, FAQ accordion, CTA).
4. Copy final PT-BR (com chaves prontas para EN).
5. Metadados SEO + OG + sitemap + manifest.
6. README curto de como rodar/implantar o site.

### 14. Restrições e "não fazer"

- **Não** prometer features que não existem; basear-se no catálogo da §3.
- **Não** usar tema claro como dominante — o produto é dark-first com accent vermelho.
- **Não** esconder a natureza open-source/self-host; é um diferencial, não uma limitação.
- **Não** exigir cadastro para "ver o produto" — o GitHub e os screenshots devem estar acessíveis.
- Deixar claro que **requer OpenClaw** no host (com link para `openclaw.ai`) e que roda nos
  dados do próprio usuário (privacidade).

---

### Apêndice — Dados de referência (do app real)

- **Nome/branding:** AtlasDeck (descritor "Mission Control"). Empresa/rodapé configuráveis.
- **Repo:** `github.com/felipeandrade55/AtlasDeck` · **Licença:** MIT.
- **Runtime base:** OpenClaw (`openclaw.ai`, docs `docs.openclaw.ai`, Discord da comunidade).
- **Requisitos:** Node 18+ (testado 22), OpenClaw no mesmo host, PM2/systemd, Caddy (HTTPS).
- **Páginas do app (27):** dashboard, agents, office (3D), actions, system, logs, terminal, git,
  workflows, activity, memory, files, cron, sessions, search, analytics, reports, skills, calendar,
  costs, emails, whatsapp, reminders, chat, settings, about, welcome.
- **Paleta/tipografia:** ver §10 (extraída de `src/app/globals.css` e `src/config/branding.ts`).
