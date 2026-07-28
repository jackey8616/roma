// Smoke: prove the module spawns, streams, and completes a turn. Not part of
// the prototype — just checks the TUI won't be dead on arrival.
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { ClaudeSession, buildEnv } from '/Users/clode/Program/something/.scratch/proto/session.mjs'

const HERE = '/Users/clode/Program/something/.scratch/proto'
const TOKEN = readFileSync(`${HERE}/.env`, 'utf8')
  .match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m)[1]
  .replace(/^["']|["']$/g, '')

mkdirSync(`${HERE}/work`, { recursive: true })

const id = randomUUID()
const s = new ClaudeSession({
  sessionId: id,
  cwd: `${HERE}/work`,
  env: buildEnv({ oauthToken: TOKEN, configDir: `${HERE}/claude-home` }),
  jsonlPath: `${HERE}/smoke-${id.slice(0, 8)}.jsonl`,
})

const t0 = Date.now()
s.on('event', (e) => {
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${e.type}${e.subtype ? '/' + e.subtype : ''}`)
})
s.on('exit', (i) => console.log('EXIT', i))

let turns = 0
s.on('turn-end', (r, ms) => {
  turns++
  console.log(`--- turn ${turns} done in ${ms}ms`)
  console.log('    is_error:', r.is_error, '| subtype:', r.subtype)
  console.log('    total_cost_usd:', JSON.stringify(r.total_cost_usd))
  console.log('    result:', JSON.stringify(r.result)?.slice(0, 120))
  if (turns === 1) {
    setTimeout(() => s.send('What number did I give you? Reply with just the number.'), 200)
  } else {
    console.log('\nCOLD START:', s.coldStartMs, 'ms   TURNS:', s.turnMs.join(', '), 'ms')
    console.log('PROCESS STILL ALIVE BETWEEN TURNS:', s.alive)
    s.kill()
    process.exit(0)
  }
})

s.start()
setTimeout(() => s.send('Remember the number 47. Reply with just: ok'), 300)
setTimeout(() => { console.log('TIMEOUT'); s.kill(); process.exit(1) }, 120000)
