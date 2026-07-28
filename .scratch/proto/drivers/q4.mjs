// Q3b: SIGTERM mid-turn + --resume recovery (ADR-0001's LRU eviction path).
// Q4:  negative test — does a stray ANTHROPIC_API_KEY silently win?
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { ClaudeSession, buildEnv, TURN } from '/Users/clode/Program/something/.scratch/proto/session.mjs'

const HERE = '/Users/clode/Program/something/.scratch/proto'
const TOKEN = readFileSync(`${HERE}/.env`, 'utf8')
  .match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m)[1].replace(/^["']|["']$/g, '')
const BOGUS = 'sk-ant-api03-PROTOTYPE-NEGATIVE-TEST-not-a-real-key'
mkdirSync(`${HERE}/work`, { recursive: true })

const t0 = Date.now()
const T = () => String(((Date.now() - t0) / 1000).toFixed(2)).padStart(7) + 's'

function mk(id, { apiKey = null, resume = false } = {}) {
  const s = new ClaudeSession({
    sessionId: id,
    cwd: `${HERE}/work`,
    env: buildEnv({ oauthToken: TOKEN, apiKey, configDir: `${HERE}/claude-home` }),
    resume,
    jsonlPath: `${HERE}/q4-${id.slice(0, 8)}.jsonl`,
  })
  s.on('event', (e) => {
    const kind = [e.type, e.subtype].filter(Boolean).join('/')
    let extra = ''
    if (e.subtype === 'init') extra = `apiKeySource=${JSON.stringify(e.apiKeySource)} model=${e.model}`
    if (e.type === 'assistant' && Array.isArray(e.message?.content))
      extra = e.message.content.map((b) => (b.type === 'text' ? JSON.stringify(b.text.slice(0, 70)) : b.type)).join(' ')
    if (e.type === 'result') extra = `is_error=${e.is_error} subtype=${e.subtype} result=${JSON.stringify(e.result)?.slice(0, 90)}`
    if (kind === 'user' && e.isReplay) return
    console.log(`${T()}  ${kind.padEnd(22)} ${extra}`)
  })
  s.on('exit', (i) => console.log(`${T()}  *** EXIT code=${i.code} signal=${i.signal}`))
  return s
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const turnEnd = (s) => new Promise((r) => s.once('turn-end', (res, ms) => r({ res, ms })))
const exited = (s) => new Promise((r) => s.once('exit', r))

const SID = randomUUID()

async function main() {
  // ---- part 1: establish context, then SIGTERM mid-turn ----
  console.log('\n######## PART 1 — establish context, SIGTERM mid-turn ########')
  let s = mk(SID)
  s.start()
  await wait(300)
  s.send('Remember the number 47. Reply with just: ok')
  await turnEnd(s)

  s.send('Write a detailed 3000-word essay on Unix pipes. No tools. One message.')
  await wait(6000)
  console.log(`${T()}  --- >>> SIGTERM mid-turn (turn=${s.turn})`)
  s.sigterm()
  const ex = await exited(s)
  console.log(`${T()}  SIGTERM result: code=${ex.code} signal=${ex.signal}  (docs claim exit 143)`)

  // ---- part 2: resume after kill ----
  console.log('\n######## PART 2 — --resume after the kill ########')
  s = mk(SID, { resume: true })
  s.start()
  await wait(500)
  s.send('What number did I give you earlier? Reply with just the number.')
  const { res } = await turnEnd(s)
  console.log(`${T()}  RESUME VERDICT: context ${JSON.stringify(res.result).includes('47') ? 'SURVIVED' : 'LOST'}`)
  s.kill()
  await wait(500)

  // ---- part 3: Q4 negative test ----
  console.log('\n######## PART 3 — Q4 negative: token + bogus ANTHROPIC_API_KEY ########')
  const s2 = mk(randomUUID(), { apiKey: BOGUS })
  s2.start()
  await wait(300)
  s2.send('Reply with just: ok')
  const { res: r2 } = await turnEnd(s2)
  console.log(`${T()}  NEGATIVE TEST VERDICT: ${r2.is_error ? 'API KEY WON (subscription overridden)' : 'OAUTH TOKEN WON (key ignored)'}`)
  s2.kill()
  await wait(300)
  process.exit(0)
}

main()
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 240000)
