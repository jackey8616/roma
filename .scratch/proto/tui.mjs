// PROTOTYPE — throwaway TUI shell over session.mjs. Delete when the questions
// in README.md are answered.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeSession, buildEnv, TURN } from './session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = join(HERE, 'claude-home')
const WORK_DIR = join(HERE, 'work')
const BOGUS_KEY = 'sk-ant-api03-PROTOTYPE-NEGATIVE-TEST-not-a-real-key'

const B = (s) => `\x1b[1m${s}\x1b[0m`
const D = (s) => `\x1b[2m${s}\x1b[0m`
const G = (s) => `\x1b[32m${s}\x1b[0m`
const R = (s) => `\x1b[31m${s}\x1b[0m`
const Y = (s) => `\x1b[33m${s}\x1b[0m`

function loadToken() {
  const p = join(HERE, '.env')
  if (!existsSync(p)) return null
  const m = readFileSync(p, 'utf8').match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

const TOKEN = loadToken()
if (!TOKEN) {
  console.error('No CLAUDE_CODE_OAUTH_TOKEN in .scratch/proto/.env')
  process.exit(1)
}

mkdirSync(WORK_DIR, { recursive: true })
mkdirSync(CONFIG_DIR, { recursive: true })

const SESSION_ID = randomUUID()
let withBogusKey = false
let session = null
let typing = null // { buf } while in [t] free-text mode

function makeSession({ resume }) {
  return new ClaudeSession({
    sessionId: SESSION_ID,
    cwd: WORK_DIR,
    env: buildEnv({
      oauthToken: TOKEN,
      apiKey: withBogusKey ? BOGUS_KEY : null,
      configDir: CONFIG_DIR,
    }),
    resume,
    jsonlPath: join(HERE, `events-${SESSION_ID.slice(0, 8)}.jsonl`),
  })
}

function respawn({ resume }) {
  if (session?.alive) session.kill()
  session = makeSession({ resume })
  session.on('event', scheduleRender)
  session.on('exit', scheduleRender)
  session.start()
}

// ---------------------------------------------------------------- rendering

let renderPending = false
function scheduleRender() {
  if (renderPending) return
  renderPending = true
  setTimeout(() => {
    renderPending = false
    render()
  }, 100)
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return D('—')
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

function hhmmss(t) {
  const d = new Date(t)
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function render() {
  const s = session
  const out = []
  out.push(B('PROTOTYPE') + D('  persistent headless `claude -p` — .scratch/proto'))
  out.push(D('Q1 multi-turn · Q2 end-of-turn signal · Q3 interrupt · Q4 billing'))
  out.push('')

  out.push(B('PROCESS'))
  const state = s.alive ? G('alive') : R(`dead${s.exitInfo ? ` (code=${s.exitInfo.code} signal=${s.exitInfo.signal})` : ''}`)
  out.push(`  pid          ${s.pid ?? D('—')}   ${state}`)
  out.push(`  session      ${D(SESSION_ID)}`)
  out.push(`  args         ${D(s.args.join(' '))}`)
  out.push(
    `  env          CLAUDE_CODE_OAUTH_TOKEN=${G('set')}  ` +
      `ANTHROPIC_API_KEY=${withBogusKey ? R('BOGUS (negative test)') : D('absent')}`,
  )
  out.push(`  ${D('cwd          ' + WORK_DIR)}`)
  out.push('')

  out.push(B('TURN'))
  const elapsed = s.turn === TURN.THINKING && s.turnStartedAt ? Date.now() - s.turnStartedAt : null
  out.push(
    `  state        ${s.turn === TURN.THINKING ? Y('THINKING') : G('IDLE')}   ` +
      (elapsed !== null ? fmtMs(elapsed) : ''),
  )
  const silence = s.silenceMs()
  out.push(
    `  events       ${s.eventsThisTurn}   ` +
      D(`silence ${silence === null ? '—' : fmtMs(silence)}`),
  )
  out.push(`  cold start   ${B(fmtMs(s.coldStartMs))}   ${D('spawn → first event')}`)
  out.push(`  turns        ${s.turnMs.length ? s.turnMs.map(fmtMs).join(', ') : D('—')}`)
  out.push('')

  out.push(B('LAST RESULT'))
  const r = s.lastResult
  if (!r) {
    out.push(D('  (none yet)'))
  } else {
    out.push(`  subtype      ${r.subtype}   is_error ${r.is_error ? R('true') : 'false'}`)
    out.push(`  duration     ${fmtMs(r.duration_ms)}   ${D(`api ${fmtMs(r.duration_api_ms)}  turns ${r.num_turns}`)}`)
    const delta = s.turnCost[s.turnCost.length - 1]
    out.push(
      `  ${B('total_cost_usd')}  ${r.total_cost_usd === undefined ? R('ABSENT') : String(r.total_cost_usd)}  ` +
        D('(CUMULATIVE — session total, not this turn)'),
    )
    out.push(`  ${B('this turn')}    ${delta === undefined ? D('—') : B(delta.toFixed(6))}   ${D('diffed — what an audit record should log')}`)
    if (r.usage) {
      const u = r.usage
      out.push(
        D(`  usage        in ${u.input_tokens} / out ${u.output_tokens} / ` +
          `cache_r ${u.cache_read_input_tokens ?? 0} / cache_w ${u.cache_creation_input_tokens ?? 0}`),
      )
    }
    if (r.result && typeof r.result === 'string') {
      out.push(D(`  result       ${r.result.replace(/\s+/g, ' ').slice(0, 68)}`))
    }
  }
  out.push('')

  out.push(B('EVENTS') + D(` (last 12 of ${s.tail.length})`))
  for (const e of s.tail.slice(-12)) {
    out.push(`  ${D(hhmmss(e.t))}  ${e.type.padEnd(16)} ${D(e.note)}`)
  }
  out.push('')

  if (typing) {
    out.push(B('prompt> ') + typing.buf + '█')
    out.push(D('enter to send · esc to cancel'))
  } else {
    out.push(
      D('[1]') + ' remember 47   ' + D('[2]') + ' recall   ' + D('[3]') + ' long turn (sleep 30)   ' +
        D('[t]') + ' type prompt',
    )
    out.push(
      D('[i]') + ' interrupt (in-band)   ' + D('[k]') + ' SIGTERM   ' + D('[r]') + ' respawn --resume   ' +
        D('[c]') + ' respawn cold',
    )
    out.push(D('[x]') + ' toggle bogus ANTHROPIC_API_KEY + respawn   ' + D('[d]') + ' close stdin   ' + D('[q]') + ' quit')
  }

  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n')
}

// ------------------------------------------------------------------- input

const PROMPTS = {
  '1': 'Remember the number 47. Reply with just: ok',
  '2': 'What number did I give you? Reply with just the number.',
  '3': 'Use the Bash tool to run `sleep 30`, then reply: done',
}

function onKey(key) {
  if (typing) {
    if (key === '\r' || key === '\n') {
      const text = typing.buf.trim()
      typing = null
      if (text) session.send(text)
    } else if (key === '\x1b') {
      typing = null
    } else if (key === '\x7f') {
      typing.buf = typing.buf.slice(0, -1)
    } else if (key === '\x03') {
      quit()
    } else if (key >= ' ') {
      typing.buf += key
    }
    return render()
  }

  switch (key) {
    case '1': case '2': case '3':
      session.send(PROMPTS[key])
      break
    case 't':
      typing = { buf: '' }
      break
    case 'i':
      session.interrupt()
      break
    case 'k':
      session.sigterm()
      break
    case 'r':
      respawn({ resume: true })
      break
    case 'c':
      respawn({ resume: false })
      break
    case 'x':
      withBogusKey = !withBogusKey
      respawn({ resume: session.turnMs.length > 0 || session.lastResult !== null })
      break
    case 'd':
      session.closeStdin()
      break
    case 'q': case '\x03':
      return quit()
  }
  render()
}

function quit() {
  if (session?.alive) session.kill()
  process.stdout.write('\x1b[2J\x1b[H')
  console.log(`events written to .scratch/proto/events-${SESSION_ID.slice(0, 8)}.jsonl`)
  process.exit(0)
}

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', onKey)

respawn({ resume: false })
setInterval(render, 250)
render()
