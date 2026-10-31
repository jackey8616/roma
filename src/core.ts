import { randomUUID } from 'node:crypto'
import { Attempts, waitMsUntil } from './attempts.js'
import {
  monthOf,
  type AuditBreakdown,
  type AuditLog,
  type CredentialSpend,
  type TaskOutcome,
} from './audit-log.js'
import type { CredentialKind } from './build-env.js'
import { attributed, relayed } from './attribution.js'
import {
  CAVEMAN_NAMES,
  CAVEMAN_NOT_PINNED,
  CAVEMAN_OFF,
  PINNED_CAVEMAN_NAME,
  readCavemanRequest,
  type CavemanRequest,
} from './caveman.js'
import type {
  ChannelAdapter,
  IngressMessage,
  OutboundInstruction,
  TaskAddress,
} from './channel-adapter.js'
import { TranscriptNotFound, TurnFailedError, wasInterrupted, type Turn } from './claude-session.js'
import { readCommand, type Command, type CommandRequest } from './commands.js'
import { severityOf, type CompactionSeverity } from './compaction.js'
import {
  EFFORT_NAMES,
  EFFORT_NOT_APPLIED,
  PINNED_EFFORT_NAME,
  readEffortRequest,
  takesEffort,
  type EffortRequest,
} from './effort-menu.js'
import { EnclosureUnreadable, writeEnclosures } from './enclosures.js'
import {
  MENU_NAMES,
  menuNameFor,
  PINNED_NAME,
  readModelRequest,
  type ModelRequest,
} from './model-menu.js'
import { readRelay, type RelayRequest } from './relays.js'
import { ProgressReporter } from './progress-reporter.js'
import { RUNTIME_NAMES, type Runtime } from './runtime.js'
import {
  ChosenCavemanNotOffered,
  ChosenEffortNotOffered,
  ChosenModelNotOffered,
  type ChosenRecord,
  type SessionGenerations,
} from './session-generation.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import {
  readCompaction,
  readCompactionFailure,
  readSharedWindow,
  readSystemInit,
  type ClaudeEvent,
  type Compaction,
} from './stream-events.js'
import type { TaskQueue } from './task-queue.js'
import type { WorkRoot } from './work-root.js'

export interface OverflowOptions {
  readonly monthlyCapUsd: number
}

export type CoreLogRecord =
  | {
      readonly event: 'overflow-refused'
      readonly taskId: string
      readonly month: string
      readonly capUsd: number
      readonly spentUsd: number
      readonly unpriced: number
      readonly unreadable: number
    }
  | {
      readonly event: 'free-relay-did-model-work'
      readonly taskId: string
      readonly command: string
      readonly outputTokens: number
      readonly costUsd: number | null
    }
  | {
      readonly event: 'compaction-failed'
      readonly taskId: string
      readonly sessionId: string
      readonly code: string | null
      readonly severity: Exclude<CompactionSeverity, 'benign'>
    }

export type CoreLog = OperatorLog<CoreLogRecord>

export interface CoreOptions {
  readonly channel: ChannelAdapter
  readonly pool: SessionPool
  readonly workRoot: WorkRoot
  readonly queue: TaskQueue
  readonly sessions: SessionGenerations
  readonly models: ChosenRecord<'model'>
  readonly efforts: ChosenRecord<'effort'>
  readonly cavemen: ChosenRecord<'caveman'>
  readonly cavemanPinned?: boolean
  readonly audit: AuditLog
  readonly credential: CredentialKind
  readonly overflow?: OverflowOptions
  readonly usedCloudReach?: (taskId: string) => boolean
  readonly usedDocumentReach?: (taskId: string) => boolean
  readonly log?: CoreLog
}

type Resumption = 'reset' | 'overflow' | 'stopped'

interface RunningTask extends TaskAddress {
  readonly sessionId: string
  readonly relay: RelayRequest | null
  model: string
  effort: string
  caveman: string | null
  stopped: boolean
  toldContextFull: boolean
  readonly attempts: Attempts
  parked: Parked | null
}

interface Parked {
  readonly wake: (resumption: Resumption) => void
  readonly timer: NodeJS.Timeout
  readonly offered: boolean
}

