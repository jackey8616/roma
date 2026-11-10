import { randomUUID } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AuditLog, monthOf } from '/app/dist/audit-log.js'
import { sealAudit } from '/app/dist/audit-seal.js'
import { buildEnv } from '/app/dist/build-env.js'
import { spawnRuntimeProcess } from '/app/dist/runtime-process.js'
import { dropRoot } from '/app/dist/drop-root.js'
import { realLauncher } from '/app/dist/launcher.js'

const exposed = process.argv[2] === 'exposed'
const auditRoot = exposed ? '/srv/shared/roma/audit' : '/var/lib/roma/audit'
const controlRoot = '/tmp/audit-control/audit'
const month = monthOf(new Date())
const roots = { work: '/var/lib/roma/work', config: '/var/lib/roma/claude', shim: '/run/roma' }

const record = (taskId, caller, costUsd) => ({
  taskId,
  caller,
  callerName: 'Harness',
  sessionId: null,
  outcome: 'result',
  costUsd,
  durationMs: 1,
  turnMs: 1,
  credential: 'overflow',
  apiKeySource: 'ANTHROPIC_API_KEY',
})

if (exposed) {
  mkdirSync('/srv/shared', { recursive: true })
  chmodSync('/srv/shared', 0o777)
  mkdirSync(auditRoot, { recursive: true })
  chownSync('/srv/shared/roma', 1000, 1000)
  chownSync(auditRoot, 1000, 1000)
} else {
  new AuditLog({ auditRoot }).record(record('seeded', 'users/harness-seeded', 1))
  chownSync(join(auditRoot, `${month}.jsonl`), 1000, 1000)
  chmodSync(auditRoot, 0o755)
}

const launcher = realLauncher()
launcher.writeRoots(roots)
const dropped = dropRoot([])
process.stderr.write(`harness: ${JSON.stringify(dropped)}\n`)
for (const root of [roots.work, roots.config, roots.shim]) chmodSync(root, 0o711)
await launcher.sweep()

let sealed
try {
  sealed = sealAudit(auditRoot)
} catch (error) {
  console.log('audit refused')
  process.stderr.write(`${error.message}\n`)
  process.exit(0)
}
console.log(`audit tightened ${sealed.tightened}`)

const PROBE = String.raw`
who=$1 root=$2 month=$3
file="$root/$month.jsonl"
check() { if [ -n "$2" ]; then echo "$who $1 REACHED"; else echo "$who $1 BLOCKED"; fi; }
echo "$who uid $(id -u)"
forged='{"at":"2026-01-01T00:00:00.000Z","taskId":"forged","caller":"users/FAKE-victim","sessionId":null,"outcome":"result","costUsd":0,"durationMs":1,"turnMs":1,"credential":"overflow","apiKeySource":"ANTHROPIC_API_KEY"}'
check audit-read "$(cat "$file" 2>/dev/null)"
check audit-append "$(printf '%s\n' "$forged" >> "$file" 2>/dev/null && echo written)"
check audit-rewrite "$(printf '%s\n' "$forged" > "$file" 2>/dev/null && echo written)"
check audit-new-month "$(printf '%s\n' "$forged" > "$root/2099-01.jsonl" 2>/dev/null && echo written)"
check audit-delete "$(rm "$file" 2>/dev/null && echo deleted)"
moved=""
dir="$root"
while [ "$dir" != / ]; do
  if mv "$dir" "$dir.moved" 2>/dev/null; then moved=$dir; break; fi
  dir=$(dirname "$dir")
done
check audit-swap "$moved"
`

const control = spawnRuntimeProcess({
  command: 'sh',
  args: [
    '-c',
    `mkdir -p ${controlRoot} && echo seeded > ${controlRoot}/${month}.jsonl && ${PROBE}`,
    'probe',
    'control',
    controlRoot,
    month,
  ],
  cwd: '/tmp',
  env: { PATH: process.env.PATH },
})
control.onStdout((chunk) => process.stdout.write(chunk))
await new Promise((resolve) => control.onExit(resolve))

const audit = new AuditLog({ auditRoot })
audit.record(record('before', 'users/harness-before', 2))

const sessionId = randomUUID()
const seated = launcher.spawn({
  command: 'sh',
  args: ['-c', PROBE, 'probe', 'seat', auditRoot, month],
  cwd: join(roots.work, sessionId),
  env: buildEnv({
    credential: { kind: 'overflow', standIn: 'FAKE-AUDIT-KEY', baseUrl: 'http://127.0.0.1:9' },
    configDir: roots.config,
    inherit: { PATH: process.env.PATH },
  }),
  seat: { seat: 0, sessionId },
})
seated.onStdout((chunk) => process.stdout.write(chunk))
seated.onStderr((chunk) => process.stderr.write(chunk))
await new Promise((resolve) => seated.onExit(resolve))

audit.record(record('after', 'users/harness-after', 4))
const callers = audit.readMonth(month).map(({ caller }) => caller)
const intact =
  callers.join(',') === 'users/harness-seeded,users/harness-before,users/harness-after' &&
  audit.totalFor(month).costUsd === 7
console.log(intact ? 'ledger intact' : `ledger changed ${JSON.stringify(callers)}`)
process.exit(0)
