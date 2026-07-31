import { describe, expect, it } from 'vitest'
import type { OutboundInstruction } from '../../channel-adapter.js'
import { sessionIdFor } from '../../session-id.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import type { ChatEvent } from './chat-events.js'
import { MAX_TEXT } from './render.js'
import { RecordingChatApi } from '../../../test/support/recording-chat-api.js'

// SEAM 3 — the Chat Adapter on its own. A Chat event goes in and an ingress
// message comes out; an outbound instruction goes in and a Chat API call comes
// out, recorded rather than sent.
//
// The events below are **written from Google's reference documentation, not
// captured**. Nothing in this repo can capture one without a Workspace, and it
// is worth saying plainly given that ADR-0003 exists because a decision written
// from documentation failed silently once already — as ADR-0004's own thread
// format did, which is why the names below are the reference's and not the ADR's:
// a thread is `spaces/{space}/threads/{thread}`, and the `messages/` form the ADR
// quoted is a *message's* name.
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
//
// What stays unverified is the event payload itself: which fields Chat puts in
// one is not something the reference pins down, so the shape here is a
// reasonable reading and nothing more. Everything the Adapter reads is chosen to
// survive being wrong about it — see the DM tests below.
//
// The scope is deliberately narrow — ADR-0004's Chat facts and nothing else. The
// Adapter contract is provisional, and pinning its shape here would make the
// revision a second Channel is expected to force more expensive rather than
// safer.

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const DM = 'spaces/DM-BBBB'
const SENDER = 'users/17'
/**
 * How the mention reads in front of every message roma posts about a Task.
 *
 * Written out here rather than folded into a helper that strips it, so that the
 * tests below say what Chat is actually asked to post. What it is *for* is
 * asserted on its own, under "addressing the person who asked".
 */
const TO = `<${SENDER}> `

/** A message in a space, addressed to roma with an @-mention. */
function inSpace(text = 'summarise this', overrides: Record<string, unknown> = {}): ChatEvent {
  return {
    type: 'MESSAGE',
    space: { name: SPACE, type: 'ROOM', spaceType: 'SPACE' },
    message: {
      name: `${SPACE}/messages/msg-1`,
      sender: { name: SENDER, displayName: 'Ada', type: 'HUMAN' },
      text: `@roma ${text}`,
      argumentText: ` ${text}`,
      thread: { name: THREAD },
      ...overrides,
    },
  }
}

/**
 * A message in a DM.
 *
 * It still carries a thread of its own — Chat puts one on every message, and
 * that one names this message alone. Reading it here would make every message in
 * the DM its own Conversation, which is the trap ADR-0004's fallback exists to
 * avoid.
 */
function inDm(text = 'hello', overrides: Record<string, unknown> = {}): ChatEvent {
  return {
    type: 'MESSAGE',
    space: { name: DM, type: 'DM', spaceType: 'DIRECT_MESSAGE' },
    message: {
      name: `${DM}/messages/msg-9`,
      sender: { name: SENDER, displayName: 'Ada', type: 'HUMAN' },
      text,
      thread: { name: `${DM}/threads/msg-9` },
      ...overrides,
    },
  }
}

function newAdapter() {
  const api = new RecordingChatApi()
  return { api, adapter: new GoogleChatAdapter({ api }) }
}

/**
 * What an instruction says, with the address taken off.
 *
 * Distributed over the union rather than `Partial<…>`, so that a test asking for
 * a `result` with no text is a type error here rather than a passing test of
 * something the Core cannot send.
 */
type Outcome<T> = T extends unknown
  ? Omit<T, 'taskId' | 'conversationKey' | 'caller' | 'callerName'>
  : never

/** An instruction addressed to one Conversation, as the Core would send it. */
function to(
  conversationKey: string,
  outcome: Outcome<OutboundInstruction>,
  taskId = 'task-1',
  caller = SENDER,
  callerName: string | null = 'Ada',
): OutboundInstruction {
  return { ...outcome, taskId, conversationKey, caller, callerName }
}