export class Core {
  readonly #channel: ChannelAdapter
  readonly #pool: SessionPool
  readonly #workRoot: WorkRoot
  readonly #queue: TaskQueue
  readonly #sessions: SessionGenerations
  readonly #models: ChosenRecord<'model'>
  readonly #efforts: ChosenRecord<'effort'>
  readonly #cavemen: ChosenRecord<'caveman'>
  readonly #cavemanPinned: boolean
  readonly #audit: AuditLog
  readonly #credential: CredentialKind
  readonly #overflow: OverflowOptions | null
  readonly #usedCloudReach: (taskId: string) => boolean
  readonly #usedDocumentReach: (taskId: string) => boolean
  readonly #log: CoreLog
  readonly #running = new Set<RunningTask>()
  readonly #openings = new Map<string, Promise<void>>()

  constructor({
    channel,
    pool,
    workRoot,
    queue,
    sessions,
    models,
    efforts,
    cavemen,
    cavemanPinned,
    audit,
    credential,
    overflow,
    usedCloudReach,
    usedDocumentReach,
    log,
  }: CoreOptions) {
    if (!channel.capabilities.stableConversationKey) {
      throw new Error('a Channel must supply a stable Conversation Key')
    }
    this.#channel = channel
    this.#pool = pool
    this.#workRoot = workRoot
    this.#queue = queue
    this.#sessions = sessions
    this.#models = models
    this.#efforts = efforts
    this.#cavemen = cavemen
    this.#cavemanPinned = cavemanPinned ?? false
    this.#audit = audit
    this.#credential = credential
    this.#overflow = overflow ?? null
    this.#usedCloudReach = usedCloudReach ?? (() => false)
    this.#usedDocumentReach = usedDocumentReach ?? (() => false)
    this.#log = log ?? writeToStderr
  }

  async handle(message: IngressMessage): Promise<void> {
    const command = readCommand(message.text)
    if (command !== null) return await this.#runCommand(command, message)
    const opened = this.#open(message)
    const relay = readRelay(message.text)
    if (relay !== null && relay.cost === 'free') {
      return await this.#runFreeRelay(relay, message, opened)
    }
    return await this.#runTask(message, relay, opened)
  }

