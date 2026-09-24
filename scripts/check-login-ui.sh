#!/usr/bin/env bash
set -euo pipefail
cd /root/killsis/gptproxy
TOKEN="$(cat .login-ui-token)"
echo "UI: https://dsh.killsis.com/login-ui?token=$TOKEN"
echo '--- pm2 ---'
pm2 status gptproxy
echo '--- health ---'
curl -sS http://127.0.0.1:3333/health; echo
echo '--- models ---'
curl -sS http://127.0.0.1:3333/v1/models | head -c 500; echo
echo '--- login ui status via HTTPS ---'
curl -sS "https://dsh.killsis.com/debug/login/status?token=$TOKEN"; echo
echo '--- screenshot via HTTPS ---'
curl -sS -o /tmp/gptproxy-login-ui-check.png -w 'screenshot:%{http_code} bytes:%{size_download}\n' "https://dsh.killsis.com/debug/login/screenshot?token=$TOKEN"
