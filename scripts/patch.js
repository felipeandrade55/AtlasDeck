const fs = require('fs');
let content = fs.readFileSync('scripts/deploy.sh', 'utf-8');

content = content.replace(
  'if [[ "${_DEPLOY_SAFE:-}" != "1" ]]; then\n  _TMP=$(mktemp /tmp/deploy.XXXXXX.sh)',
  '# Quick pre-scan for --headless flag\n_HEADLESS_PRESCAN=false\nfor _arg in "$@"; do [[ "$_arg" == "--headless" ]] && _HEADLESS_PRESCAN=true; done\n\nif [[ "${_DEPLOY_SAFE:-}" != "1" ]] && ! $_HEADLESS_PRESCAN; then\n  _TMP=$(mktemp /tmp/deploy.XXXXXX.sh)'
);

content = content.replace(
  'BIDIRECTIONAL=false\nfor arg in "$@"; do',
  'BIDIRECTIONAL=false\nHEADLESS=false\nfor arg in "$@"; do'
);

content = content.replace(
  '    --bidirecional|--bidirectional)\n      BIDIRECTIONAL=true\n      ;;',
  '    --bidirecional|--bidirectional)\n      BIDIRECTIONAL=true\n      ;;\n    --headless)\n      HEADLESS=true\n      ;;'
);

content = content.replace(
  "GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'\nRED='\\033[0;31m'; BOLD='\\033[1m'; DIM='\\033[2m'; NC='\\033[0m'",
  "if [[ -t 1 ]] && ! $HEADLESS; then\n  GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'\n  RED='\\033[0;31m'; BOLD='\\033[1m'; DIM='\\033[2m'; NC='\\033[0m'\nelse\n  GREEN=''; YELLOW=''; CYAN=''\n  RED=''; BOLD=''; DIM=''; NC=''\nfi"
);

content = content.replace(
  '  warn "Credenciais não encontradas — informe login e PAT"\n  echo ""\n  echo -e "  ${DIM}PAT em: github.com → Settings → Developer settings → Personal access tokens${NC}"\n  echo -e "  ${DIM}Escopo necessário: \'repo\' (write para --bidirecional, read para pull simples)${NC}"\n  echo ""\n  read -rp "  GitHub login : " GH_USER\n  read -rsp "  GitHub PAT   : " GH_TOKEN\n  echo ""\n\n  printf \'https://%s:%s@github.com\\n\' "$GH_USER" "$GH_TOKEN" > ~/.git-credentials\n  chmod 600 ~/.git-credentials\n\n  ok "Credenciais salvas (~/.git-credentials)"\n  record "Credenciais GitHub" "ok" "$(elapsed $T)"\nfi',
  '  if $HEADLESS; then\n    warn "Credenciais não encontradas — operando em modo headless"\n    record "Credenciais GitHub" "skip" "$(elapsed $T)"\n  else\n    warn "Credenciais não encontradas — informe login e PAT"\n    echo ""\n    echo -e "  ${DIM}PAT em: github.com → Settings → Developer settings → Personal access tokens${NC}"\n    echo -e "  ${DIM}Escopo necessário: \'repo\' (write para --bidirecional, read para pull simples)${NC}"\n    echo ""\n    read -rp "  GitHub login : " GH_USER\n    read -rsp "  GitHub PAT   : " GH_TOKEN\n    echo ""\n\n    printf \'https://%s:%s@github.com\\n\' "$GH_USER" "$GH_TOKEN" > ~/.git-credentials\n    chmod 600 ~/.git-credentials\n\n    ok "Credenciais salvas (~/.git-credentials)"\n    record "Credenciais GitHub" "ok" "$(elapsed $T)"\n  fi\nfi'
);