  async #deliverAfter(
    opened: Promise<void> | undefined,
    instruction: OutboundInstruction,
  ): Promise<void> {
    await opened
    await this.#channel.deliver(instruction)
  }

  async #open(message: IngressMessage): Promise<void> {
    let record: string
    let sessionId: string
    try {
      sessionId = this.#sessions.sessionFor(message.conversationKey)
      const already = this.#openings.get(sessionId)
      if (already !== undefined) return await already
      record = this.#workRoot.openedRecord(sessionId)
      if (this.#workRoot.readRecord(record) !== null) {
        this.#openings.set(sessionId, Promise.resolve())
        return
      }
    } catch {
      return
    }

    const opening = this.#deliverOpening(sessionId, record, message)
    this.#openings.set(sessionId, opening)
    await opening
  }

  async #deliverOpening(sessionId: string, record: string, message: IngressMessage): Promise<void> {
    try {
      await this.#channel.deliver({
        kind: 'result',
        ...addressOf({ ...message, taskId: randomUUID() }),
        text: this.#settingsReport(sessionId),
      })
    } catch {
      this.#openings.delete(sessionId)
      return
    }
    try {
      this.#workRoot.writeRecord(record, '')
    } catch {}
  }

  async #runFreeRelay(
    relay: RelayRequest,
    message: IngressMessage,
    opened: Promise<void>,
  ): Promise<void> {
    const { command } = relay
    const { conversationKey } = message
    const address = addressOf({ ...message, taskId: randomUUID() })
    const { taskId } = address
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) => this.#deliverAfter(opened, { kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    let session: string | null = null
    let model: string | null = null
    let effort: string | null = null
    let turn: Turn | null = null
    try {
      const sessionId = this.#sessions.sessionFor(conversationKey)
      session = sessionId
      model = this.#models.inForce(sessionId)
      effort = this.#efforts.inForce(sessionId)
      if (!this.#pool.residents.includes(sessionId)) reporter.update({ phase: 'working' })

      turn = await this.#queue.run(
        sessionId,
        () => this.#pool.send(sessionId, relayed(message, relay), this.#credential),
        {
          notice: (position) => reporter.update({ phase: 'queued', position }),
          uncapped: true,
          taskId,
        },
      )
      instruction = { kind: 'result', ...address, text: turn.text }
    } catch (error) {
      if (error instanceof TurnFailedError) turn = error.turn
      instruction = { kind: 'failure', ...address, reason: reasonFor(error) }
    }

    if (turn !== null && turn.outputTokens !== null && turn.outputTokens > 0) {
      this.#log({
        event: 'free-relay-did-model-work',
        taskId,
        command,
        outputTokens: turn.outputTokens,
        costUsd: turn.costUsd,
      })
    }

    this.#audit.record({
      kind: 'relay',
      taskId,
      caller: message.caller,
      callerName: message.callerName,
      sessionId: session,
      outcome: outcomeOf(instruction),
      costUsd: turn === null ? 0 : turn.costUsd,
      durationMs: Date.now() - startedAt,
      turnMs: turn?.durationMs ?? null,
      credential: this.#credential,
      runtime: EVERY_SESSION_RUNS_ON,
      model: model ?? this.#models.pinned,
      effort: effortOn(model ?? this.#models.pinned, effort ?? this.#efforts.pinned),
      caveman: this.#cavemanOnRecord(session === null ? null : this.#pool.cavemanOn(session)),
      outputTokens: turn === null ? 0 : turn.outputTokens,
      cloudReach: this.#usedCloudReach(taskId),
      documentReach: this.#usedDocumentReach(taskId),
      apiKeySource: null,
    })

    reporter.stop()
    await this.#deliverAfter(opened, instruction)
  }

  async #runCommand(request: CommandRequest, message: IngressMessage): Promise<void> {
    const { conversationKey } = message
    const address = addressOf({ ...message, taskId: randomUUID() })

    let instruction: OutboundInstruction
    try {
      instruction =
        request.command === 'model'
          ? this.#answerModel(readModelRequest(request.argument), conversationKey, address)
          : request.command === 'effort'
            ? this.#answerEffort(readEffortRequest(request.argument), conversationKey, address)
            : request.command === 'caveman'
              ? this.#answerCaveman(readCavemanRequest(request.argument), conversationKey, address)
              : request.command === 'config'
                ? this.#answerConfig(request.argument, conversationKey, address)
                : request.command === 'usage'
                  ? this.#answerUsage(address)
                  : {
                      kind: 'command-outcome',
                      ...address,
                      command: request.command,
                      carriedOut: this.#carryOut(request.command, conversationKey),
                    }
    } catch (error) {
      instruction = { kind: 'failure', ...address, reason: commandReasonFor(error) }
    }

    await this.#channel.deliver(instruction)
  }

  #answerModel(
    request: ModelRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    const sessionId = this.#sessions.sessionFor(conversationKey)

    switch (request.kind) {
      case 'unknown':
        return modelChoice(address, unknownModelReason(request.name), request.name)
      case 'report':
        return modelChoice(address, this.#modelReport(sessionId), null)
      case 'default':
        this.#models.usePinned(sessionId)
        return {
          kind: 'result',
          ...address,
          text:
            fromNextMessage(PINNED_NAME, this.#models.pinned) +
            this.#effortStranded(sessionId, this.#models.pinned),
        }
      case 'chosen':
        this.#models.choose(sessionId, request.model)
        return {
          kind: 'result',
          ...address,
          text:
            fromNextMessage(request.name, request.model) +
            this.#effortStranded(sessionId, request.model),
        }
    }
  }

  #effortStranded(sessionId: string, model: string): string {
    if (takesEffort(model) !== false) return ''
    const chosen = this.#efforts.chosenFor(sessionId)
    return chosen === null ? '' : ` ${takesNoEffort(model, chosen)}`
  }

  #answerEffort(
    request: EffortRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    const sessionId = this.#sessions.sessionFor(conversationKey)

    switch (request.kind) {
      case 'unknown': {
        const reason = unknownEffortReason(request.name)
        return this.#effortApplies(sessionId)
          ? effortChoice(address, reason, request.name)
          : { kind: 'failure', ...address, reason }
      }
      case 'report': {
        const text = this.#effortReport(sessionId)
        return this.#effortApplies(sessionId)
          ? effortChoice(address, text, null)
          : { kind: 'result', ...address, text }
      }
      case 'default':
        this.#efforts.usePinned(sessionId)
        return {
          kind: 'result',
          ...address,
          text:
            atNextMessage(PINNED_EFFORT_NAME, this.#efforts.pinned) +
            this.#modelTakesNone(sessionId),
        }
      case 'chosen':
        this.#efforts.choose(sessionId, request.level)
        return {
          kind: 'result',
          ...address,
          text: atNextMessage(request.level, request.level) + this.#modelTakesNone(sessionId),
        }
    }
  }

  #effortReport(sessionId: string): string {
    return (
      `This conversation runs at ${this.#effortNamed(sessionId)}. ` +
      `You can choose: ${EFFORT_LIST}.` +
      this.#modelTakesNone(sessionId)
    )
  }

  #effortNamed(sessionId: string): string {
    const chosen = this.#efforts.chosenFor(sessionId)
    return chosen ?? `${PINNED_EFFORT_NAME} (${this.#efforts.pinned})`
  }

  #modelTakesNone(sessionId: string): string {
    if (this.#effortApplies(sessionId)) return ''
    return ` ${takesNoEffort(this.#models.inForce(sessionId))}`
  }

  #effortApplies(sessionId: string): boolean {
    return takesEffort(this.#models.inForce(sessionId)) !== false
  }

  #answerCaveman(
    request: CavemanRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    const sessionId = this.#sessions.sessionFor(conversationKey)

    switch (request.kind) {
      case 'unknown':
        return cavemanChoice(address, unknownCavemanReason(request.name), request.name)
      case 'report':
        return cavemanChoice(address, this.#cavemanReport(sessionId), null)
      case 'default':
        this.#cavemen.usePinned(sessionId)
        return {
          kind: 'result',
          ...address,
          text: atNextCaveman(PINNED_CAVEMAN_NAME, this.#cavemen.pinned),
        }
      case 'chosen':
        this.#cavemen.choose(sessionId, request.level)
        return {
          kind: 'result',
          ...address,
          text: atNextCaveman(request.level, request.level),
        }
    }
  }

  #cavemanReport(sessionId: string): string {
    return (
      `This conversation runs at caveman ${this.#cavemanNamed(sessionId)}. ` +
      `You can choose: ${CAVEMAN_LIST}.`
    )
  }

  #cavemanNamed(sessionId: string): string {
    const chosen = this.#cavemen.chosenFor(sessionId)
    return chosen ?? `${PINNED_CAVEMAN_NAME} (${this.#cavemen.pinned})`
  }

  #answerConfig(
    argument: string | null,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    if (argument !== null) {
      return { kind: 'failure', ...address, reason: CONFIG_SETS_NOTHING }
    }
    return {
      kind: 'result',
      ...address,
      text: this.#settingsReport(this.#sessions.sessionFor(conversationKey)),
    }
  }

  #answerUsage(address: TaskAddress): OutboundInstruction {
    return {
      kind: 'result',
      ...address,
      text: monthReport(this.#audit.breakdownFor(monthOf(new Date()))),
    }
  }

  #settingsReport(sessionId: string): string {
    const caveman = this.#cavemanWorthSaying(sessionId)
    return (
      `This conversation is on ${this.#modelNamed(sessionId)}, ` +
      `at ${this.#effortNamed(sessionId)}` +
      (caveman === null ? '' : `, at caveman ${caveman}`) +
      '. ' +
      (caveman === null
        ? `Change either with “/model” or “/effort”.`
        : `Change any with “/model”, “/effort” or “/caveman”.`) +
      this.#modelTakesNone(sessionId)
    )
  }

  #cavemanWorthSaying(sessionId: string): string | null {
    if (this.#cavemen.inForce(sessionId) === CAVEMAN_OFF) return null
    return this.#cavemanNamed(sessionId)
  }

  #modelReport(sessionId: string): string {
    return `This conversation is on ${this.#modelNamed(sessionId)}. You can choose: ${MENU_LIST}.`
  }

  #modelNamed(sessionId: string): string {
    const chosen = this.#models.chosenFor(sessionId)
    return named(chosen === null ? PINNED_NAME : menuNameFor(chosen), chosen ?? this.#models.pinned)
  }

  #carryOut(command: Extract<Command, 'stop' | 'clear'>, conversationKey: string): boolean {
    switch (command) {
      case 'clear':
        this.#sessions.freshSession(conversationKey)
        return true
      case 'stop':
        return this.#stop(conversationKey)
    }
  }

  #stop(conversationKey: string): boolean {
    const mine = [...this.#running].filter((task) => task.conversationKey === conversationKey)
    for (const task of mine) {
      task.stopped = true
      this.#wake(task, 'stopped')
      this.#pool.interrupt(task.sessionId)
    }
    return mine.length > 0
  }

  async #runTask(
    message: IngressMessage,
    relay: RelayRequest | null,
    opened: Promise<void>,
  ): Promise<void> {
    const { conversationKey } = message
    const address = addressOf({ ...message, taskId: randomUUID() })
    const { taskId } = address
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) => this.#deliverAfter(opened, { kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    let running: RunningTask | null = null
    const attempts = new Attempts(this.#credential)
    try {
      const sessionId = this.#sessions.sessionFor(conversationKey)
      const task: RunningTask = {
        ...address,
        sessionId,
        model: this.#models.inForce(sessionId),
        effort: this.#efforts.inForce(sessionId),
        caveman: null,
        stopped: false,
        toldContextFull: false,
        attempts,
        parked: null,
        relay,
      }
      running = task
      this.#running.add(task)

      const enclosures =
        relay !== null || message.enclosures.length === 0
          ? []
          : await writeEnclosures(message.enclosures, this.#workRoot.sessionDir(sessionId))

      instruction = await this.#drive(
        task,
        relay === null ? attributed(message, enclosures) : relayed(message, relay),
        reporter,
      )
      if (relay !== null && instruction.kind === 'result') {
        instruction = { ...instruction, text: relayReply(attempts.compaction(), instruction.text) }
      }
    } catch (error) {
      instruction = { kind: 'failure', ...address, reason: reasonFor(error) }
    } finally {
      if (running !== null) this.#running.delete(running)
    }

    const answeredOn = attempts.answeredOn() ?? this.#credential
    const durationMs = Date.now() - startedAt
    const outcome = outcomeOf(instruction)
    const cloudReach = this.#usedCloudReach(taskId)
    const documentReach = this.#usedDocumentReach(taskId)
    for (const credential of [
      answeredOn,
      ...attempts.credentials().filter((c) => c !== answeredOn),
    ]) {
      const paid = attempts.spentOn(credential)
      if (credential !== answeredOn && !paid.costUsd && paid.compaction === null) continue
      this.#audit.record({
        ...(relay === null ? {} : { kind: 'relay' as const }),
        taskId,
        caller: message.caller,
        callerName: message.callerName,
        sessionId: running?.sessionId ?? null,
        outcome,
        costUsd: paid.costUsd,
        durationMs,
        turnMs: paid.turnMs,
        credential,
        runtime: EVERY_SESSION_RUNS_ON,
        model: running?.model ?? this.#models.pinned,
        effort: effortOn(
          running?.model ?? this.#models.pinned,
          running?.effort ?? this.#efforts.pinned,
        ),
        caveman: this.#cavemanOnRecord(running?.caveman ?? null),
        outputTokens: paid.outputTokens,
        cloudReach,
        documentReach,
        ...(paid.compaction === null ? {} : { compaction: paid.compaction }),
        apiKeySource: attempts.apiKeySource(),
      })
    }

    reporter.stop()
    await this.#deliverAfter(opened, instruction)
  }

  #cavemanOnRecord(ranAt: string | null): string {
    const level = ranAt ?? this.#cavemen.pinned
    return !this.#cavemanPinned && level === CAVEMAN_OFF ? CAVEMAN_NOT_PINNED : level
  }

  async #drive(
    task: RunningTask,
    text: string,
    reporter: ProgressReporter,
  ): Promise<OutboundInstruction> {
    const { taskId, attempts } = task
    const address = addressOf(task)

    for (;;) {
      const paidBy = attempts.begins()
      let turn: Turn | null = null
      let error: unknown = null
      try {
        turn = await this.#queue.run(
          task.sessionId,
          () => this.#runTurn(task, paidBy, text, reporter),
          {
            notice: (position) => reporter.update({ phase: 'queued', position }),
            taskId,
          },
        )
      } catch (thrown) {
        error = thrown
        if (thrown instanceof TurnFailedError) turn = thrown.turn
      }

      attempts.ended(turn)
      attempts.payWith(this.#credential)

      if (error === null && turn !== null) {
        return {
          kind: 'result',
          ...address,
          text: turn.text,
          ...(paidBy === 'overflow'
            ? { overflowCostUsd: attempts.spentOn('overflow').costUsd }
            : {}),
        }
      }

      if (!task.stopped && (await this.#park(task))) continue

      return task.stopped || wasStopped(error)
        ? { kind: 'stopped', ...address }
        : { kind: 'failure', ...address, reason: reasonFor(error) }
    }
  }

  async #park(task: RunningTask): Promise<boolean> {
    const park = task.attempts.takePark()
    if (park === null) return false

    const offered = this.#overflow !== null && park.overageAllowed
    await this.#tell(task, {
      kind: 'blocked',
      ...addressOf(task),
      resetsAt: park.resetsAt,
      overflowOffered: offered,
    })

    const resumption = await new Promise<Resumption>((wake) => {
      const timer = setTimeout(
        () => this.#wake(task, 'reset'),
        waitMsUntil(park.resetsAt, Date.now()),
      )
      timer.unref?.()
      task.parked = { wake, timer, offered }
    })
    this.#unpark(task)

    return resumption !== 'stopped'
  }

  async takeOverflow(taskId: string): Promise<boolean> {
    const task = [...this.#running].find(
      (candidate) => candidate.taskId === taskId && candidate.parked?.offered === true,
    )
    const overflow = this.#overflow
    if (task === undefined || overflow === null) return false

    const month = monthOf(new Date())
    const spent = this.#audit.totalFor(month, 'overflow')
    if (spent.costUsd >= overflow.monthlyCapUsd) {
      this.#log({
        event: 'overflow-refused',
        taskId,
        month,
        capUsd: overflow.monthlyCapUsd,
        spentUsd: spent.costUsd,
        unpriced: spent.unpriced,
        unreadable: spent.unreadable,
      })
      await this.#tell(task, {
        kind: 'overflow-refused',
        ...addressOf(task),
        capUsd: overflow.monthlyCapUsd,
        spentUsd: spent.costUsd,
      })
      return true
    }

    task.attempts.payWith('overflow')
    this.#wake(task, 'overflow')
    return true
  }

  #wake(task: RunningTask, resumption: Resumption): void {
    const parked = task.parked
    if (parked === null) return
    this.#unpark(task)
    parked.wake(resumption)
  }

  #unpark(task: RunningTask): void {
    if (task.parked !== null) clearTimeout(task.parked.timer)
    task.parked = null
  }

  #compactionFailed(task: RunningTask, code: string | null): void {
    if (task.relay !== null) return

    const severity = severityOf(code)
    if (severity === 'benign') return

    this.#log({
      event: 'compaction-failed',
      taskId: task.taskId,
      sessionId: task.sessionId,
      code,
      severity,
    })
    if (severity !== 'unreducible' || task.toldContextFull) return
    task.toldContextFull = true
    void this.#tell(task, { kind: 'context-full', ...addressOf(task) })
  }

  async #tell(task: RunningTask, instruction: OutboundInstruction): Promise<void> {
    try {
      await this.#deliverAfter(this.#openings.get(task.sessionId), instruction)
    } catch {}
  }

  async #runTurn(
    task: RunningTask,
    paidBy: CredentialKind,
    text: string,
    reporter: ProgressReporter,
  ): Promise<Turn> {
    if (task.stopped) throw new TaskStopped()

    const { sessionId, attempts } = task
    task.model = this.#models.inForce(sessionId)
    task.effort = this.#efforts.inForce(sessionId)
    reporter.update({ phase: 'working' })
    const onEvent = (id: string, event: ClaudeEvent): void => {
      if (id !== sessionId) return
      const init = readSystemInit(event)
      if (init !== null) attempts.reported(init.apiKeySource)
      const window = readSharedWindow(event)
      if (window !== null) attempts.saw(window)
      const compaction = readCompaction(event)
      if (compaction !== null) attempts.compacted(compaction)
      const failed = readCompactionFailure(event)
      if (failed !== null) this.#compactionFailed(task, failed.code)
      reporter.observe(event)
    }
    const onTurnStart = (id: string): void => {
      if (id !== sessionId) return
      attempts.sent()
      task.caveman = this.#pool.cavemanOn(sessionId)
      if (task.stopped) this.#pool.interrupt(sessionId)
    }
    this.#pool.on('event', onEvent)
    this.#pool.on('turn-start', onTurnStart)
    try {
      return await this.#pool.send(sessionId, text, paidBy)
    } finally {
      this.#pool.off('event', onEvent)
      this.#pool.off('turn-start', onTurnStart)
    }
  }
}

