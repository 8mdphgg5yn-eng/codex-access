#!/bin/zsh
set -eu
cd "${0:A:h}"
if ! command -v node >/dev/null; then
  print '未找到 Node.js。此原型需要 Node.js 22 或更新版本。'
  read 'reply?按回车关闭。'
  exit 1
fi
prototype_port="${CODEX_ACCESS_PORT:-8782}"
prototype_url="http://127.0.0.1:${prototype_port}"
prototype_health="$(curl --max-time 1 -fsS "${prototype_url}/health" 2>/dev/null || true)"
if [[ "$prototype_health" == *'"app":"codex-access-prototype"'* ]]; then
  open "$prototype_url"
  print "服务已在运行：${prototype_url}"
  exit 0
fi
node server.mjs &
prototype_pid=$!
trap 'kill -TERM "$prototype_pid" 2>/dev/null || true' EXIT INT TERM
for prototype_attempt in {1..30}; do
  if ! kill -0 "$prototype_pid" 2>/dev/null; then
    print '服务未能启动，请查看上方错误。'
    read 'reply?按回车关闭。'
    exit 1
  fi
  prototype_health="$(curl --max-time 1 -fsS "${prototype_url}/health" 2>/dev/null || true)"
  if [[ "$prototype_health" == *'"app":"codex-access-prototype"'* ]]; then
    open "$prototype_url"
    print "已打开 ${prototype_url}。保留此窗口；按 Control+C 关闭服务。"
    wait "$prototype_pid"
    exit 0
  fi
  sleep 0.2
done
print '服务启动超时。'
exit 1
