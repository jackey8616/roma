import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildEnv } from '/app/dist/build-env.js'
import { spawnClaudeProcess } from '/app/dist/claude-process.js'
import { dropRoot } from '/app/dist/drop-root.js'

const KEY = '/tmp/roma-secrets/github-app.pem'
const KEY_CANARY = 'FAKE-CANARY-GITHUB-APP-KEY'

mkdirSync('/tmp/roma-secrets', { recursive: true, mode: 0o700 })
writeFileSync(
  KEY,
  `-----BEGIN RSA PRIVATE KEY-----\n${KEY_CANARY}\n-----END RSA PRIVATE KEY-----\n`,
  {
    mode: 0o400,
  },
)
globalThis.heldKey = readFileSync(KEY, 'utf8')

const dropped =
  process.getuid() === 0
    ? dropRoot([{ variable: 'ROMA_GITHUB_PRIVATE_KEY_FILE', path: KEY }])
    : { dropped: false }
process.stderr.write(`harness: ${JSON.stringify(dropped)}\n`)

const PROBE = String.raw`
roma=$1 key=$2 canary=$3
report() { if [ -n "$2" ]; then echo "$1 REACHED"; else echo "$1 BLOCKED"; fi; }
echo "uid $(id -u)"
report key-file "$(grep -o "$canary" "$key" 2>/dev/null)"
report roma-environ "$(tr '\0' '\n' < /proc/$roma/environ 2>/dev/null | grep -o FAKE-CANARY-ROMA-ENV)"
report roma-memory "$(node -e '
const fs = require("fs"); const [pid, needle] = process.argv.slice(1); let fd
try { fd = fs.openSync("/proc/" + pid + "/mem", "r") } catch { process.exit(0) }
for (const line of fs.readFileSync("/proc/" + pid + "/maps", "utf8").split("\n")) {
  const m = line.match(/^([0-9a-f]+)-([0-9a-f]+) rw/); if (!m) continue
  const a = BigInt("0x" + m[1]), b = BigInt("0x" + m[2]); if (b - a > 64n << 20n) continue
  const buf = Buffer.alloc(Number(b - a))
  try { fs.readSync(fd, buf, 0, buf.length, a) } catch { continue }
  if (buf.includes(needle)) { console.log("found"); break }
}' "$roma" "$canary" 2>/dev/null)"
kill -USR1 "$roma" 2>/dev/null; sleep 1
report roma-inspector "$(node -e '
const s = require("net").connect(9229, "127.0.0.1")
s.on("connect", () => { console.log("open"); s.end() }); s.on("error", () => {})' 2>/dev/null)"
`

const agent = spawnClaudeProcess({
  command: 'sh',
  args: ['-c', PROBE, 'probe', String(process.pid), KEY, KEY_CANARY],
  cwd: '/tmp',
  env: buildEnv({
    credential: {
      kind: 'overflow',
      standIn: 'FAKE-CANARY-AGENT-OWN',
      baseUrl: 'http://127.0.0.1:9',
    },
    configDir: '/tmp',
  }),
})
agent.onStdout((chunk) => process.stdout.write(chunk))
agent.onStderr((chunk) => process.stderr.write(chunk))
agent.onExit(({ code }) => process.exit(code ?? 1))