const EVERY_SESSION_RUNS_ON: Runtime = 'claude-code'

const ROMA_FAILED = 'roma could not run this Task.'

const ROMA_FAILED_COMMAND = 'roma could not carry out that command.'

function relayReply(compaction: Compaction | null, text: string): string {
  const { preTokens = null, postTokens = null } = compaction ?? {}
  if (preTokens !== null && postTokens !== null) {
    return `Compacted: ${readableTokens(preTokens)} → ${readableTokens(postTokens)} tokens.`
  }
  if (compaction !== null) return 'Compacted.'
  if (text !== '') return text
  return 'That command finished, and Claude Code said nothing about it.'
}

function readableTokens(tokens: number): string {
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const MENU_LIST = MENU_NAMES.join(', ')

const EFFORT_LIST = EFFORT_NAMES.join(', ')

const CAVEMAN_LIST = CAVEMAN_NAMES.join(', ')

function modelChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'model', options: MENU_NAMES, refused }
}

function effortChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'effort', options: EFFORT_NAMES, refused }
}

function cavemanChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'caveman', options: CAVEMAN_NAMES, refused }
}

function fromNextMessage(name: string, model: string): string {
  return (
    `This conversation runs on ${named(name, model)} from your next message. ` +
    `Anything already running finishes on the model it started under.`
  )
}

