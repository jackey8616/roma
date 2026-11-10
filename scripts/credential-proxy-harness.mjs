import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildEnv } from '/app/dist/build-env.js'
import { ClaudeSession } from '/app/dist/claude-session.js'
import { CredentialProxy } from '/app/dist/credential-proxy.js'
import { dropRoot } from '/app/dist/drop-root.js'
import { realLauncher } from '/app/dist/launcher.js'

const [mode, kind = 'shared-window'] = process.argv.slice(2)
const overflow = kind === 'overflow'
const PREFIX = overflow ? 'sk-ant-api03-FAKECANARY' : 'sk-ant-oat01-FAKECANARY'
const CANARY =
  process.env[overflow ? 'ROMA_OVERFLOW_API_KEY' : ['CLAUDE_CODE', 'OAUTH', 'TOKEN'].join('_')] ??
  ''
if (!CANARY.startsWith(PREFIX)) {
  throw new Error(`the harness needs a fake ${kind} credential in roma's own environment`)
}
globalThis.heldToken = CANARY

const ROUTES = [
  'tool-env',
  'claude-environ',
  'claude-memory',
  'claude-fds',
  'roma-environ',
  'roma-memory',
]

const roots = { work: '/var/lib/roma/work', config: '/var/lib/roma/claude', shim: '/run/roma' }
const launcher = mode === 'contained' ? realLauncher() : null
if (launcher !== null) {
  launcher.writeRoots(roots)
  process.stderr.write(`harness: ${JSON.stringify(dropRoot([]))}\n`)
  await launcher.sweep()
}

const scratch = `/tmp/i2-${mode}`
mkdirSync(`${scratch}/claude`, { recursive: true })
mkdirSync(`${scratch}/work`, { recursive: true })

const PROBE = `${scratch}/probe.sh`
writeFileSync(
  PROBE,
  String.raw`
claude=${'$'}{CLAUDE_PID:-$PPID}
roma=${process.pid}
hunt() { grep -aoE '${PREFIX}[A-Z]+' | head -n 1; }
memory() { node -e '
const fs = require("fs"); const pid = process.argv[1]; let fd
try { fd = fs.openSync("/proc/" + pid + "/mem", "r") } catch { process.exit(0) }
for (const line of fs.readFileSync("/proc/" + pid + "/maps", "utf8").split("\n")) {
  const m = line.match(/^([0-9a-f]+)-([0-9a-f]+) rw/); if (!m) continue
  const a = BigInt("0x" + m[1]), b = BigInt("0x" + m[2]); if (b - a > 64n << 20n) continue
  const buf = Buffer.alloc(Number(b - a))
  try { fs.readSync(fd, buf, 0, buf.length, a) } catch { continue }
  const at = buf.indexOf("${PREFIX}"); if (at >= 0) { console.log(buf.toString("latin1", at, at + ${String(CANARY.length)})); break }
}' "$1" 2>/dev/null; }
echo "probe-uid=$(id -u)"
echo "claude-uid=$(awk '/^Uid:/ { print $2 }' /proc/$claude/status)"
echo "tool-env=$(env | hunt)"
echo "claude-environ=$(tr '\0' '\n' < /proc/$claude/environ 2>/dev/null | hunt)"
echo "claude-memory=$(memory $claude)"
echo "claude-fds=$(for f in /proc/$claude/fd/*; do [ -f "$f" ] && cat "$f" 2>/dev/null; done | hunt)"
echo "roma-environ=$(tr '\0' '\n' < /proc/$roma/environ 2>/dev/null | hunt)"
echo "roma-memory=$(memory $roma)"
echo "probe-complete=yes"
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
  apiAuth = (overflow ? req.headers['x-api-key'] : req.headers.authorization) ?? null
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

const walk = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    )
  } catch {
    return []
  }
}

const SCAN = `
const fs = require('fs')
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name])
const files = walk(process.env.CLAUDE_CONFIG_DIR)
const leaks = (f) => fs.readFileSync(f, 'latin1').includes(process.argv[1])
const transcripts = files.filter((f) => f.endsWith('.jsonl'))
console.log(JSON.stringify({ transcripts: transcripts.length,
  transcriptLeak: transcripts.some(leaks), configLeak: files.some(leaks) }))
