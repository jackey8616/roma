// PROTOTYPE — throwaway. Answers the unmeasured behaviour #35 hinges on.
//
// THE QUESTION
// ------------
// ADR-0003 left a hole: roma reclaims a Session's working directory after seven
// idle days, but the Transcript `--resume` needs is Claude Code's and roma does
// not delete it. So a Conversation that goes quiet and comes back is spawned
// with `--session-id` at an id that MAY STILL HAVE A TRANSCRIPT — and what the
// CLI does with that has never been run.
//
// #35 asks whether roma should reclaim the Transcript alongside the directory.
// Three of its four open questions depend on the answer below.
//
// WHAT THIS COSTS
// ---------------
// Every probe is one tiny Turn at most, and several are expected to cost ZERO
// because they should fail at spawn before a token is generated. The unit of
// spend here is the same Turn roma's startup self-check fires at EVERY boot
// ('Reply with OK and nothing else'), so N turns ≈ N roma boots.
//
// Three gates, because "what the CLI does" is exactly what is unmeasured and
// this must not be able to run away:
//
//   1. HARD TURN CAP — every send() goes through spend(). Past the cap it
//      throws rather than sending. Nothing can loop.
//   2. KILL ON FIRST TERMINAL EVENT — a turn ends at `result` and the process
//      is killed immediately; a per-turn deadline kills it anyway if no
//      terminal event arrives.
//   3. METERED BY DEFAULT — refuses to touch the Shared Window everybody
//      shares unless --allow-shared-window is passed explicitly.
//
// RUN
// ---
//   node .scratch/proto/drivers/transcript-reclamation.mjs
//   node .scratch/proto/drivers/transcript-reclamation.mjs --allow-shared-window
//   node .scratch/proto/drivers/transcript-reclamation.mjs --dry-run   (spends nothing)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeSession, buildEnv } from '../session.mjs'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const ROOT = join(REPO, '.tmp/proto-transcript')
const OUT = join(REPO, '.scratch/proto/transcript-reclamation')

// ---------------------------------------------------------------- gate 1
const MAX_TURNS = 8
const TURN_DEADLINE_MS = 90_000

const budget = { spent: 0, cap: MAX_TURNS }
function spend(what) {
  if (budget.spent >= budget.cap) {
    throw new Error(`TURN CAP REACHED (${budget.cap}) — refusing to send for "${what}"`)
  }
  budget.spent += 1
  console.log(`  [budget] turn ${budget.spent}/${budget.cap} — ${what}`)
}

// ---------------------------------------------------------------- gate 3
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const ALLOW_SHARED = args.includes('--allow-shared-window')

// --only=P5 runs one probe. P5 is self-contained — its own session id, its own
// setup — so it can be run without paying for P0-P4 a second time.
const ONLY = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.toUpperCase() ?? null
const want = (probe) => ONLY === null || ONLY === probe

function dotEnv() {
  try {
    const values = {}
    for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return values
  } catch {
    return {}
  }
}

function credential() {
  const env = { ...dotEnv(), ...process.env }
  const metered = env.ROMA_OVERFLOW_API_KEY || env.ANTHROPIC_API_KEY
  if (metered) return { kind: 'metered', apiKey: metered }

  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauth && ALLOW_SHARED) return { kind: 'shared-window', oauthToken: oauth }

  console.error(
    [
      '',
      'REFUSING TO RUN — no metered credential.',
      '',
      'This prototype defaults to metered billing so it cannot eat into the Shared',
      'Window everybody shares. Set one of these in .env at the repo root:',
      '',
      '  ROMA_OVERFLOW_API_KEY=sk-ant-...    (or ANTHROPIC_API_KEY)',
      '',
      `At most ${MAX_TURNS} tiny turns — order of a few US cents.`,
      '',
      'To run it on the Shared Window token instead, pass --allow-shared-window.',
      `Worst case there is ${MAX_TURNS} turns, which is ${MAX_TURNS} roma boots' worth`,
      "of the startup self-check. Several probes are expected to cost zero.",
      '',
    ].join('\n'),
  )
  process.exit(1)
}

// ---------------------------------------------------------------- helpers

/** Where Claude Code put the Transcript for this session, if anywhere. */
function findTranscript(configDir, sessionId) {
  const hits = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.includes(sessionId)) hits.push(path)
    }
  }
  walk(configDir)
  return hits
}

