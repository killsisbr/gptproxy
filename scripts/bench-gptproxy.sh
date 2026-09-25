#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GPTPROXY_BASE_URL:-http://127.0.0.1:3333}"
MODEL="${GPTPROXY_MODEL:-chatgpt-latest}"
ROUNDS="${GPTPROXY_BENCH_ROUNDS:-2}"
PROMPT="${GPTPROXY_BENCH_PROMPT:-responda apenas ok}"
OUT_DIR="${GPTPROXY_BENCH_OUT_DIR:-benchmark/results}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JSONL="$OUT_DIR/gptproxy-bench-$STAMP.jsonl"
SUMMARY="$OUT_DIR/gptproxy-bench-$STAMP.summary.txt"
mkdir -p "$OUT_DIR"

now_ms() { date +%s%3N; }
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'; }

post_json() {
  local body="$1" out="$2" headers="$3"
  curl -sS --max-time "${GPTPROXY_BENCH_TIMEOUT:-180}" -D "$headers" -o "$out" \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    --data-binary "$body"
}

record_jsonl() {
  printf '%s\n' "$1" >> "$JSONL"
}

echo "GPTProxy benchmark"
echo "base_url=$BASE_URL"
echo "model=$MODEL"
echo "rounds=$ROUNDS"
echo "prompt=$PROMPT"
echo "jsonl=$JSONL"
echo

health_body="$(curl -sS --max-time 30 "$BASE_URL/health" || true)"
echo "health=$health_body"
record_jsonl "{\"type\":\"health\",\"ts\":\"$STAMP\",\"body\":$(printf '%s' "$health_body" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
if ! printf '%s' "$health_body" | grep -q '"loggedIn":true'; then
  echo "ERROR: GPTProxy is not logged in or health failed" >&2
  exit 2
fi

prompt_json="$(printf '%s' "$PROMPT" | json_escape)"

nonstream_ms=()
echo '--- non-stream rounds ---'
for i in $(seq 1 "$ROUNDS"); do
  body="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt_json\"}],\"stream\":false}"
  out="/tmp/gptproxy-bench-nonstream-$i.json"
  headers="/tmp/gptproxy-bench-nonstream-$i.headers"
  start="$(now_ms)"
  if post_json "$body" "$out" "$headers"; then status="ok"; else status="curl_error"; fi
  end="$(now_ms)"
  ms=$((end-start))
  code="$(awk 'tolower($0) ~ /^http\// {c=$2} END{print c+0}' "$headers" 2>/dev/null || echo 0)"
  content="$(python3 - <<PY
import json, pathlib
raw=pathlib.Path('$out').read_text(errors='replace') if pathlib.Path('$out').exists() else ''
try:
 data=json.loads(raw); print((data.get('choices') or [{}])[0].get('message',{}).get('content','')[:200])
except Exception:
 print(raw[:200])
PY
)"
  completion_tokens="$(python3 - <<PY
import json, pathlib
try:
 data=json.loads(pathlib.Path('$out').read_text()); print(data.get('usage',{}).get('completion_tokens',''))
except Exception: print('')
PY
)"
  nonstream_ms+=("$ms")
  echo "round=$i http=$code total_ms=$ms completion_tokens=$completion_tokens content=$(printf '%s' "$content" | tr '\n' ' ' | head -c 120)"
  content_json="$(printf '%s' "$content" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  record_jsonl "{\"type\":\"nonstream\",\"round\":$i,\"http\":$code,\"status\":\"$status\",\"total_ms\":$ms,\"completion_tokens\":\"$completion_tokens\",\"content\":$content_json}"
done

echo
echo '--- stream rounds ---'
for i in $(seq 1 "$ROUNDS"); do
  body="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt_json\"}],\"stream\":true}"
  out="/tmp/gptproxy-bench-stream-$i.sse"
  headers="/tmp/gptproxy-bench-stream-$i.headers"
  start="$(now_ms)"
  curl_status=0
  curl -sS -N --max-time "${GPTPROXY_BENCH_TIMEOUT:-180}" -D "$headers" -o "$out" \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'Accept: text/event-stream' \
    --data-binary "$body" || curl_status=$?
  end="$(now_ms)"
  code="$(awk 'tolower($0) ~ /^http\// {c=$2} END{print c+0}' "$headers" 2>/dev/null || echo 0)"
  ttft_ms="$(python3 - <<PY
from pathlib import Path
start=$start
p=Path('$out')
# curl -o writes after transfer, so exact TTFT is unavailable from file timestamps.
# Keep blank here; use total_ms and server stream content as stable shell-only benchmark.
print('')
PY
)"
  total_ms=$((end-start))
  text="$(python3 - <<PY
