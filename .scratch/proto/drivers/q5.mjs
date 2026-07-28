// Q5: the two claims ADR-0003 marks unverified.
//
//   1. `--include-partial-messages` is supposed to emit incremental output during
//      pure token generation. It was inferred from the 10368ms silence measured
//      WITHOUT the flag (Q2). Nobody had run it with the flag on.
//   2. Declining stall detection was justified by generation being silent — which
//      is exactly what the flag removes. Whether a stalled turn is then
//      distinguishable from a slow tool call is unknown.
//
// Three arms, sequential, one fresh session each:
//   A  generation, flag ON   — does anything arrive during generation?
//   B  generation, flag OFF  — same prompt, same version, same hour: the control
//                              for A, so the comparison against Q2's 10368ms is
//                              not made across a day and a possible CLI change.
//   C  tool use,   flag ON   — what a slow tool call looks like next to generation.
//
// Every raw event is appended to q5-<arm>-<id>.jsonl; the numbers below are also
// written to q5-summary.json so the findings document can quote rather than assert.

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ClaudeSession, buildEnv } from '/Users/clode/Program/something/.scratch/proto/session.mjs'

const HERE = '/Users/clode/Program/something/.scratch/proto'
const TOKEN = readFileSync(`${HERE}/.env`, 'utf8')
  .match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m)[1].replace(/^["']|["']$/g, '')
mkdirSync(`${HERE}/work`, { recursive: true })

// Identical to q2q3.mjs's LONG, so A and B are comparable to the Q2 measurement.
const GEN =
  'Write a detailed 3000-word technical essay on the history and design of Unix pipes. ' +
  'Output the whole essay in a single message. Do not use any tools.'

// One deliberately slow Bash call. `sleep` is refused by the guard layer Q2 found
// ("Blocked: standalone sleep 45"), so this burns CPU instead — ~26s locally.
const SPIN = `awk 'BEGIN{s=0; for(i=0;i<600000000;i++) s+=i; print s}'`
const TOOL =
  `Run this exact command with the Bash tool and tell me the number it prints:\n\n${SPIN}\n\n` +
  'It takes about 30 seconds. Run it as written — do not shorten it, do not compute ' +
  'the answer yourself, and do not run anything else first.'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** type[/subtype] for a top-level event; for stream_event, the SSE shape underneath. */
function kindOf(evt) {
  if (evt.type !== 'stream_event') return [evt.type, evt.subtype].filter(Boolean).join('/')
  const inner = evt.event ?? {}
  const sub = inner.delta?.type ?? inner.content_block?.type ?? null
  return ['stream_event', inner.type, sub].filter(Boolean).join('/')
}

/**
 * Where the turn is when a gap opens. The stall question is not "how long is the
 * longest gap" but "can you tell which of these you are in", so every gap is
 * tagged with the phase that preceded it.
 */
function phaseAfter(evt, phase) {
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    if (evt.message.content.some((b) => b.type === 'tool_use')) return 'tool-running'
  }
  if (evt.type === 'user' && !evt.isReplay && Array.isArray(evt.message?.content)) {
    if (evt.message.content.some((b) => b.type === 'tool_result')) return 'post-tool'
  }
  if (evt.type === 'stream_event') {
    const d = evt.event?.delta?.type
    if (d === 'text_delta' || d === 'thinking_delta') return 'generating'
    if (d === 'input_json_delta') return 'tool-input'
    const cb = evt.event?.content_block?.type
    if (cb === 'tool_use') return 'tool-input'
  }
  if (evt.type === 'result') return 'done'
  return phase
}

async function runArm({ arm, prompt, partialMessages, timeoutMs = 300_000 }) {
  const id = randomUUID()
  const s = new ClaudeSession({
    sessionId: id,
    cwd: `${HERE}/work`,
    env: buildEnv({ oauthToken: TOKEN, configDir: `${HERE}/claude-home` }),
    jsonlPath: `${HERE}/q5-${arm}-${id.slice(0, 8)}.jsonl`,
    partialMessages,
  })

  const kinds = new Map()
  const samples = new Map() // first sighting of each stream_event shape
  const gaps = [] // { ms, endedBy, phase } — endedBy is the event that broke the silence
  let lastAt = null
  let phase = 'startup'
  let sentAt = null
  let firstDeltaMs = null
  let firstAnyMs = null
  let initEvent = null
  let toolNames = []

  s.on('event', (e) => {
    const now = Date.now()
    const kind = kindOf(e)
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)

    if (e.type === 'stream_event' && !samples.has(kind)) {
      samples.set(kind, JSON.stringify(e).slice(0, 400))
    }
    if (e.subtype === 'init' && !initEvent) {
      initEvent = { model: e.model, apiKeySource: e.apiKeySource }
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'tool_use') toolNames.push(b.name)
    }

    if (sentAt !== null) {
      if (firstAnyMs === null) firstAnyMs = now - sentAt
      const d = e.event?.delta?.type
      if (firstDeltaMs === null && (d === 'text_delta' || d === 'thinking_delta')) {
        firstDeltaMs = now - sentAt
      }
    }
    // `phase` here is the one the PREVIOUS event left behind — the phase the turn
    // was in while the gap was open. `kind` is this event, the one that ended it.
    if (lastAt !== null) gaps.push({ ms: now - lastAt, endedBy: kind, phase })
    lastAt = now
    phase = phaseAfter(e, phase)

    if (e.type === 'result') {
      console.log(
        `  result: is_error=${e.is_error} subtype=${e.subtype} stop=${e.stop_reason} ` +
          `terminal=${e.terminal_reason} duration=${e.duration_ms}ms cost=${e.total_cost_usd}`,
      )
    }
  })

  console.log(`\n######## ARM ${arm} — partialMessages=${partialMessages} ########`)
  console.log(`session ${id}`)
  s.start()
  await wait(400)

  const started = Date.now()
  sentAt = started
  lastAt = null
  s.send(prompt)

  const ended = await Promise.race([
    new Promise((r) => s.once('turn-end', () => r('turn-end'))),
    new Promise((r) => s.once('exit', () => r('process-exit'))),
    wait(timeoutMs).then(() => 'TIMEOUT'),
  ])
  const wallMs = Date.now() - started
  s.kill()
  await wait(300)

  // Gaps are only meaningful after the turn is genuinely under way: the wait for
  // the first token is a different thing from a gap mid-stream, and lumping them
  // together would flatter the flag.
  const midStream = gaps.slice(1)
  const sorted = midStream.map((g) => g.ms).sort((a, b) => a - b)
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] : null)
  const worstPerPhase = {}
  for (const g of midStream) {
    if (!worstPerPhase[g.phase] || g.ms > worstPerPhase[g.phase].ms) worstPerPhase[g.phase] = g
  }

  const out = {
    arm,
    partialMessages,
    sessionId: id,
    jsonl: `q5-${arm}-${id.slice(0, 8)}.jsonl`,
    ended,
    wallMs,
    events: [...kinds.values()].reduce((a, b) => a + b, 0),
    kinds: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
    init: initEvent,
    toolNames,
    firstEventMs: firstAnyMs,
    firstGenerationDeltaMs: firstDeltaMs,
    maxGapMs: sorted.length ? sorted[sorted.length - 1] : null,
    p50GapMs: pct(50),
    p90GapMs: pct(90),
    p99GapMs: pct(99),
    gapsOver3s: midStream.filter((g) => g.ms > 3000).length,
    gapsTotal: midStream.length,
    worstGapPerPhase: Object.fromEntries(
      Object.entries(worstPerPhase).map(([p, g]) => [p, { ms: g.ms, endedBy: g.endedBy }]),
    ),
    top5Gaps: [...midStream].sort((a, b) => b.ms - a.ms).slice(0, 5),
    costUsd: s.turnCost[0] ?? null,
    resultIsError: s.lastResult?.is_error ?? null,
    resultSubtype: s.lastResult?.subtype ?? null,
    streamEventSamples: Object.fromEntries(samples),
  }

  console.log(`  ended: ${ended}  wall ${wallMs}ms  events ${out.events}`)
  console.log(`  first event after send: ${out.firstEventMs}ms  first generation delta: ${out.firstGenerationDeltaMs}ms`)
  console.log(`  gaps: max ${out.maxGapMs}ms  p50 ${out.p50GapMs}ms  p90 ${out.p90GapMs}ms  p99 ${out.p99GapMs}ms  >3s ${out.gapsOver3s}/${out.gapsTotal}`)
  console.log('  worst gap per phase:', JSON.stringify(out.worstGapPerPhase))
  console.log('  event kinds:', JSON.stringify(out.kinds))
  return out
}

async function main() {
  const results = []
  results.push(await runArm({ arm: 'A-gen-flag-on', prompt: GEN, partialMessages: true }))
  results.push(await runArm({ arm: 'B-gen-flag-off', prompt: GEN, partialMessages: false }))
  results.push(await runArm({ arm: 'C-tool-flag-on', prompt: TOOL, partialMessages: true }))

  console.log('\n================ SUMMARY ================')
  for (const r of results) {
    console.log(
      `${r.arm.padEnd(16)} events=${String(r.events).padStart(5)}  maxGap=${String(r.maxGapMs).padStart(6)}ms  ` +
        `p90=${String(r.p90GapMs).padStart(5)}ms  >3s=${r.gapsOver3s}  wall=${r.wallMs}ms  cost=${r.costUsd?.toFixed(6)}`,
    )
  }
  writeFileSync(`${HERE}/q5-summary.json`, JSON.stringify(results, null, 2) + '\n')
  console.log(`\nwrote ${HERE}/q5-summary.json`)
  process.exit(0)
}

main()