describe('which Conversation a Chat message belongs to', () => {
  it('is the thread, in a space', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.conversationKey).toBe(THREAD)
  })

  // The DM fallback ADR-0004 records: no threads at all, so one long-lived
  // Conversation per person. The message's own thread must not be read here —
  // it names that single message, so every message would be its own Conversation
  // and nothing would ever remember anything.
  it('is the space, in a DM, for every message in it', () => {
    const { adapter } = newAdapter()

    const first = adapter.toIngress(inDm('hello'))
    const second = adapter.toIngress(inDm('and another thing'))

    expect(first?.conversationKey).toBe(DM)
    expect(second?.conversationKey).toBe(DM)
  })

  // `spaceThreadingState` is the field that looks like the answer and is not:
  // Google documents it output-only on the Space resource, so an event need not
  // carry it, and reading the threading state off the space would have sent
  // every message in a space down the DM path — one Session for the whole space,
  // with everybody's context in everybody else's replies. A space is recognised
  // by being a space.
  it('is the thread even when the event says nothing about threading state', () => {
    const { adapter } = newAdapter()
    const event = {
      type: 'MESSAGE',
      space: { name: SPACE, spaceType: 'SPACE' },
      message: {
        sender: { name: SENDER, type: 'HUMAN' },
        argumentText: 'summarise this',
        thread: { name: THREAD },
      },
    }

    expect(adapter.toIngress(event)?.conversationKey).toBe(THREAD)
  })

  // The deprecated field is what older event payloads carry, and being wrong
  // about which one is present costs a merged Conversation either way.
  it('recognises a DM by either the current field or the deprecated one', () => {
    const { adapter } = newAdapter()
    const bySpaceType = inDm('hello', {})
    const byType = {
      type: 'MESSAGE',
      space: { name: DM, type: 'DM' },
      message: { sender: { name: SENDER, type: 'HUMAN' }, text: 'hello' },
    }

    expect(adapter.toIngress(bySpaceType)?.conversationKey).toBe(DM)
    expect(adapter.toIngress(byType)?.conversationKey).toBe(DM)
  })

  it('reaches the same Session every time, for the same Conversation', () => {
    const { adapter } = newAdapter()

    const first = adapter.toIngress(inSpace('one'))
    const second = adapter.toIngress(inSpace('two'))

    expect(sessionIdFor(first?.conversationKey ?? '')).toBe(
      sessionIdFor(second?.conversationKey ?? ''),
    )
    expect(sessionIdFor(THREAD)).not.toBe(sessionIdFor(DM))
  })

  // The audit record is the only place usage can ever be attributed to a person,
  // because the provider offers no attribution of its own (ADR-0002). The
  // resource name rather than the display name: display names change, and two
  // people can share one.
  it('passes the sender through as the caller', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.caller).toBe(SENDER)
  })

  // Both halves, because they are wanted for different things: the resource name
  // is what a reply is addressed with and what tells two people of the same name
  // apart, and the display name is the half a person reads (ADR-0009).
  it('passes the sender’s display name through beside it', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.callerName).toBe('Ada')
  })

  // Not on every delivery, and Chat has `isAnonymous` for people who have no
  // name to give. Null rather than absent, so that the Core is told there is no
  // name rather than left to notice.
  it('says so when Chat gave no display name', () => {
    const { adapter } = newAdapter()

    const nameless = inSpace('hello', { sender: { name: SENDER, type: 'HUMAN' } })

    expect(adapter.toIngress(nameless)?.callerName).toBeNull()
  })

  // What Claude Code is asked is what the person asked, not how Chat addressed
  // roma. `argumentText` is Chat's own copy with the mention removed.
  it('hands over what was said, without the @-mention', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace('summarise this'))?.text).toBe('summarise this')
  })

  it('declares message mutation and a stable Conversation Key', () => {
    const { adapter } = newAdapter()

    expect(adapter.capabilities).toEqual({ messageMutation: true, stableConversationKey: true })
  })
})

describe('what roma does not answer', () => {
  it('ignores an event that is not a message', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress({ type: 'ADDED_TO_SPACE', space: { name: SPACE } })).toBeNull()
    expect(adapter.toIngress({ type: 'CARD_CLICKED' })).toBeNull()
  })

  // Two apps in one space answering each other is a loop that runs until
  // somebody notices the quota.
  it('ignores anything another app said', () => {
    const { adapter } = newAdapter()

    const fromApp = inSpace('hello', {
      sender: { name: 'users/99', displayName: 'some bot', type: 'BOT' },
    })

    expect(adapter.toIngress(fromApp)).toBeNull()
  })

  it('ignores an @-mention with nothing after it', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace('', { argumentText: '   ' }))).toBeNull()
  })
})