function atNextMessage(name: string, effort: string): string {
  return (
    `This conversation runs at ${name === effort ? name : `${name} (${effort})`} ` +
    `from your next message. Anything already running finishes at the effort it started at.`
  )
}

function atNextCaveman(name: string, caveman: string): string {
  return (
    `This conversation runs at caveman ${name === caveman ? name : `${name} (${caveman})`} ` +
    `from your next message. Anything already running finishes at the caveman it started at.`
  )
}

function takesNoEffort(model: string, chosen?: string): string {
  const setting = chosen === undefined ? 'Effort' : `The effort this conversation is at (${chosen})`
  return (
    `${setting} does not apply on ${model}, which takes none — ` +
    `it applies again on a model that does.`
  )
}

function unknownEffortReason(name: string): string {
  return (
    `roma does not offer an effort called “${name}”. ` +
    `Choose one of: ${EFFORT_LIST}. Nothing has changed.`
  )
}

function unknownCavemanReason(name: string): string {
  return (
    `roma does not offer a caveman called “${name}”. ` +
    `Choose one of: ${CAVEMAN_LIST}. Nothing has changed.`
  )
}

const CONFIG_SETS_NOTHING =
  'roma does not set Claude Code settings — every Session in this deployment shares one ' +
  'configuration, so a change here would be a change for everybody, permanently. ' +
  'What you can set for this conversation is “/model”, “/effort” and “/caveman”. ' +
  'Nothing has changed.'