function describeTranscripts(configDir, sessionId) {
  return findTranscript(configDir, sessionId).map((path) => ({
    path: path.replace(REPO, ''),
    bytes: statSync(path).size,
    lines: readFileSync(path, 'utf8').split('\n').filter(Boolean).length,
  }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every process this driver spawns, so none of them can outlive it. A probe
// that leaves one alive holds the node event loop open and the run never ends —
// which is exactly what the first dry run did.
const LIVE = []
function killEverything() {
  for (const session of LIVE) {
    try {
      session.kill()
    } catch {}
  }
}
process.on('exit', killEverything)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killEverything()
    process.exit(1)
  })
}

/**
 * Spawn one process and watch it, without sending anything.
 *
 * This is the whole point of the exercise: a session-id collision is expected
 * to surface HERE — as a non-zero exit or a stderr line — before any Turn is
 * started and therefore before anything is billed.
 */
async function observeSpawn({ sessionId, cwd, env, resume, label, settleMs = 8_000 }) {
  const session = new ClaudeSession({
    sessionId,
    cwd,
    env,
    resume,
    jsonlPath: join(OUT, `${label}.jsonl`),
  })

  LIVE.push(session)

  const events = []
  session.on('event', (evt) => events.push({ type: evt.type, subtype: evt.subtype }))

  let exited = null
  session.on('exit', (info) => (exited = info))

  session.start()
  console.log(`  spawn: claude ${session.args.join(' ')}`)

  // Settle: either it dies (the interesting case) or it comes up and waits.
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline && exited === null) await sleep(200)

  return {
    argv: session.args,
    exited,
    events,
    stderr: session.tail.filter((n) => n.type === 'stderr').map((n) => n.note),
    session,
  }
}