content = content.replace(
  'if ! command -v fail2ban-client &>/dev/null; then\n  echo ""\n  read -rp "  Deseja instalar e configurar o Fail2Ban para proteger contra brute force? (y/N): " INSTALL_F2B\n  if [[ "$INSTALL_F2B" =~ ^[Yy]$ ]]; then\n    info "Instalando fail2ban..."\n    sudo apt-get update -qq && sudo apt-get install -y fail2ban\n    \n    if [ ! -f /etc/fail2ban/jail.local ]; then\n      cat <<EOF | sudo tee /etc/fail2ban/jail.local > /dev/null\n[DEFAULT]\nbantime = 1h\nfindtime = 10m\nmaxretry = 5\n\n[sshd]\nenabled = true\nport = ssh\nfilter = sshd\nlogpath = /var/log/auth.log\nmaxretry = 3\nEOF\n      sudo systemctl restart fail2ban\n    fi\n    ok "Fail2Ban instalado e Jail SSH ativa"\n    record "Fail2Ban Setup" "ok" "$(elapsed $T)"\n  else\n    warn "Instalação do Fail2Ban ignorada."\n    record "Fail2Ban Setup" "skip" "$(elapsed $T)"\n  fi\nelse',
  'if ! command -v fail2ban-client &>/dev/null; then\n  if $HEADLESS; then\n    warn "Fail2Ban não instalado — pulando setup interativo no modo headless"\n    record "Fail2Ban Setup" "skip" "$(elapsed $T)"\n  else\n    echo ""\n    read -rp "  Deseja instalar e configurar o Fail2Ban para proteger contra brute force? (y/N): " INSTALL_F2B\n    if [[ "$INSTALL_F2B" =~ ^[Yy]$ ]]; then\n      info "Instalando fail2ban..."\n      sudo apt-get update -qq && sudo apt-get install -y fail2ban\n      \n      if [ ! -f /etc/fail2ban/jail.local ]; then\n        cat <<EOF | sudo tee /etc/fail2ban/jail.local > /dev/null\n[DEFAULT]\nbantime = 1h\nfindtime = 10m\nmaxretry = 5\n\n[sshd]\nenabled = true\nport = ssh\nfilter = sshd\nlogpath = /var/log/auth.log\nmaxretry = 3\nEOF\n        sudo systemctl restart fail2ban\n      fi\n      ok "Fail2Ban instalado e Jail SSH ativa"\n      record "Fail2Ban Setup" "ok" "$(elapsed $T)"\n    else\n      warn "Instalação do Fail2Ban ignorada."\n      record "Fail2Ban Setup" "skip" "$(elapsed $T)"\n    fi\n  fi\nelse'
);

content = content.replace(
  '  else\n    echo ""\n    read -rp "  Deseja ativar o Firewall (UFW) com portas padrão (SSH, 80, 443, 3000)? (y/N): " ENABLE_UFW\n    if [[ "$ENABLE_UFW" =~ ^[Yy]$ ]]; then\n      info "Configurando regras padrão..."\n      sudo ufw allow ssh > /dev/null\n      sudo ufw allow http > /dev/null\n      sudo ufw allow https > /dev/null\n      sudo ufw allow 3000/tcp > /dev/null\n      sudo ufw --force enable > /dev/null\n      ok "Firewall ativado com segurança padrão"\n      record "Firewall UFW" "ok" "$(elapsed $T)"\n    else\n      warn "Ativação do Firewall ignorada."\n      record "Firewall UFW" "skip" "$(elapsed $T)"\n    fi\n  fi\nfi',
  '  else\n    if $HEADLESS; then\n      warn "Firewall desativado — pulando configuração interativa no modo headless"\n      record "Firewall UFW" "skip" "$(elapsed $T)"\n    else\n      echo ""\n      read -rp "  Deseja ativar o Firewall (UFW) com portas padrão (SSH, 80, 443, 3000)? (y/N): " ENABLE_UFW\n      if [[ "$ENABLE_UFW" =~ ^[Yy]$ ]]; then\n        info "Configurando regras padrão..."\n        sudo ufw allow ssh > /dev/null\n        sudo ufw allow http > /dev/null\n        sudo ufw allow https > /dev/null\n        sudo ufw allow 3000/tcp > /dev/null\n        sudo ufw --force enable > /dev/null\n        ok "Firewall ativado com segurança padrão"\n        record "Firewall UFW" "ok" "$(elapsed $T)"\n      else\n        warn "Ativação do Firewall ignorada."\n        record "Firewall UFW" "skip" "$(elapsed $T)"\n      fi\n    fi\n  fi\nfi'
);

fs.writeFileSync('scripts/deploy.sh', content, 'utf-8');
console.log('deploy.sh patched!');