function monthReport({ month, spend, unreadable }: AuditBreakdown): string {
  const named = monthNamed(month)
  if (unreadable > 0 || spend.some(({ mismatched }) => mismatched > 0)) {
    return (
      `roma cannot vouch for ${named} and is printing no figure for it. ` +
      'Some of the month’s audit records cannot be read back, or name a credential ' +
      'Claude Code contradicted — either way a total here would be describing ' +
      'something other than what it says.'
    )
  }
  if (spend.every(({ tasks, relays }) => tasks + relays === 0)) return `${named}: nothing has run.`
  return [`${named}.`, ...spend.map(spendLine)].join('\n')
}

function spendLine({ runtime, credential, costUsd, unpriced }: CredentialSpend): string {
  const figure = `${unpriced === 0 ? '' : 'at least '}$${money(costUsd)}`
  const named = RUNTIME_NAMES[runtime]
  switch (credential) {
    case 'shared-window':
      return `${named}’s subscription drew ${figure} worth of work. Nobody is billed for that.`
    case 'overflow':
      return `Metered billing charged ${figure} for Tasks on ${named}.`
  }
}

function money(usd: number): string {
  return usd.toFixed(2)
}

const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function monthNamed(month: string): string {
  const [year, ordinal] = month.split('-')
  const name = MONTH_NAMES[Number(ordinal) - 1]
  if (name === undefined || year === undefined) return month
  return `${name} ${year} (UTC)`
}

