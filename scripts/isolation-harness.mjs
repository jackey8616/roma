import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnv } from '/app/dist/build-env.js'
import { dropRoot } from '/app/dist/drop-root.js'
import { writeEnclosures } from '/app/dist/enclosures.js'
import { realLauncher } from '/app/dist/launcher.js'
import { SEATS } from '/app/dist/seats.js'
import { seatSocketPathIn } from '/app/dist/shim-protocol.js'
import { ShimServer } from '/app/dist/shim-server.js'
import { WorkRoot } from '/app/dist/work-root.js'

const roots = { work: '/var/lib/roma/work', config: '/var/lib/roma/claude', shim: '/run/roma' }
const launcher = realLauncher()
launcher.writeRoots(roots)
const dropped = dropRoot([])
process.stderr.write(`harness: ${JSON.stringify(dropped)}\n`)
for (const root of [roots.work, roots.config, roots.shim]) chmodSync(root, 0o711)
await launcher.sweep()

const sessions = { a: randomUUID(), b: randomUUID() }
const seats = { b: 0, a: 1 }
const leases = new Map([
  [seats.b, sessions.b],
  [seats.a, sessions.a],
])
const work = new WorkRoot(roots.work, (sessionId) => launcher.reclaim(sessionId))
const gitConfigPath = join(roots.shim, 'gitconfig')

const shimLog = []
const token = { token: 'FAKE-ISOLATION-TOKEN', expiresAt: Date.now() + 3_600_000 }
const served = {
  code: { tokens: { fresh: async () => token, discard: () => {} }, account: null },
  cloud: { unavailable: 'not configured' },
  documents: { unavailable: 'not configured' },
}
const shims = []
for (let seat = 0; seat < SEATS; seat++) {
  shims.push(
    await ShimServer.listen({
      socketPath: seatSocketPathIn(roots.shim, seat),
      reaches: served,
      taskFor: (sessionId) => `task-${sessionId}`,
      holder: () => leases.get(seat) ?? null,
      log: (record) => shimLog.push(record),
    }),
  )
}
await launcher.handOutSockets()

const claimsOn = (sessionId) =>
  shimLog.filter((record) => record.event === 'credential' && record.sessionId === sessionId).length

const spawnSeated = (label, sessionId, seat, args) =>
  launcher.spawn({
    command: 'sh',
    args,
    cwd: work.sessionDir(sessionId),
    env: buildEnv({
      credential: {
        kind: 'overflow',
        standIn: `FAKE-ISOLATION-KEY-${label}`,
        baseUrl: 'http://127.0.0.1:9',
      },
      configDir: roots.config,
      shims: { sessionId, socketPath: seatSocketPathIn(roots.shim, seat), gitConfigPath },
      inherit: { PATH: process.env.PATH },
    }),
    seat: { seat, sessionId },
  })

const lines = (process, onLine) => {
  let buffer = ''
  process.onStdout((chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end === -1) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      onLine(line)
    }
  })
}

const PROBE = String.raw`
check() { if [ -n "$2" ]; then echo "$who $1 REACHED"; else echo "$who $1 BLOCKED"; fi; }
claim() { node -e '
const s = require("net").connect(process.env.ROMA_MINTER_SOCKET)
s.on("connect", () => s.write(JSON.stringify({ session: process.argv[1], operation: "get", credential: "code" }) + "\n"))
s.on("data", () => s.end()); s.on("error", () => {})' "$1" 2>/dev/null; }
probe() {
  cwd=$1 enclosure=$2 transcript=$3 tmp=$4 pid=$5
  check work-dir-read "$(cat "$cwd/notes.txt" 2>/dev/null)"
  check enclosure-read "$(cat "$enclosure" 2>/dev/null)"
  check transcript-read "$(cat "$transcript" 2>/dev/null)"
  check tmp-read "$(cat "$tmp" 2>/dev/null)"
  check work-dir-write "$(touch "$cwd/planted-by-$who" 2>/dev/null && echo written)"
  check transcript-write "$(echo '{"planted":true}' >> "$transcript" 2>/dev/null && echo written)"
  check environ-read "$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -o FAKE-ISOLATION-KEY-B)"
  check signal "$(kill -0 "$pid" 2>/dev/null && echo signalled)"
}
`

const PLANT = String.raw`
${PROBE}
echo ready
waited=0
while [ -z "$(ls .enclosures 2>/dev/null)" ] && [ "$waited" -lt 100 ]; do sleep 0.1; waited=$((waited + 1)); done
enclosure="$(pwd)/.enclosures/$(ls .enclosures | head -n 1)"
echo FAKE-ISOLATION-B-WORK > notes.txt
dir="$CLAUDE_CONFIG_DIR/projects/$(pwd | tr / -)"
mkdir -p "$dir"
transcript="$dir/$ROMA_SESSION_ID.jsonl"
(umask 077; echo '{"FAKE-ISOLATION-B-TRANSCRIPT":true}' > "$transcript")
tmp="$TMPDIR/roma-isolation-b.txt"
echo FAKE-ISOLATION-B-TMP > "$tmp"
claim "$ROMA_SESSION_ID"
who=control probe "$(pwd)" "$enclosure" "$transcript" "$tmp" $$
echo "planted $(pwd) $enclosure $transcript $tmp $$"
exec sleep 120
`

const READ = String.raw`
${PROBE}
who=a probe "$1" "$2" "$3" "$4" "$5"
claim "$6"
`

const b = spawnSeated('B', sessions.b, seats.b, ['-c', PLANT, 'plant'])
b.onStderr((chunk) => process.stderr.write(chunk))

const planted = await new Promise((resolve, reject) => {
  b.onExit(({ code }) => reject(new Error(`session B exited ${code} before it planted`)))
  lines(b, (line) => {
    if (line === 'ready') {
      writeEnclosures(
        [
          {
            name: 'canary.txt',
            from: null,
            redeem: async () => Buffer.from('FAKE-ISOLATION-B-ENCLOSURE'),
          },
        ],
        (name, content) => launcher.enclose(seats.b, sessions.b, name, content),
      ).catch(reject)
    } else if (line.startsWith('planted ')) resolve(line.split(' ').slice(1))
    else process.stdout.write(`${line}\n`)
  })
})

const claimsByB = claimsOn(sessions.b)
console.log(`control shim-claim ${claimsByB > 0 ? 'REACHED' : 'BLOCKED'}`)

const a = spawnSeated('A', sessions.a, seats.a, ['-c', READ, 'read', ...planted, sessions.b])
a.onStdout((chunk) => process.stdout.write(chunk))
a.onStderr((chunk) => process.stderr.write(chunk))
const exitA = await new Promise((resolve) => a.onExit(resolve))

console.log(`a shim-claim ${claimsOn(sessions.b) > claimsByB ? 'REACHED' : 'BLOCKED'}`)
process.stderr.write(`harness: A's Seat ${JSON.stringify(exitA.seat)}\n`)

b.kill('SIGTERM')
await new Promise((resolve) => b.onExit(resolve))
await Promise.all(shims.map((server) => server.close()))
process.exit(exitA.code ?? 1)
