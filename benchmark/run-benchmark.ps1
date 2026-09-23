<#
GPTProxy benchmark runner. Speaks directly to a running GPTProxy instance
(http://localhost:3000 by default) over its OpenAI-compatible endpoint,
tagging every request with x-dsh-session-id / x-dsh-request-id / x-dsh-scenario
so results correlate with GPTProxy's own benchmark-telemetry.jsonl.

Does not alter GPTProxy or Harness behavior; read-only measurement client.
See ../BENCHMARK.md for the methodology this script implements.
#>

param(
  [string]$BaseUrl = 'http://localhost:3000/v1',
  [string]$OutFile = (Join-Path $PSScriptRoot 'results.jsonl')
)

function Invoke-BenchTurn {
  param(
    [Parameter(Mandatory)][string]$Scenario,
    [Parameter(Mandatory)][string]$SessionKey,
    [Parameter(Mandatory)][array]$Messages,
    [array]$Tools = @(),
    [string]$Model = 'chatgpt-latest'
  )
  $requestId = [guid]::NewGuid().ToString()
  $headers = @{
    'x-dsh-session-id' = $SessionKey
    'x-dsh-request-id' = $requestId
    'x-dsh-scenario'   = $Scenario
  }
  $bodyObj = @{ model = $Model; stream = $false; messages = $Messages }
  if ($Tools.Count -gt 0) { $bodyObj.tools = $Tools }
  $body = $bodyObj | ConvertTo-Json -Depth 20

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $record = [ordered]@{
    requestId  = $requestId
    sessionKey = $SessionKey
    scenario   = $Scenario
    startedAt  = (Get-Date).ToUniversalTime().ToString('o')
  }
  try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/chat/completions" -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 300
    $sw.Stop()
    $choice = $resp.choices[0]
    $toolCalls = $choice.message.tool_calls
    $record.success = $true
    $record.clientTotalMs = $sw.ElapsedMilliseconds
    $record.finishReason = $choice.finish_reason
    $record.hasToolCalls = [bool]($toolCalls -and $toolCalls.Count -gt 0)
    $record.toolCallNames = if ($toolCalls) { ($toolCalls | ForEach-Object { $_.function.name }) -join ',' } else { '' }
    $record.contentPreview = if ($choice.message.content) { $choice.message.content.Substring(0, [Math]::Min(200, $choice.message.content.Length)) } else { '' }
    $record.promptTokens = $resp.usage.prompt_tokens
    $record.completionTokens = $resp.usage.completion_tokens
    $record.response = $resp
  } catch {
    $sw.Stop()
    $record.success = $false
    $record.clientTotalMs = $sw.ElapsedMilliseconds
    $record.error = $_.Exception.Message
  }
  ($record | ConvertTo-Json -Depth 20 -Compress) | Add-Content -LiteralPath $OutFile -Encoding UTF8
  return $record
}