describe('replying in Chat', () => {
  // An app cannot create a thread of its own, so replying into the caller's
  // thread with this option is the only way a thread ever comes to exist. It is
  // also what makes the Conversation Key stable from the first reply onwards.
  it('replies into the thread, with the option that establishes one', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted).toEqual({
      space: SPACE,
      thread: THREAD,
      text: `${TO}the answer`,
      replyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    })
  })

  // Nothing to reply into: a DM has no threads, and asking Chat to reply into
  // one there is asking for a thread that cannot exist.
  it('posts plainly in a DM', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted).toEqual({ space: DM, thread: null, text: `${TO}the answer` })
  })

  // No map, no lookup, nothing to have gone stale: a Conversation Key is a Chat
  // resource name, so where to reply is read out of the key itself. A roma that
  // restarted mid-Conversation answers exactly the same way.
  it('needs nothing it was told earlier to know where to reply', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted.space).toBe(SPACE)
  })

  // Including the one ADR-0004 said a thread was. A key in the wrong shape is
  // refused rather than posted somewhere unintended — `spaces/X/messages/Y`
  // names a message, and Chat would not read it as a thread.
  it('refuses a Conversation Key that is not a Chat one', async () => {
    const { adapter } = newAdapter()

    for (const key of ['not-a-chat-key', `${SPACE}/messages/msg-1`, 'spaces/', `${SPACE}/threads/`]) {
      await expect(adapter.deliver(to(key, { kind: 'stopped' }))).rejects.toThrow(
        /conversation key/i,
      )
    }
  })

  // The Core cannot absorb this one: an instruction that reached nobody looks,
  // from the Conversation, exactly like a message that was never received.
  it('does not swallow a Chat API failure', async () => {
    const { adapter, api } = newAdapter()
    api.failNextPost(new Error('quota exceeded'))

    await expect(adapter.deliver(to(THREAD, { kind: 'result', text: 'hi' }))).rejects.toThrow(
      'quota exceeded',
    )
  })
})

describe('the acknowledgement', () => {
  // One message, edited. A renderer that posted per update would make a Task
  // that ran for five minutes into sixty messages burying the Conversation it is
  // reporting on.
  it('is edited in place rather than posted again', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'writing', characters: 14 } }),
    )

    expect(api.calls).toEqual(['post', 'edit', 'edit'])
    expect(api.messages).toHaveLength(1)
    expect(api.messages[0]?.text).toBe(`${TO}Writing… (14 chars)`)
  })

  // Two messages in one Conversation can be in flight at once, each with an
  // acknowledgement of its own — which is why an acknowledgement is named by a
  // Task id and not by the Conversation it is in.
  it('is one per Task, not one per Conversation', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'queued', position: 2 } }, 'task-2'),
    )

    expect(api.calls).toEqual(['post', 'post'])
    expect(api.texts).toEqual([`${TO}Working…`, `${TO}Queued — 2 waiting.`])
  })

  // The rule ADR-0003 makes unconditional. The result is what people search for,
  // quote and reply to months later; buried in a message that was mutating for
  // the last five minutes it is hard to find.
  it('is never what the result is written into', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.calls).toEqual(['post', 'post'])
    expect(api.texts).toEqual([`${TO}Working…`, `${TO}the answer`])
  })

  // A post that failed left no message to edit. Remembered anyway, every later
  // update for that Task would try to edit a name that never existed and fail
  // with an error from minutes ago — so one Chat hiccup would silence the
  // acknowledgement for the rest of a Task that is running perfectly well.
  it('tries again after a post that failed, rather than editing nothing', async () => {
    const { adapter, api } = newAdapter()
    api.failNextPost(new Error('quota exceeded'))

    await expect(
      adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } })),
    ).rejects.toThrow('quota exceeded')
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )

    expect(api.calls).toEqual(['post', 'post'])
    expect(api.texts).toEqual([`${TO}Running awk…`])
  })

  // The one phase whose length roma does not control: a tool is named by Claude
  // Code's own description of it, which is the command itself. It is cut to
  // something that can be read at a glance, well before Chat's limit is in
  // question — a message edited every few seconds is not where a thousand
  // characters of shell belongs.
  //
  // Driven through the Adapter as its own first instruction on purpose. The
  // Core sends `working` before it reads a single stream event, so a `tool`
  // phase never in fact arrives first; the Adapter is a separate component and
  // does not get to assume that.
  it('quotes only as much of a tool command as can be read at a glance', async () => {
    const { adapter, api } = newAdapter()
    const tool = `awk ${'-v x=1 '.repeat(1000)}`

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool } }))

    const text = api.texts[0] ?? ''
    expect(api.calls).toEqual(['post'])
    // The mention, `Running `, 120 characters of command, and the ellipsis.
    expect(text.length).toBe(TO.length + 'Running '.length + 120 + '…'.length)
    // The beginning is what names the command, so it is the end that goes — the
    // opposite end from the partial answer this replaces, where the tail moving
    // was the whole point.
    expect(text.startsWith(`${TO}Running awk -v x=1 `)).toBe(true)
    expect(text).not.toContain(tool)
  })

  // A second Task in the same Conversation must not inherit the first one's
  // message, and a Task id is a uuid so this cannot happen in production — it is
  // the bookkeeping being wrong that it would come from.
  it('is finished with once the Task ends', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'stopped' }))
    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))

    expect(api.calls).toEqual(['post', 'post', 'post'])
  })
})