`

let proxy = null
let turnOk = false
let scan
if (launcher !== null) {
  proxy = await CredentialProxy.listen({ upstream: apiUrl })
  const credential = overflow
    ? { kind: 'overflow', apiKey: CANARY }
    : { kind: 'shared-window', oauthToken: CANARY }
  const env = buildEnv({ credential: proxy.front(credential), configDir: `${scratch}/claude` })
  const sessionId = randomUUID()
  const seat = { seat: 0, sessionId }
  const session = new ClaudeSession({
    sessionId,
    cwd: `${roots.work}/${sessionId}`,
    env,
    spawn: (request) => launcher.spawn({ ...request, seat }),
  })
  session.on('stderr', (chunk) => process.stderr.write(chunk))
  session.start()
  const timeout = setTimeout(() => {
    process.stderr.write('harness: the Turn timed out\n')
    process.exit(1)
  }, 90_000)
  const turn = await session.send('Run the probe.')
  turnOk = !turn.isError
  const exit = await session.terminate()
  clearTimeout(timeout)
  process.stderr.write(`harness: claude ${JSON.stringify(exit)}, ${turns} API calls\n`)

  const scanner = launcher.spawn({
    command: 'node',
    args: ['-e', SCAN, CANARY],
    cwd: `${roots.work}/${sessionId}`,
    env,
    seat,
  })
  let scanned = ''
  scanner.onStdout((chunk) => (scanned += chunk))
  scanner.onStderr((chunk) => process.stderr.write(chunk))
  const scanExit = await new Promise((resolve) => scanner.onExit(resolve))
  if (scanExit.code !== 0) throw new Error(`the config scan failed: ${JSON.stringify(scanExit)}`)
  scan = JSON.parse(scanned)
  await launcher.reclaim(sessionId)
} else {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: `${scratch}/claude`,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: `${scratch}/claude`,
    [overflow ? 'ANTHROPIC_API_KEY' : ['CLAUDE_CODE', 'OAUTH', 'TOKEN'].join('_')]: CANARY,
    ANTHROPIC_BASE_URL: apiUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']
  const child = spawn('claude', [...args, '--verbose', '--permission-mode', 'bypassPermissions'], {
    env,
    cwd: `${scratch}/work`,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
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
  turnOk = code === 0
  process.stderr.write(`harness: claude exited ${code}, ${turns} API calls\n`)
  const files = walk(`${scratch}/claude`)
  const transcripts = files.filter((file) => file.endsWith('.jsonl'))
  const leaks = (file) => readFileSync(file, 'latin1').includes(CANARY)
  scan = {
    transcripts: transcripts.length,
    transcriptLeak: transcripts.some(leaks),
    configLeak: files.some(leaks),
  }
}

const results = toolResult.replace(/\\n/g, '\n')
const field = (name) => new RegExp(`(?:^|[\\s"])${name}=([^\\s"]*)`).exec(results)?.[1]
const complete = field('probe-complete') === 'yes'
console.log(`turns ${turns}`)
console.log(`turn ${turnOk ? 'OK' : 'FAILED'}`)
console.log(`probe ${complete ? 'COMPLETE' : 'INCOMPLETE'}`)
console.log(`probe-uid ${field('probe-uid') ?? 'MISSING'}`)
console.log(`claude-uid ${field('claude-uid') ?? 'MISSING'}`)
console.log(
  `api-auth ${apiAuth === (overflow ? CANARY : `Bearer ${CANARY}`) ? 'REAL' : 'NOT-REAL'}`,
)
for (const route of ROUTES) {
  const found = field(route)
  const verdict =
    found === undefined || !complete ? 'MISSING' : found.includes(CANARY) ? 'REACHED' : 'BLOCKED'
  console.log(`${route} ${verdict}`)
}
console.log(`transcript-written ${scan.transcripts > 0 ? 'YES' : 'NO'}`)
console.log(`transcript ${scan.transcriptLeak ? 'REACHED' : 'BLOCKED'}`)
console.log(`config-dir ${scan.configLeak ? 'REACHED' : 'BLOCKED'}`)

await proxy?.close()
api.close()
process.exit(0)
