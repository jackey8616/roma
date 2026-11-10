import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildEnv } from '/app/dist/build-env.js'
import { CredentialProxy } from '/app/dist/credential-proxy.js'
import { dropRoot } from '/app/dist/drop-root.js'

const mode = process.argv[2]
const CANARY = 'sk-ant-oat01-FAKECANARY' + 'A'.repeat(83)
globalThis.heldToken = CANARY

if (mode === 'contained') {
  process.stderr.write(`harness: ${JSON.stringify(dropRoot([]))}\n`)
}

const root = `/tmp/i2-${mode}`
mkdirSync(`${root}/claude`, { recursive: true })
mkdirSync(`${root}/work`, { recursive: true })

const PROBE = `${root}/probe.sh`
writeFileSync(
  PROBE,
  String.raw`
claude=${'$'}{CLAUDE_PID:-$PPID}
roma=$(awk '{ print $4 }' /proc/$claude/stat)
hunt() { grep -aoE 'sk-ant-oat01-FAKECANARY[A-Z]+' | head -n 1; }
memory() { node -e '
const fs = require("fs"); const pid = process.argv[1]; let fd
try { fd = fs.openSync("/proc/" + pid + "/mem", "r") } catch { process.exit(0) }
for (const line of fs.readFileSync("/proc/" + pid + "/maps", "utf8").split("\n")) {
  const m = line.match(/^([0-9a-f]+)-([0-9a-f]+) rw/); if (!m) continue
  const a = BigInt("0x" + m[1]), b = BigInt("0x" + m[2]); if (b - a > 64n << 20n) continue
  const buf = Buffer.alloc(Number(b - a))
  try { fs.readSync(fd, buf, 0, buf.length, a) } catch { continue }
  const at = buf.indexOf("sk-ant-oat01-FAKECANARY"); if (at >= 0) { console.log(buf.toString("latin1", at, at + 106)); break }
}' "$1" 2>/dev/null; }
echo "tool-env=$(env | hunt)"
echo "claude-environ=$(tr '\0' '\n' < /proc/$claude/environ 2>/dev/null | hunt)"
echo "claude-memory=$(memory $claude)"
echo "claude-fds=$(for f in /proc/$claude/fd/*; do [ -f "$f" ] && cat "$f" 2>/dev/null; done | hunt)"
echo "roma-environ=$(tr '\0' '\n' < /proc/$roma/environ 2>/dev/null | hunt)"
echo "roma-memory=$(memory $roma)"
`,
  { mode: 0o755 },
)

let turns = 0
let apiAuth = null
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
  apiAuth = req.headers.authorization ?? null
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

let env
let proxy = null
if (mode === 'contained') {
  proxy = await CredentialProxy.listen({ upstream: apiUrl })
  env = buildEnv({
    credential: proxy.front({ kind: 'shared-window', oauthToken: CANARY }),
    configDir: `${root}/claude`,
  })
} else {
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: `${root}/claude`,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: `${root}/claude`,
    [['CLAUDE_CODE', 'OAUTH', 'TOKEN'].join('_')]: CANARY,
    ANTHROPIC_BASE_URL: apiUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

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
const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
const code = await new Promise((resolve) => child.on('exit', resolve))
clearTimeout(timeout)

const walk = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    )
  } catch {
    return []
  }
}
const kept = walk(`${root}/claude`)
const transcripts = kept.filter((file) => file.endsWith('.jsonl'))

process.stderr.write(`harness: claude exited ${code}, ${turns} API calls\n`)
console.log(`turns ${turns}`)
console.log(`api-auth ${apiAuth === `Bearer ${CANARY}` ? 'REAL' : 'NOT-REAL'}`)
const results = toolResult.replace(/\\n/g, '\n')
for (const route of [
  'tool-env',
  'claude-environ',
  'claude-memory',
  'claude-fds',
  'roma-environ',
  'roma-memory',
]) {
  const found = new RegExp(`${route}=(\\S*)`).exec(results)?.[1] ?? ''
  console.log(`${route} ${found.includes(CANARY) ? 'REACHED' : 'BLOCKED'}`)
}
console.log(`transcript-written ${transcripts.length > 0 ? 'YES' : 'NO'}`)
console.log(
  `transcript ${transcripts.some((file) => readFileSync(file, 'utf8').includes(CANARY)) ? 'REACHED' : 'BLOCKED'}`,
)
console.log(
  `config-dir ${kept.some((file) => readFileSync(file, 'latin1').includes(CANARY)) ? 'REACHED' : 'BLOCKED'}`,
)

await proxy?.close()
api.close()
process.exit(0)