describe('what a Conversation is told', () => {
  it('says what happened, in words a person can act on', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'stopped' }))
    await adapter.deliver(
      to(THREAD, { kind: 'command-outcome', command: 'stop', carriedOut: false }),
    )
    await adapter.deliver(
      to(THREAD, { kind: 'command-outcome', command: 'clear', carriedOut: true }),
    )
    await adapter.deliver(to(THREAD, { kind: 'failure', reason: 'roma could not run this Task.' }))

    expect(api.texts).toEqual([
      `${TO}Stopped.`,
      `${TO}Nothing to stop.`,
      expect.stringContaining('fresh session'),
      `${TO}roma could not run this Task.`,
    ])
  })

  // 17706 characters is what the recorded generating Turn produced, and Chat
  // rejects anything over 4096. Without this the longest answers — the ones
  // worth having — would be the ones that never arrive.
  it('breaks an answer Chat would refuse into messages it will take', async () => {
    const { adapter, api } = newAdapter()
    const long = Array.from({ length: 60 }, (_, n) => `Paragraph ${n}. ${'word '.repeat(60)}`).join(
      '\n\n',
    )

    await adapter.deliver(to(THREAD, { kind: 'result', text: long }))

    expect(api.messages.length).toBeGreaterThan(1)
    for (const message of api.messages) expect(message.text.length).toBeLessThanOrEqual(MAX_TEXT)
    // Nothing dropped and nothing duplicated: the words arrive in order, whole,
    // under the mention the first message carries. The mention is counted
    // against the limit rather than added after the split, which is what keeps
    // that first message inside what Chat will take.
    expect(api.texts.join('\n\n').replace(/\s+/g, ' ')).toBe(`${TO}${long}`.replace(/\s+/g, ' '))
  })

  // A failed Turn's reason is the Turn's own text, which has no more of a length
  // limit than an answer does. Posted whole, Chat refuses it and the Conversation
  // is told nothing at all about a Task that is already dead — the one failure
  // roma exists to prevent, arriving through the message about a failure.
  it('breaks a failure Chat would refuse, the same as an answer', async () => {
    const { adapter, api } = newAdapter()
    const reason = `Failed after ${'a very long explanation '.repeat(400)}`

    await adapter.deliver(to(THREAD, { kind: 'failure', reason }))

    expect(api.messages.length).toBeGreaterThan(1)
    for (const message of api.messages) expect(message.text.length).toBeLessThanOrEqual(MAX_TEXT)
  })

  it('says something even when a Turn produced no text at all', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: '' }))

    expect(api.messages).toHaveLength(1)
    expect(api.texts[0]).not.toBe('')
  })
})