/** One turn, gated. Kills the process the moment the turn is terminal. */
async function oneTurn(session, text, what) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would send: ${what}`)
    return { dryRun: true }
  }
  spend(what)

  let result = null
  const answered = new Promise((resolve) => {
    session.once('turn-end', (evt) => {
      result = evt
      resolve()
    })
  })

  session.send(text)

  // gate 2: terminal event, or the deadline kills it regardless.
  const timeout = sleep(TURN_DEADLINE_MS).then(() => 'timeout')
  const outcome = await Promise.race([answered.then(() => 'answered'), timeout])

  const text_ = result?.result ?? null
  session.kill()
  return { outcome, text: text_, cost: result?.total_cost_usd ?? null, isError: result?.is_error }
}

function reply(turn) {
  return (turn?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---------------------------------------------------------------- probes

const WORD = 'HALIBUT'
const REMEMBER = `Remember the word ${WORD}. Reply with OK and nothing else. Do not use any tools.`
const RECALL = 'What word did I ask you to remember? Reply with just that word, or the word NONE if I did not. Do not use any tools.'

async function main() {
  const cred = credential()
  console.log(`\ncredential: ${cred.kind}${DRY_RUN ? '  (DRY RUN — spends nothing)' : ''}`)
  if (cred.kind === 'shared-window') {
    console.log('*** running against the SHARED WINDOW everybody shares ***')
  }

  // The scratch Sessions are rebuilt every run and nothing outlives them.
  rmSync(ROOT, { recursive: true, force: true })
  // The captured streams are NOT. They are the primary source the write-up and
  // the tickets cite, and wiping them here is how one `--only=P5` run silently
  // destroyed P0-P4's evidence and then committed the deletion. A run overwrites
  // the probes it actually runs and leaves every other probe's capture alone.
  mkdirSync(OUT, { recursive: true })
  if (ONLY === null) {
    for (const stale of readdirSync(OUT)) rmSync(join(OUT, stale), { force: true })
  }

  const configDir = join(ROOT, 'claude-home')
  const cwd = join(ROOT, 'work/conversation-one')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  const env = buildEnv({
    configDir,
    ...(cred.kind === 'metered' ? { apiKey: cred.apiKey } : { oauthToken: cred.oauthToken }),
  })

  // A fixed id, reused by every probe below — that reuse IS the question.
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const findings = []

  // ---- P0: establish a Session with something in it, so later probes can
  // tell "resumed" from "started fresh" by asking for the word back.
  if (want('P0')) {
console.log('\n=== P0 — establish a Session and its Transcript ===')
    const spawned = await observeSpawn({ sessionId, cwd, env, resume: false, label: 'p0-establish' })
    const turn = await oneTurn(spawned.session, REMEMBER, 'P0 establish')
    spawned.session.kill()
    await sleep(1_000)
    const transcripts = describeTranscripts(configDir, sessionId)
    console.log(`  reply: ${reply(turn)}`)
    console.log(`  transcript: ${JSON.stringify(transcripts, null, 2)}`)
    findings.push({ probe: 'P0', question: 'where does the Transcript land, and does one Turn create it?', argv: spawned.argv, turn, transcripts })
  }

  // ---- P1: THE HOLE. Same id, Transcript still present, cwd still present.
  // Spawned with --session-id (not --resume), which is what roma does when the
  // working directory is gone but it has forgotten the Session exists.
  if (want('P1')) {
console.log('\n=== P1 — --session-id at an id that already has a Transcript ===')
    const spawned = await observeSpawn({ sessionId, cwd, env, resume: false, label: 'p1-collide' })
    console.log(`  exited: ${JSON.stringify(spawned.exited)}`)
    console.log(`  stderr: ${JSON.stringify(spawned.stderr)}`)
    console.log(`  events before any send: ${JSON.stringify(spawned.events)}`)

    let turn = null
    if (spawned.exited === null) {
      // It came up. The only way to tell fresh from resumed is to ask.
      turn = await oneTurn(spawned.session, RECALL, 'P1 fresh-or-resumed')
      console.log(`  reply: ${reply(turn)}   <-- ${WORD} means it RESUMED; NONE means FRESH`)
    } else {
      console.log('  died at spawn — cost zero turns, which is the answer')
    }
    spawned.session.kill()
    findings.push({ probe: 'P1', question: 'what does --session-id do at an id with a live Transcript?', argv: spawned.argv, exited: spawned.exited, stderr: spawned.stderr, eventsBeforeSend: spawned.events, turn })
  }

  // ---- P2: roma's actual reclaim, simulated — working directory deleted and
  // recreated empty, Transcript untouched. This is the state a Conversation
  // that went quiet for eight days comes back to today.
  if (want('P2')) {
console.log('\n=== P2 — working directory reclaimed, Transcript left behind ===')
    rmSync(cwd, { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
    console.log('  cwd deleted and recreated empty; transcript untouched')
    console.log(`  transcript still: ${JSON.stringify(describeTranscripts(configDir, sessionId))}`)

    const spawned = await observeSpawn({ sessionId, cwd, env, resume: false, label: 'p2-reclaimed-cwd' })
    console.log(`  exited: ${JSON.stringify(spawned.exited)}`)
    console.log(`  stderr: ${JSON.stringify(spawned.stderr)}`)

    let turn = null
    if (spawned.exited === null) {
      turn = await oneTurn(spawned.session, RECALL, 'P2 fresh-or-resumed')
      console.log(`  reply: ${reply(turn)}   <-- ${WORD} means context SURVIVED the reclaim`)
    } else {
      console.log('  died at spawn — a reclaimed Conversation cannot be served today')
    }
    spawned.session.kill()
    findings.push({ probe: 'P2', question: "does roma's reclaim leave a Conversation unservable?", argv: spawned.argv, exited: spawned.exited, stderr: spawned.stderr, turn })
  }

  // ---- P3: --resume with the Transcript deleted. Expected to fail at spawn,
  // costing nothing. This is what #35's reclamation would do to a Session that
  // is still resident somewhere.
  if (want('P3')) {
console.log('\n=== P3 — --resume with the Transcript deleted ===')
    for (const { path } of describeTranscripts(configDir, sessionId)) {
      rmSync(join(REPO, path), { force: true })
      console.log(`  deleted ${path}`)
    }
    const spawned = await observeSpawn({ sessionId, cwd, env, resume: true, label: 'p3-resume-no-transcript' })
    console.log(`  exited: ${JSON.stringify(spawned.exited)}`)
    console.log(`  stderr: ${JSON.stringify(spawned.stderr)}`)
    console.log(`  events: ${JSON.stringify(spawned.events)}`)
    if (spawned.exited === null) console.log('  *** did NOT die — --resume tolerates a missing Transcript ***')
    spawned.session.kill()
    findings.push({ probe: 'P3', question: 'what does --resume do with no Transcript?', argv: spawned.argv, exited: spawned.exited, stderr: spawned.stderr, eventsBeforeSend: spawned.events })
  }

  // ---- P4: the in-place reset ADR-0003 rejected as "unmeasured". If #35 makes
  // roma delete the Transcript, `/new` could reuse the id instead of carrying a
  // generation record — which would let session-generation.ts go entirely.
  if (want('P4')) {
console.log('\n=== P4 — in-place reset: same id, Transcript AND cwd gone ===')
    rmSync(cwd, { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
    const spawned = await observeSpawn({ sessionId, cwd, env, resume: false, label: 'p4-in-place-reset' })
    console.log(`  exited: ${JSON.stringify(spawned.exited)}`)
    console.log(`  stderr: ${JSON.stringify(spawned.stderr)}`)

    let turn = null
    if (spawned.exited === null) {
      turn = await oneTurn(spawned.session, RECALL, 'P4 clean-slate check')
      console.log(`  reply: ${reply(turn)}   <-- NONE means the id was genuinely reusable`)
    } else {
      console.log('  died at spawn — in-place reset stays rejected')
    }
    spawned.session.kill()
    findings.push({ probe: 'P4', question: 'can an id be reused once its Transcript is gone?', argv: spawned.argv, exited: spawned.exited, stderr: spawned.stderr, turn })
  }

  // ---- P5: THE FIX #40 RESTS ON. Everything above measured what breaks; this
  // measures whether the proposed repair actually works. Working directory
  // reclaimed and recreated empty, Transcript still present, spawned with
  // --resume instead of --session-id.
  //
  // The Transcript is keyed by a slug of the ABSOLUTE cwd, and the recreated
  // directory sits at the same path — so it ought to resolve. "Ought to" is the
  // word the whole hole came from, hence this probe.
  if (want('P5')) {
    console.log('\n=== P5 — --resume onto a reclaimed working directory ===')
    const id5 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const cwd5 = join(ROOT, 'work/conversation-five')
    mkdirSync(cwd5, { recursive: true })

    // Establish it, exactly as P0 did.
    const first = await observeSpawn({ sessionId: id5, cwd: cwd5, env, resume: false, label: 'p5a-establish' })
    const established = await oneTurn(first.session, REMEMBER, 'P5 establish')
    first.session.kill()
    await sleep(1_000)
    console.log(`  established, reply: ${reply(established)}`)
    console.log(`  transcript: ${JSON.stringify(describeTranscripts(configDir, id5))}`)

    // The reclaim: directory gone and recreated empty, Transcript untouched.
    rmSync(cwd5, { recursive: true, force: true })
    mkdirSync(cwd5, { recursive: true })
    console.log('  cwd deleted and recreated empty; transcript untouched')

    const retry = await observeSpawn({ sessionId: id5, cwd: cwd5, env, resume: true, label: 'p5b-resume-after-reclaim' })
    console.log(`  exited: ${JSON.stringify(retry.exited)}`)
    console.log(`  stderr: ${JSON.stringify(retry.stderr)}`)

    let recall = null
    if (retry.exited === null) {
      recall = await oneTurn(retry.session, RECALL, 'P5 context-survived check')
      console.log(`  reply: ${reply(recall)}   <-- ${WORD} means #40's fix WORKS and context survived`)
    } else {
      console.log("  died at spawn — #40's approach is wrong; the fix has to go through #35")
    }
    retry.session.kill()
    findings.push({ probe: 'P5', question: "does --resume reach a Session whose working directory was reclaimed?", argv: retry.argv, exited: retry.exited, stderr: retry.stderr, established, recall })
  }

  // ---------------------------------------------------------------- summary
  const summary = {
    ranAt: new Date().toISOString(),
    credential: cred.kind,
    dryRun: DRY_RUN,
    turnsSpent: budget.spent,
    turnCap: budget.cap,
    sessionId,
    findings,
  }
  // Named for the run, so an --only= run cannot overwrite the full run's summary
  // the way it once overwrote its captures.
  const summaryFile = ONLY === null ? 'summary.json' : `summary-${ONLY.toLowerCase()}.json`
  writeFileSync(join(OUT, summaryFile), JSON.stringify(summary, null, 2))

  console.log(`\n=== done — ${budget.spent}/${budget.cap} turns spent ===`)
  console.log(`raw streams and summary: ${OUT.replace(REPO, '')}`)

  // Explicit, not left to process.on('exit'): a live child holds the event loop
  // open, so 'exit' never fires and the run hangs instead of finishing.
  killEverything()
}

main().catch((error) => {
  console.error(`\nSTOPPED: ${error.message}`)
  console.error(`turns spent before stopping: ${budget.spent}/${budget.cap}`)
  killEverything()
  process.exit(1)
})
