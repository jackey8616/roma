// Q2 (event density during a long turn) + Q3 (in-band interrupt).
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { ClaudeSession, buildEnv, TURN } from '/Users/clode/Program/something/.scratch/proto/session.mjs'

const HERE = '/Users/clode/Program/something/.scratch/proto'
const TOKEN = readFileSync(`${HERE}/.env`, 'utf8')
  .match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m)[1].replace(/^["']|["']$/g, '')
mkdirSync(`${HERE}/work`, { recursive: true })

const id = randomUUID()
const s = new ClaudeSession({
  sessionId: id,
  cwd: `${HERE}/work`,
  env: buildEnv({ oauthToken: TOKEN, configDir: `${HERE}/claude-home` }),
  jsonlPath: `${HERE}/q3-${id.slice(0, 8)}.jsonl`,
})
console.log('session', id)

const t0 = Date.now()
const T = () => String(((Date.now() - t0) / 1000).toFixed(2)).padStart(7) + 's'
let lastEvt = null
let maxGap = 0
const gaps = []

s.on('event', (e) => {
  const now = Date.now()
  if (lastEvt !== null) {
    const gap = now - lastEvt
    gaps.push(gap)
    if (gap > maxGap) maxGap = gap
  }
  lastEvt = now
  const kind = [e.type, e.subtype].filter(Boolean).join('/')
  let extra = ''
  if (e.type === 'assistant' || e.type === 'user') {
    const c = e.message?.content
    if (Array.isArray(c)) {
      extra = c.map((b) =>
        b.type === 'text' ? JSON.stringify(b.text.replace(/\s+/g, ' ').slice(0, 50))
        : b.type === 'tool_use' ? `tool_use(${b.name}) ${JSON.stringify(b.input).slice(0, 60)}`
        : b.type === 'tool_result' ? `tool_result ${JSON.stringify(b.content).slice(0, 50)}`
        : b.type,
      ).join(' ')
    }
    if (e.isReplay) extra = 'REPLAY ' + extra
  }
  if (e.type === 'control_response') extra = JSON.stringify(e.response)
  if (e.type === 'result') extra = `is_error=${e.is_error} stop=${e.stop_reason} terminal=${e.terminal_reason} cost=${e.total_cost_usd}`
  console.log(`${T()}  ${kind.padEnd(20)} ${extra}`)
})

s.on('exit', (i) => console.log(`${T()}  *** PROCESS EXIT code=${i.code} signal=${i.signal}`))

// Pure generation: no tool calls, so nothing but the final assistant message
// arrives. This is the worst case for a stall detector.
const LONG =
  'Write a detailed 3000-word technical essay on the history and design of Unix pipes. ' +
  'Output the whole essay in a single message. Do not use any tools.'
let phase = 'long'

s.on('turn-end', (r, ms) => {
  console.log(`${T()}  === TURN END (${ms}ms) phase=${phase} alive=${s.alive}`)
  if (phase === 'long') {
    phase = 'survive'
    console.log(`${T()}  --- probing survival: sending a follow-up on the same process`)
    setTimeout(() => s.send('Reply with just: alive'), 500)
  } else {
    summary()
  }
})

function summary() {
  console.log('\n================ SUMMARY ================')
  console.log('process alive at end :', s.alive, '| pid', s.pid)
  console.log('turn durations (ms)  :', s.turnMs.join(', '))
  console.log('per-turn cost (diffed):', s.turnCost.map((c) => c.toFixed(6)).join(', '))
  console.log('max gap between events:', maxGap + 'ms')
  console.log('gaps > 3s            :', gaps.filter((g) => g > 3000).length, 'of', gaps.length)
  s.kill()
  setTimeout(() => process.exit(0), 300)
}

s.start()
setTimeout(() => {
  console.log(`${T()}  --- sending long turn`)
  s.send(LONG)
}, 300)

// Q3: interrupt mid-turn.
setTimeout(() => {
  if (s.turn === TURN.THINKING) {
    console.log(`${T()}  --- >>> IN-BAND INTERRUPT (control_request/interrupt)`)
    s.interrupt()
  } else {
    console.log(`${T()}  --- turn already idle, nothing to interrupt`)
  }
}, 15000)

setTimeout(() => { console.log('\nTIMEOUT'); summary() }, 150000)