describe('a Task the Shared Window has blocked', () => {
  // Plainly that quota is spent, with the reset time the event gave — and that
  // the Task is kept, because told only that quota is spent people send the
  // message again, which is the behaviour the acknowledgement exists to prevent.
  it('says quota is spent, when it comes back, and that the Task is kept', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }))

    expect(api.texts).toEqual([
      `${TO}The shared Claude quota is spent. It comes back at 2026-07-28 20:40 UTC — I have kept your task and will run it then.`,
    ])
  })

  // The offer is a button on that message, which is ADR-0002's "offered at the
  // moment of blocking" made literal — not a setting somebody turns on in
  // advance and then forgets is on.
  it('carries the offer as a button naming the Task it is about', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(
      to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-77'),
    )

    expect(api.messages[0]?.posted.action).toEqual({
      label: 'Run it on metered billing',
      action: 'takeOverflow',
      parameters: { taskId: 'task-77' },
    })
  })

  // A button that cannot work is worse than no button: somebody waiting on a
  // blocked Task presses it and then keeps waiting.
  it('posts no button where the Core did not offer one', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }))

    expect(api.messages[0]?.posted.action).toBeUndefined()
  })

  // The round trip: what went out as a parameter on the button comes back as one
  // on the click, so roma remembers nothing between offering and its being taken.
  it('reads a click on it as the Task it was offered for', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toOverflowTaken({
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId: 'task-77' } },
      }),
    ).toBe('task-77')
  })

  // Chat has two parameter shapes and which one arrives depends on how the event
  // was delivered. Reading one and not the other would make the button do
  // nothing for half of them, silently.
  it('reads the older parameter shape too', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toOverflowTaken({
        type: 'CARD_CLICKED',
        action: {
          actionMethodName: 'takeOverflow',
          parameters: [{ key: 'taskId', value: 'task-77' }],
        },
      }),
    ).toBe('task-77')
  })

  it('reads an ordinary message as no such click', () => {
    const { adapter } = newAdapter()

    expect(adapter.toOverflowTaken(inSpace())).toBeNull()
  })

  // A click is not a message. Answering one as though it were would spend a Turn
  // asking Claude Code what to make of a button press.
  it('reads a click as no ingress message either', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toIngress({
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId: 'task-77' } },
      }),
    ).toBeNull()
  })

  it('says what the cap was when Overflow is refused, and that the Task waits on', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'overflow-refused', capUsd: 20, spentUsd: 21.5 }))

    expect(api.texts).toEqual([
      `${TO}Overflow is capped at $20.00 a month and this month has spent $21.50, so it is off ` +
        'until the month turns. Your task is still waiting for the shared quota to reset.',
    ])
  })
})

describe('showing what an Overflow Task spent', () => {
  // ADR-0002 requires the spend in the reply, and its own message rather than
  // appended to the answer: the answer is what gets quoted months later, and a
  // price tag inside it would be quoted with it.
  it('posts the answer and then what it cost', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'done', overflowCostUsd: 0.42 }))

    expect(api.texts).toEqual([`${TO}done`, 'Ran on metered billing: $0.42.'])
  })

  it('says nothing about money for an ordinary Task', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'done' }))

    expect(api.texts).toEqual([`${TO}done`])
  })

  // "$0.00" would report money as free, which is the one claim the Audit Record
  // refuses to make about a Turn nothing priced.
  it('does not price a Turn nothing priced', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'done', overflowCostUsd: null }))

    expect(api.texts).toEqual([
      `${TO}done`,
      'Ran on metered billing. What it cost was never reported.',
    ])
  })
})

/**
 * ADR-0009. A thread is many people sharing one Conversation, so an unaddressed
 * reply is one the thread has to work out the owner of by reading it.
 */
describe('addressing the person who asked', () => {
  // `<users/{user}>` is Google's documented syntax, and a caller is already a
  // Chat user resource name — so the mention is the identity roma was given, in
  // angle brackets, with nothing looked up.
  // https://developers.google.com/workspace/chat/identify-reference-users
  it('mentions the Caller on the acknowledgement and on the result', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    for (const text of api.texts) expect(text.startsWith(`<${SENDER}> `)).toBe(true)
  })

  // Two acknowledgements can sit in one thread mutating at once — one running,
  // one queued behind it — and this is what tells them apart while they do.
  it('addresses each of a thread’s two Tasks to its own Caller', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'queued', position: 2 } }, 'task-2', 'users/99', 'Bob'),
    )

    expect(api.texts).toEqual([`<${SENDER}> Working…`, '<users/99> Queued — 2 waiting.'])
  })

  // One notification per Task, not one per 4096 characters of the answer. The
  // price of an Overflow Turn is a separate message for the same reason.
  it('mentions on the first message of an answer and no other', async () => {
    const { adapter, api } = newAdapter()
    const long = 'word '.repeat(2000)

    await adapter.deliver(to(THREAD, { kind: 'result', text: long, overflowCostUsd: 0.42 }))

    expect(api.texts.length).toBeGreaterThan(2)
    expect(api.texts.filter((text) => text.includes(`<${SENDER}>`))).toHaveLength(1)
  })

  // A DM has one other person in it and the Adapter could tell from the
  // Conversation Key. It deliberately does not: a rule with an exception in it
  // is a rule somebody has to remember, and ADR-0009 accepts the redundancy on
  // the same terms the marker does.
  it('mentions the Caller in a DM too, rather than carrying an exception', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(api.texts).toEqual([`<${SENDER}> the answer`])
  })
})