import json, pathlib
raw=pathlib.Path('$out').read_text(errors='replace') if pathlib.Path('$out').exists() else ''
parts=[]
for line in raw.splitlines():
 if not line.startswith('data: '): continue
 payload=line[6:]
 if payload == '[DONE]': continue
 try:
  data=json.loads(payload)
  delta=(data.get('choices') or [{}])[0].get('delta',{})
  parts.append(delta.get('content',''))
 except Exception:
  pass
print(''.join(parts)[:200])
PY
)"
  status="ok"; [ "$curl_status" = 0 ] || status="curl_error_$curl_status"
  echo "round=$i http=$code total_ms=$total_ms text=$(printf '%s' "$text" | tr '\n' ' ' | head -c 120)"
  text_json="$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  record_jsonl "{\"type\":\"stream\",\"round\":$i,\"http\":$code,\"status\":\"$status\",\"total_ms\":$total_ms,\"text\":$text_json}"
done

echo
echo '--- tool-call create_file smoke ---'
tool_target="$OUT_DIR/tool-smoke-$STAMP.html"
tool_body="$(cat <<JSON
{"model":"$MODEL","stream":false,"messages":[{"role":"user","content":"Use a ferramenta create_file para criar um arquivo HTML simples em $tool_target. IMPORTANTE: responda apenas com tool_calls JSON valido; em arguments.content use HTML sem atributos, sem aspas duplas e sem CSS: html, body, h1 Benchmark GPTProxy, ul com 3 beneficios da IA."}],"tools":[{"type":"function","function":{"name":"create_file","description":"Cria arquivo UTF-8.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]}
JSON
)"
tool_out="/tmp/gptproxy-bench-tool.json"
tool_headers="/tmp/gptproxy-bench-tool.headers"
tool_start="$(now_ms)"
post_json "$tool_body" "$tool_out" "$tool_headers" || true
tool_end="$(now_ms)"
python3 - <<PY
import json, pathlib, sys
raw=pathlib.Path('$tool_out').read_text(errors='replace')
try:
 data=json.loads(raw)
 call=(data.get('choices') or [{}])[0].get('message',{}).get('tool_calls',[None])[0]
 if not call:
  print('tool_call=missing')
  raise SystemExit(3)
 args=json.loads(call['function']['arguments'])
 path=pathlib.Path(args['path'])
 allowed=pathlib.Path('$OUT_DIR').resolve()
 resolved=path.resolve()
 if allowed not in [resolved, *resolved.parents]:
  raise SystemExit(f'tool path outside out dir: {resolved}')
 path.write_text(args.get('content',''), encoding='utf-8')
 print(f"tool_call={call['function']['name']} path={path} bytes={path.stat().st_size}")
except Exception as e:
 print('tool_error=', e)
 print(raw[:1000])
 raise
PY
tool_ms=$((tool_end-tool_start))
record_jsonl "{\"type\":\"tool_call\",\"total_ms\":$tool_ms,\"target\":\"$tool_target\"}"

python3 - <<PY > "$SUMMARY"
import json, pathlib, statistics
rows=[json.loads(x) for x in pathlib.Path('$JSONL').read_text().splitlines() if x.strip()]
for typ in ['nonstream','stream']:
 vals=[r['total_ms'] for r in rows if r.get('type')==typ and isinstance(r.get('total_ms'), int)]
 if vals:
  print(f'{typ}_count={len(vals)}')
  print(f'{typ}_avg_ms={round(statistics.mean(vals), 1)}')
  print(f'{typ}_min_ms={min(vals)}')
  print(f'{typ}_max_ms={max(vals)}')
print(f'jsonl=$JSONL')
PY

echo
echo '--- summary ---'
cat "$SUMMARY"
echo "summary=$SUMMARY"