function named(name: string | null, model: string): string {
  return name === null ? model : `${name} (${model})`
}

function unknownModelReason(name: string): string {
  return (
    `roma does not offer a model called “${name}”. ` +
    `Choose one of: ${MENU_LIST}. Nothing has changed.`
  )
}

class TaskStopped extends Error {
  constructor() {
    super('Task stopped before its Turn began')
    this.name = 'TaskStopped'
  }
}

function addressOf({ taskId, conversationKey, caller, callerName }: TaskAddress): TaskAddress {
  return { taskId, conversationKey, caller, callerName }
}

function effortOn(model: string, effort: string): string {
  return takesEffort(model) === false ? EFFORT_NOT_APPLIED : effort
}

function outcomeOf(instruction: OutboundInstruction): TaskOutcome {
  if (instruction.kind === 'result') return 'result'
  if (instruction.kind === 'stopped') return 'stopped'
  return 'failure'
}

function wasStopped(error: unknown): boolean {
  if (error instanceof TaskStopped) return true
  return error instanceof TurnFailedError && wasInterrupted(error.turn)
}

function reasonFor(error: unknown): string {
  if (error instanceof RetryStormError) return retryStormReason(error)
  if (error instanceof EnclosureUnreadable) return `roma could not read ${error.message}`
  if (error instanceof ChosenModelNotOffered) return chosenModelGoneReason(error)
  if (error instanceof ChosenEffortNotOffered) return chosenEffortGoneReason(error)
  if (error instanceof ChosenCavemanNotOffered) return chosenCavemanGoneReason(error)
  if (error instanceof TranscriptNotFound) return transcriptLostReason()
  if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
  return ROMA_FAILED
}

