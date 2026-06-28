// PM2 process manifest para o container all-in-one do AtlasDeck (modo Coolify).
//
//  - atlasdeck        → o app Next.js em produção (porta 3000)
//  - openclaw-gateway → o gateway WebSocket do OpenClaw em foreground (porta 18789)
//
// O nome "openclaw-gateway" é proposital: o gateway-control.ts do app
// (findPm2Name) procura um processo PM2 cujo nome contém "openclaw" e NÃO
// contém "atlasdeck". Assim o botão "Reiniciar Gateway" e o self-heal do
// health-monitor funcionam dentro do container sem nenhuma mudança no core.
//
// pm2-runtime roda como PID 1 e propaga o ambiente exportado pelo entrypoint
// (AUTH_SECRET, ADMIN_PASSWORD, etc.) para ambos os apps.
module.exports = {
  apps: [
    {
      name: "atlasdeck",
      cwd: "/app",
      // Chama o binário do Next diretamente (evita um wrapper de shell do npm).
      script: "node_modules/next/dist/bin/next",
      args: "start -H 0.0.0.0 -p 3000",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "openclaw-gateway",
      // Via wrapper bash (não direto no binário): no fork mode o PM2 injeta um
      // canal IPC do Node que faz o gateway subir sem bindar a porta. O wrapper
      // roda `exec openclaw gateway run …` como neto do PM2, sem esse IPC.
      script: "/app/start-gateway.sh",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
    },
  ],
};
