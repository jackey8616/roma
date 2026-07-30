/**
 * PROTOTYPE — throwaway. Not part of roma. Delete me once the question is answered.
 *
 * ## The question
 *
 * roma posts an Acknowledgement and edits it while a Task runs, then posts the
 * Result as a separate message (ADR-0003, unconditional). Because `progressText`
 * renders the `writing` phase as the answer prose itself, the two messages hold
 * nearly the same text — which is what "roma sent it twice" actually is.
 *
 * One candidate fix is "post the Result, then delete the Acknowledgement". Two
 * things about it cannot be answered from the API reference, and this exists to
 * answer them by hand against a real Workspace:
 *
 *   1. **Does Chat leave a tombstone?** If deleting an app's own message leaves a
 *      visible "message deleted" placeholder in the thread, the fix trades a
 *      duplicate for a gravestone — arguably worse.
 *   2. **What do the notifications do?** The bug was reported from a phone. A
 *      delete cannot retract a push notification that already fired, so the
 *      expectation is *two buzzes either way*. Worth seeing rather than assuming,
 *      because it is the half of the complaint the delete fix does not touch.
 *
 * Everything else about the fix is already settled from the docs:
 * `spaces.messages.delete` under app authentication may delete messages the
 * calling Chat app created, under the `chat.bot` scope roma already holds.
 *
 * ## Running it
 *
 *   ROMA_PROTOTYPE_SPACE=spaces/AAAA... \
 *   ROMA_PROTOTYPE_THREAD=spaces/AAAA.../threads/BBBB... \
 *   npm run prototype:ack-delete
 *
 * `ROMA_PROTOTYPE_THREAD` is optional — leave it out to post at space level.
 * Credentials resolve the way roma's do: Application Default Credentials, so
 * `GOOGLE_APPLICATION_CREDENTIALS` pointing at the app's service account key.
 *
 * ## What to do with it
 *
 * Lock your phone first, then press `1`, `2` a few times, `3`, `4` — pausing at
 * each to look at both the phone and the desktop client. The interesting moments
 * are step 3 (how many notifications by now?) and step 4 (what is left behind?).
 */

import { GoogleAuth } from 'google-auth-library'
import { CHAT_API, CHAT_SCOPE } from './http-chat-api.js'

/** The one call `HttpChatApi` does not have, which is the whole point of this. */
interface Probe {
  post(text: string): Promise<string>
  edit(name: string, text: string): Promise<void>
  remove(name: string): Promise<void>
}

/**
 * The Chat calls this prototype makes, against a real Workspace.
 *
 * Kept apart from the terminal shell so the `remove` call — the only genuinely
 * new thing here — can be lifted into `HttpChatApi` verbatim if the answer comes
 * back "yes, delete it".
 */
function probeFor(space: string, thread: string | null): Probe {
  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] })
  const client = auth.getClient()

  return {
    async post(text) {
      const query = thread === null ? '' : '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
      const response = await (
        await client
      ).request<{ name?: string }>({
        url: `${CHAT_API}/${space}/messages${query}`,
        method: 'POST',
        data: { text, ...(thread === null ? {} : { thread: { name: thread } }) },
      })
      const name = response.data.name
      if (typeof name !== 'string' || name === '') throw new Error('Chat returned no resource name')
      return name
    },
    async edit(name, text) {
      await (
        await client
      ).request({ url: `${CHAT_API}/${name}?updateMask=text`, method: 'PATCH', data: { text } })
    },
    async remove(name) {
      await (await client).request({ url: `${CHAT_API}/${name}`, method: 'DELETE' })
    },
  }
}

/**
 * A stand-in for an answer being written, in the chunks the throttle would show.
 *
 * Shaped like the answer in the bug report — a preamble and a list — because the
 * duplicate is at its most obvious when the Acknowledgement freezes mid-list and
 * the Result then repeats the list whole.
 */
const CHUNKS = [
  '是的，我看得到 example-org/example-repo 這個 repo 的 PR。目前最新幾筆是：\n',
  '\n• **#229** (MERGED) archive baseline change',
  '\n• **#228** (DRAFT) 提議新增單機整合映像的使用邊界',
  '\n• **#227** (DRAFT) shadow-loan-workflow 三事件工作流程重設計提案',
  '\n• **#226** (MERGED) Broker Portal 現況寫成四份 baseline 規格',
  '\n• **#224** (DRAFT) Broker Portal 輸出恢復與安全重試契約',
  '\n\n如果你是問特定一個 PR，告訴我更多細節，我可以幫你查看詳情。',
]

