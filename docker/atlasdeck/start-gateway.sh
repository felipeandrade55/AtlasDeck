#!/usr/bin/env bash
# Lança o gateway do OpenClaw em foreground para o PM2.
#
# Por que um wrapper em vez de apontar o PM2 direto no binário `openclaw`:
# no modo fork o PM2 injeta um canal IPC do Node no processo filho, e com isso
# o gateway sobe ("online" no PM2) mas NÃO binda a porta 18789. Rodando via
# `exec openclaw …` a partir do bash, o gateway vira neto do PM2 (sem o IPC do
# Node) e passa a escutar normalmente.
exec openclaw gateway run \
  --port "${OPENCLAW_GATEWAY_PORT:-18789}" \
  --bind loopback \
  --auth none \
  --allow-unconfigured
