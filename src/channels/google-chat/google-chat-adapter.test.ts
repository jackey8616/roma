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
type Outcome<T> = T extends unknown ? Omit<T, 'taskId' | 'conversationKey'> : never

/** An instruction addressed to one Conversation, as the Core would send it. */
function to(
  conversationKey: string,
  outcome: Outcome<OutboundInstruction>,
  taskId = 'task-1',
): OutboundInstruction {
  return { ...outcome, taskId, conversationKey }
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
      text: 'the answer',
      replyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    })
  })

  // Nothing to reply into: a DM has no threads, and asking Chat to reply into
  // one there is asking for a thread that cannot exist.
  it('posts plainly in a DM', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted).toEqual({ space: DM, thread: null, text: 'the answer' })
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
      to(THREAD, { kind: 'progress', progress: { phase: 'writing', text: 'half an answer' } }),
    )

    expect(api.calls).toEqual(['post', 'edit', 'edit'])
    expect(api.messages).toHaveLength(1)
    expect(api.messages[0]?.text).toBe('half an answer')
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
    expect(api.texts).toEqual(['Working…', 'Queued — 2 waiting.'])
  })

  // The rule ADR-0003 makes unconditional. The result is what people search for,
  // quote and reply to months later; buried in a message that was mutating for
  // the last five minutes it is hard to find.
  it('is never what the result is written into', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.calls).toEqual(['post', 'post'])
    expect(api.texts).toEqual(['Working…', 'the answer'])
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
    expect(api.texts).toEqual(['Running awk…'])
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
    await adapter.deliver(to(THREAD, { kind: 'command-outcome', command: 'new', carriedOut: true }))
    await adapter.deliver(to(THREAD, { kind: 'failure', reason: 'roma could not run this Task.' }))

    expect(api.texts).toEqual([
      'Stopped.',
      'Nothing to stop.',
      expect.stringContaining('fresh session'),
      'roma could not run this Task.',
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
    // Nothing dropped and nothing duplicated: the words arrive in order, whole.
    expect(api.texts.join('\n\n').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '))
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