/** Everything that has happened, as the frame renders it. */
interface State {
  /** The Acknowledgement's resource name, once posted. */
  ack: string | null
  /** How much of the answer the Acknowledgement is showing. */
  written: number
  /** The Result's resource name, once posted. */
  result: string | null
  ackDeleted: boolean
  /** The last thing that happened, or the last thing that went wrong. */
  note: string
}

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

function answerSoFar(written: number): string {
  return CHUNKS.slice(0, written).join('')
}

function render(state: State, space: string, thread: string | null): void {
  console.clear()
  console.log(`${BOLD}PROTOTYPE — Acknowledgement vs Result in real Google Chat${OFF}`)
  console.log(`${DIM}${space}${thread === null ? ' (no thread)' : `\n${thread}`}${OFF}\n`)

  console.log(`${BOLD}Acknowledgement${OFF}  ${state.ack ?? `${DIM}not posted${OFF}`}`)
  console.log(`  showing        ${state.written === 0 ? '"Working…"' : `${state.written}/${CHUNKS.length} chunks, ${answerSoFar(state.written).length} chars`}`)
  console.log(`  deleted        ${state.ackDeleted ? 'yes' : 'no'}`)
  console.log(`${BOLD}Result${OFF}           ${state.result ?? `${DIM}not posted${OFF}`}\n`)

  console.log(`${DIM}${state.note}${OFF}\n`)

  console.log(
    `${BOLD}[1]${OFF} post ack ("Working…")   ${BOLD}[2]${OFF} edit ack (+1 chunk)   ${BOLD}[3]${OFF} post result`,
  )
  console.log(
    `${BOLD}[4]${OFF} delete ack              ${BOLD}[5]${OFF} post+delete immediately   ${BOLD}[r]${OFF} reset   ${BOLD}[q]${OFF} quit`,
  )
}

async function main(): Promise<void> {
  const space = process.env.ROMA_PROTOTYPE_SPACE
  const thread = process.env.ROMA_PROTOTYPE_THREAD ?? null
  if (space === undefined || space === '') {
    console.error('ROMA_PROTOTYPE_SPACE is required, e.g. spaces/AAAAxxxxxxx')
    process.exit(1)
  }

  const probe = probeFor(space, thread)
  const state: State = { ack: null, written: 0, result: null, ackDeleted: false, note: 'Ready.' }
  let busy = false

  const act = async (key: string): Promise<void> => {
    switch (key) {
      case '1':
        state.ack = await probe.post('Working…')
        state.written = 0
        state.ackDeleted = false
        state.note = 'Posted the acknowledgement. Did the phone buzz?'
        return
      case '2': {
        if (state.ack === null) return void (state.note = 'Post the acknowledgement first (1).')
        if (state.written >= CHUNKS.length) return void (state.note = 'Nothing left to write.')
        state.written += 1
        await probe.edit(state.ack, answerSoFar(state.written))
        state.note = 'Edited in place. An edit should not notify — check.'
        return
      }
      case '3':
        state.result = await probe.post(answerSoFar(CHUNKS.length))
        state.note = 'Result posted as its own message. THIS is the duplicate as it stands today.'
        return
      case '4': {
        if (state.ack === null) return void (state.note = 'Nothing to delete.')
        await probe.remove(state.ack)
        state.ackDeleted = true
        state.note = 'Deleted. ← Is there a tombstone in the thread, or is it gone cleanly?'
        return
      }
      case '5': {
        const name = await probe.post('Working…')
        await probe.remove(name)
        state.note = 'Posted and deleted back-to-back. Did the phone still buzz for it?'
        return
      }
      case 'r':
        state.ack = null
        state.written = 0
        state.result = null
        state.ackDeleted = false
        state.note = 'Local state reset — nothing in Chat was touched.'
        return
    }
  }

  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  render(state, space, thread)

  process.stdin.on('data', (chunk: string) => {
    const key = chunk.toString()
    if (key === 'q' || key === '') {
      process.stdin.setRawMode?.(false)
      process.exit(0)
    }
    if (busy) return
    busy = true
    state.note = 'Calling Chat…'
    render(state, space, thread)
    act(key)
      .catch((error: unknown) => {
        state.note = `Failed: ${error instanceof Error ? error.message : String(error)}`
      })
      .finally(() => {
        busy = false
        render(state, space, thread)
      })
  })
}

void main()
