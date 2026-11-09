// roma's half of the I1 containment check in `scripts/verify-image.sh`
// (GHSA-v52v-hcv8-cr23, ADR-0032). Runs inside the built image, fed on stdin,
// and does what roma does at boot with the image's own compiled code: read a
// key file and keep it in memory, drop root with `dropRoot`, then spawn the
// agent with `buildEnv` and `spawnClaudeProcess`. The agent here is a probe
// rather than `claude`, because `claude` needs a credential CI does not have;
// it is spawned exactly as `claude` would be, as roma's child, as `node`.
//
// The probe prints one line per thing the agent tries: `<check> REACHED` or
// `<check> BLOCKED`. Fake canaries only — nothing here is a credential.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildEnv } from '/app/dist/build-env.js'
import { spawnClaudeProcess } from '/app/dist/claude-process.js'
import { dropRoot } from '/app/dist/drop-root.js'

const KEY = '/tmp/roma-secrets/github-app.pem'
const KEY_CANARY = 'FAKE-CANARY-GITHUB-APP-KEY'

// Made by whoever roma starts as: root in the image as it ships, `node` in the
// control run that stands in for the image before the fix.
mkdirSync('/tmp/roma-secrets', { recursive: true, mode: 0o700 })
writeFileSync(
  KEY,
  `-----BEGIN RSA PRIVATE KEY-----\n${KEY_CANARY}\n-----END RSA PRIVATE KEY-----\n`,
  {
    mode: 0o400,
  },
)
// Held for the life of the process, as `GitHubMinter` holds the PEM.
globalThis.heldKey = readFileSync(KEY, 'utf8')

const dropped = dropRoot([{ variable: 'ROMA_GITHUB_PRIVATE_KEY_FILE', path: KEY }])
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
    credential: { kind: 'overflow', apiKey: 'FAKE-CANARY-AGENT-OWN' },
    configDir: '/tmp',
  }),
})
agent.onStdout((chunk) => process.stdout.write(chunk))
agent.onStderr((chunk) => process.stderr.write(chunk))
agent.onExit(({ code }) => process.exit(code ?? 1))
