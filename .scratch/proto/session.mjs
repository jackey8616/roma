// PROTOTYPE — throwaway. See README.md for the question this answers.
//
// The portable bit: a ClaudeSession owns one long-lived `claude -p` process
// speaking stream-json in both directions, and exposes a turn-level view of it
// (idle / thinking / finished) plus the timings a caller would need to decide
// whether keeping the process resident is worth it.
//
// No terminal code in here. The TUI imports this; nothing flows back.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'

export const TURN = { IDLE: 'IDLE', THINKING: 'THINKING' }

const CLAUDE = 'claude'

/** Build the explicitly-constructed environment ADR-0002 specifies. */
export function buildEnv({ oauthToken, apiKey, configDir }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR,
  }
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir
  }
  // Absent, not empty — an empty string still occupies its slot in precedence.
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  return env
}

export class ClaudeSession extends EventEmitter {
  constructor({ sessionId, cwd, env, resume = false, jsonlPath = null }) {
    super()
    this.sessionId = sessionId
    this.cwd = cwd
    this.env = env
    this.resume = resume
    this.jsonlPath = jsonlPath

    this.proc = null
    this.pid = null
    this.alive = false
    this.exitInfo = null

    this.turn = TURN.IDLE
    this.spawnedAt = null
    this.firstEventAt = null
    this.turnStartedAt = null
    this.eventsThisTurn = 0
    this.lastEventAt = null

    this.coldStartMs = null
    this.turnMs = [] // completed turn durations, newest last
    this.lastResult = null
    // total_cost_usd is a CUMULATIVE session total, not a per-turn figure.
    // A per-task audit record has to diff it.
    this.cumCost = 0
    this.turnCost = [] // per-turn deltas, newest last
    this.tail = [] // recent { t, type, subtype, note }

    this._buf = ''
    this._reqSeq = 0
    this._jsonl = null
  }

  get args() {
    const a = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--replay-user-messages',
      '--verbose',
    ]
    // --resume and --session-id are mutually exclusive in practice: resuming
    // already names the session.
    if (this.resume) a.push('--resume', this.sessionId)
    else a.push('--session-id', this.sessionId)
    return a
  }

  start() {
    if (this.alive) return
    if (this.jsonlPath) this._jsonl = createWriteStream(this.jsonlPath, { flags: 'a' })

    this.spawnedAt = Date.now()
    this.firstEventAt = null
    this.coldStartMs = null
    this.exitInfo = null

    this.proc = spawn(CLAUDE, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pid = this.proc.pid
    this.alive = true
    this._note('spawn', `pid ${this.pid}${this.resume ? ' (--resume)' : ''}`)

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d) => this._note('stderr', d.trim().slice(0, 200)))

    this.proc.on('exit', (code, signal) => {
      this.alive = false
      this.turn = TURN.IDLE
      this.exitInfo = { code, signal, at: Date.now() }
      this._note('exit', `code=${code} signal=${signal}`)
      this._jsonl?.end()
      this._jsonl = null
      this.emit('exit', this.exitInfo)
    })
    this.proc.on('error', (err) => this._note('error', err.message))
  }

  /** Feed one user message. Starts a turn. */
  send(text) {
    if (!this.alive) return false
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    }
    this.turn = TURN.THINKING
    this.turnStartedAt = Date.now()
    this.eventsThisTurn = 0
    this._write(msg)
    this._note('->send', text.slice(0, 60))
    this.emit('turn-start', text)
    return true
  }

  /** Q3: the in-band interrupt the SDK control protocol documents. */
  interrupt() {
    if (!this.alive) return false
    const requestId = `req_${++this._reqSeq}_proto`
    this._write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    })
    this._note('->interrupt', requestId)
    return true
  }

  /** Q3: the documented-but-fatal path. Ends the whole process. */
  sigterm() {
    if (!this.alive) return false
    this.proc.kill('SIGTERM')
    this._note('->SIGTERM', `pid ${this.pid}`)
    return true
  }

  kill() {
    if (this.proc && this.alive) this.proc.kill('SIGKILL')
  }

  closeStdin() {
    this.proc?.stdin.end()
    this._note('->stdin', 'closed (EOF)')
  }

  _write(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  _onStdout(chunk) {
    this._buf += chunk
    let nl
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim()
      this._buf = this._buf.slice(nl + 1)
      if (!line) continue
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        this._note('unparsed', line.slice(0, 120))
        continue
      }
      this._onEvent(evt)
    }
  }

  _onEvent(evt) {
    const now = Date.now()
    if (this.firstEventAt === null) {
      this.firstEventAt = now
      this.coldStartMs = now - this.spawnedAt
    }
    this.lastEventAt = now
    this.eventsThisTurn++
    this._jsonl?.write(JSON.stringify({ _t: now, ...evt }) + '\n')

    this._note(evt.type, this._describe(evt))

    // Q2: is there a terminal event per turn, or only per process exit?
    if (evt.type === 'result') {
      const ms = this.turnStartedAt ? now - this.turnStartedAt : null
      if (ms !== null) this.turnMs.push(ms)
      const total = typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null
      if (total !== null) {
        this.turnCost.push(total - this.cumCost)
        this.cumCost = total
      }
      this.turn = TURN.IDLE
      this.lastResult = evt
      this.emit('turn-end', evt, ms)
    }

    this.emit('event', evt)
  }

  _describe(evt) {
    switch (evt.type) {
      case 'system':
        return evt.subtype ?? ''
      case 'assistant':
      case 'user': {
        const content = evt.message?.content
        if (!Array.isArray(content)) return String(content ?? '').slice(0, 60)
        return content
          .map((b) =>
            b.type === 'text' ? b.text.replace(/\s+/g, ' ').slice(0, 60)
            : b.type === 'tool_use' ? `[tool_use ${b.name}]`
            : b.type === 'tool_result' ? '[tool_result]'
            : b.type === 'thinking' ? '[thinking]'
            : `[${b.type}]`,
          )
          .join(' ')
          .slice(0, 70)
      }
      case 'result':
        return `${evt.subtype} err=${evt.is_error} ${evt.duration_ms}ms cost=${evt.total_cost_usd}`
      case 'control_response':
        return JSON.stringify(evt.response ?? {}).slice(0, 70)
      default:
        return ''
    }
  }

  _note(type, note = '') {
    this.tail.push({ t: Date.now(), type, note })
    if (this.tail.length > 400) this.tail.shift()
  }

  /** Longest gap between consecutive events in the current turn — Q2's stall question. */
  silenceMs() {
    return this.lastEventAt ? Date.now() - this.lastEventAt : null
  }
}