function commandReasonFor(error: unknown): string {
  if (error instanceof ChosenModelNotOffered) return chosenModelGoneReason(error)
  if (error instanceof ChosenEffortNotOffered) return chosenEffortGoneReason(error)
  if (error instanceof ChosenCavemanNotOffered) return chosenCavemanGoneReason(error)
  return ROMA_FAILED_COMMAND
}

function chosenModelGoneReason({ model }: ChosenModelNotOffered): string {
  return (
    `This conversation is on ${model}, which roma no longer offers. ` +
    `Send “/model ${PINNED_NAME}” to put it back on the Pinned Model, ` +
    `keeping everything it has said.`
  )
}

function chosenEffortGoneReason({ effort }: ChosenEffortNotOffered): string {
  return (
    `This conversation runs at ${effort}, which roma no longer offers. ` +
    `Send “/effort ${PINNED_EFFORT_NAME}” to put it back at the Pinned Effort, ` +
    `keeping everything it has said.`
  )
}

function chosenCavemanGoneReason({ caveman }: ChosenCavemanNotOffered): string {
  return (
    `This conversation runs at caveman ${caveman}, which roma no longer offers. ` +
    `Send “/caveman ${PINNED_CAVEMAN_NAME}” to put it back at the Pinned Caveman, ` +
    `keeping everything it has said.`
  )
}

function transcriptLostReason(): string {
  return (
    'roma could not open this conversation’s session, and starting a fresh one ' +
    'did not work either. Send “/clear” to move the conversation to a new session.'
  )
}

function retryStormReason({ retries, lastRetry }: RetryStormError): string {
  const cause = [lastRetry.errorStatus, lastRetry.error].filter((part) => part !== null).join(' ')
  const gaveUp = `roma gave up after ${retries} API ${retries === 1 ? 'retry' : 'retries'}`
  return cause === '' ? `${gaveUp}.` : `${gaveUp} (${cause}).`
}
