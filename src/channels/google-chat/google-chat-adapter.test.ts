import { describe, expect, it } from 'vitest'
import type { OutboundInstruction } from '../../channel-adapter.js'
import { CAVEMAN_NAMES } from '../../caveman.js'
import { readCommand } from '../../commands.js'
import { EFFORT_NAMES } from '../../effort-menu.js'
import { MENU_NAMES } from '../../model-menu.js'
import { sessionIdFor } from '../../session-id.js'
import { GoogleChatAdapter } from './google-chat-adapter.js'
import type { ChatEvent, ChatEventLogRecord } from './chat-events.js'
import { MAX_TEXT } from './render.js'
import { RecordingChatApi } from '../../../test/support/recording-chat-api.js'

const SPACE = 'spaces/AAAA'
const THREAD = `${SPACE}/threads/thread-1`
const DM = 'spaces/DM-BBBB'
const SENDER = 'users/17'
const TO = `<${SENDER}> `

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
  const logged: ChatEventLogRecord[] = []
  return {
    api,
    logged,
    adapter: new GoogleChatAdapter({ api, log: (entry) => logged.push(entry) }),
  }
}

const UPLOADED = {
  name: `${SPACE}/messages/msg-1/attachments/att-1`,
  contentName: 'screenshot.png',
  contentType: 'image/png',
  source: 'UPLOADED_CONTENT',
  attachmentDataRef: { resourceName: 'attachments/att-1' },
}

const IN_DRIVE = {
  name: `${SPACE}/messages/msg-1/attachments/att-2`,
  contentName: 'design.fig',
  source: 'DRIVE_FILE',
  driveDataRef: { driveFileId: 'drive-file-1' },
}

type Outcome<T> = T extends unknown
  ? Omit<T, 'taskId' | 'conversationKey' | 'caller' | 'callerName'>
  : never

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
  const KEY_WHY =
    'The Conversation Key is the space in a DM and the thread in a space, read off ' +
    '`spaceType` or the deprecated `type` and never off `spaceThreadingState` (ADR-0004: one ' +
    'long-lived Session per person in a DM, one per thread in a space). Chat puts a thread on ' +
    'every DM message, so keying a DM on it makes every message its own Conversation; ' +
    '`spaceThreadingState` is output-only, so keying on it sends every space message down the ' +
    'DM path; and falling back to the space for a threaded message with no thread puts one ' +
    "Conversation's context into every other in that space. Unanswered is at least visible. " +
    'A press and a message are keyed by one reading, so the two cannot drift (#26, #140).'

  it('is the thread, in a space', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.conversationKey).toBe(THREAD)
  })

  it('is the space, in a DM, for every message in it [fence:gchat-conversation-key-from-the-space]', () => {
    const { adapter } = newAdapter()

    const first = adapter.toIngress(inDm('hello'))
    const second = adapter.toIngress(inDm('and another thing'))

    expect(first?.conversationKey, KEY_WHY).toBe(DM)
    expect(second?.conversationKey, KEY_WHY).toBe(DM)
  })

  it('is no Conversation at all, for a message in a space that names no thread [fence:gchat-conversation-key-from-the-space]', () => {
    const { adapter } = newAdapter()
    const { thread: _thread, ...threadless } = inSpace().message as Record<string, unknown>

    expect(adapter.toIngress({ ...inSpace(), message: threadless }), KEY_WHY).toBeNull()
  })

  it('is the thread even when the event says nothing about threading state [fence:gchat-conversation-key-from-the-space]', () => {
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

    expect(adapter.toIngress(event)?.conversationKey, KEY_WHY).toBe(THREAD)
  })

  it('recognises a DM by either the current field or the deprecated one [fence:gchat-conversation-key-from-the-space]', () => {
    const { adapter } = newAdapter()
    const bySpaceType = inDm('hello', {})
    const byType = {
      type: 'MESSAGE',
      space: { name: DM, type: 'DM' },
      message: { sender: { name: SENDER, type: 'HUMAN' }, text: 'hello' },
    }

    expect(adapter.toIngress(bySpaceType)?.conversationKey, KEY_WHY).toBe(DM)
    expect(adapter.toIngress(byType)?.conversationKey, KEY_WHY).toBe(DM)
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

  it('passes the sender through as the caller', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.caller).toBe(SENDER)
  })

  it('passes the sender’s display name through beside it', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace())?.callerName).toBe('Ada')
  })

  it('says so when Chat gave no display name', () => {
    const { adapter } = newAdapter()

    const nameless = inSpace('hello', { sender: { name: SENDER, type: 'HUMAN' } })

    expect(adapter.toIngress(nameless)?.callerName).toBeNull()
  })

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
  const APP_WHY =
    'roma must answer nothing an app said: Chat marks app messages `type: "BOT"`, and ' +
    'answering them is how two apps in one space talk to each other until somebody notices ' +
    'the quota (ADR-0002: the Shared Window is one subscription everybody shares) (#26).'
  const CONTENT_WHY =
    'roma answers a message with anything in it, and only that: a bare @-mention would spend a ' +
    'Turn asking Claude Code what to make of nothing, while a pasted screenshot (ADR-0011) or ' +
    'a quotation (ADR-0021) with no words is a request. Test for empty content, not empty ' +
    'text (#26, #92).'

  it('ignores an event that is not a message', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress({ type: 'ADDED_TO_SPACE', space: { name: SPACE } })).toBeNull()
    expect(adapter.toIngress({ type: 'CARD_CLICKED' })).toBeNull()
  })

  it('ignores anything another app said [fence:gchat-never-answers-an-app]', () => {
    const { adapter } = newAdapter()

    const fromApp = inSpace('hello', {
      sender: { name: 'users/99', displayName: 'some bot', type: 'BOT' },
    })

    expect(adapter.toIngress(fromApp), APP_WHY).toBeNull()
  })

  it('ignores an @-mention with nothing after it [fence:gchat-answers-anything-with-content]', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace('', { argumentText: '   ' })), CONTENT_WHY).toBeNull()
  })

  it('answers an @-mention whose only content is an image [fence:gchat-answers-anything-with-content]', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('', { argumentText: '  ', attachment: [UPLOADED] }))

    expect(message?.text, CONTENT_WHY).toBe('')
    expect(
      message?.enclosures.map(({ name }) => name),
      CONTENT_WHY,
    ).toEqual(['screenshot.png'])
  })
})

describe('what somebody sent along with a message', () => {
  it('carries an uploaded attachment as an Enclosure, unfetched', async () => {
    const { adapter, api } = newAdapter()
    api.holds('attachments/att-1', 'PNG')

    const message = adapter.toIngress(inSpace('what is this?', { attachment: [UPLOADED] }))

    expect(api.downloads).toEqual([])
    expect(await message?.enclosures[0]?.redeem()).toEqual(new TextEncoder().encode('PNG'))
    expect(api.downloads).toEqual(['attachments/att-1'])
  })

  it('reads the attachment list under either name', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace('x', { attachments: [UPLOADED] }))?.enclosures).toHaveLength(1)
  })

  it('makes an Enclosure for a Drive file that fails when redeemed', async () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('review this', { attachment: [IN_DRIVE] }))

    expect(message?.enclosures).toHaveLength(1)
    await expect(message?.enclosures[0]?.redeem()).rejects.toThrow(/Drive/)
  })

  it('carries several, in the order they arrived', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('both', { attachment: [UPLOADED, IN_DRIVE] }))

    expect(message?.enclosures.map(({ name }) => name)).toEqual(['screenshot.png', 'design.fig'])
  })

  it('says nothing to an operator when it understood what arrived', () => {
    const { adapter, logged } = newAdapter()

    adapter.toIngress(inSpace('fine', { attachment: [UPLOADED] }))

    expect(logged).toEqual([])
  })

  it('says so when something attachment-shaped arrived and nothing was read', () => {
    const { adapter, logged } = newAdapter()

    const unknownShape = { contentName: 'mystery.png', someFutureRef: { id: 'x' } }
    const message = adapter.toIngress(inSpace('look', { attachment: [unknownShape] }))

    expect(message?.enclosures).toEqual([])
    expect(logged).toEqual([{ event: 'attachment-unread', keys: ['contentName', 'someFutureRef'] }])
  })

  it('says nothing about a message that carried no attachments at all', () => {
    const { adapter, logged } = newAdapter()

    adapter.toIngress(inSpace('just words'))

    expect(logged).toEqual([])
  })
})

describe('the message a message quotes', () => {
  function quoting(
    snapshot: Record<string, unknown> | null,
    metadata: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      quotedMessageMetadata: {
        name: `${SPACE}/messages/msg-0`,
        lastUpdateTime: '2026-08-01T09:00:00Z',
        ...(snapshot === null ? {} : { quotedMessageSnapshot: snapshot }),
        ...metadata,
      },
    }
  }

  const SAID = { sender: 'users/99', text: 'the deploy failed at step 3' }

  it('carries the snapshot’s words and its author', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('why did this happen?', quoting(SAID)))

    expect(message?.quotation).toEqual({
      text: 'the deploy failed at step 3',
      author: 'users/99',
    })
    expect(message?.text).toBe('why did this happen?')
  })

  it('reads the same quotation however the message was quoted', () => {
    const { adapter } = newAdapter()
    const expected = { text: 'the deploy failed at step 3', author: 'users/99' }

    for (const quoteType of ['REPLY', 'FORWARD', undefined]) {
      const event = inSpace('why?', quoting(SAID, quoteType === undefined ? {} : { quoteType }))
      expect(adapter.toIngress(event)?.quotation).toEqual(expected)
    }
  })

  it('carries nothing of the space a forward came from [fence:gchat-forward-names-no-space]', () => {
    const why =
      'forwardedMetadata.spaceDisplayName must never be carried into the message (ADR-0021 §4). ' +
      'For a forwarded DM it holds the other participant’s name rather than a space’s, so ' +
      '<quoted from="Bob" space="Alice"> would read as Alice being a place: a fact that misleads ' +
      'in a knowable fraction of cases is worse than no fact.'
    const { adapter } = newAdapter()
    const forwarded = quoting(SAID, {
      quoteType: 'FORWARD',
      forwardedMetadata: { space: 'spaces/ELSEWHERE', spaceDisplayName: 'Alice Liddell' },
    })

    const message = adapter.toIngress(inSpace('why?', forwarded))

    expect(message?.quotation, why).toEqual({
      text: 'the deploy failed at step 3',
      author: 'users/99',
    })
    expect(JSON.stringify(message), why).not.toContain('Alice Liddell')
    expect(JSON.stringify(message), why).not.toContain('spaces/ELSEWHERE')
  })

  it('says nobody wrote it where the snapshot named nobody', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('why?', quoting({ text: 'no author here' })))

    expect(message?.quotation).toEqual({ text: 'no author here', author: null })
  })

  it('quotes nothing for a message that quoted nothing', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(inSpace('just words'))?.quotation).toBeNull()
  })

  it('answers an @-mention whose only content is a quotation [fence:gchat-answers-anything-with-content]', () => {
    const why =
      'A quotation with no words typed is a request, on the argument that made a pasted ' +
      'screenshot one: quoting an error at roma is the same act (ADR-0021). Test for empty ' +
      'content, not empty text (#92).'
    const { adapter } = newAdapter()

    const message = adapter.toIngress(inSpace('', { argumentText: '  ', ...quoting(SAID) }))

    expect(message?.text, why).toBe('')
    expect(message?.quotation?.text, why).toBe('the deploy failed at step 3')
  })

  it('carries a quoted message’s attachment as an Enclosure, marked as theirs', async () => {
    const { adapter, api } = newAdapter()
    api.holds('attachments/att-1', 'PNG')

    const message = adapter.toIngress(
      inSpace('what is this?', quoting({ ...SAID, attachments: [UPLOADED] })),
    )

    expect(message?.enclosures.map(({ name, from }) => ({ name, from }))).toEqual([
      { name: 'screenshot.png', from: 'users/99' },
    ])
    expect(api.downloads).toEqual([])
    expect(await message?.enclosures[0]?.redeem()).toEqual(new TextEncoder().encode('PNG'))
  })

  it('keeps the Caller’s own Enclosures ahead of the quoted message’s', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(
      inSpace('mine and theirs', {
        attachment: [IN_DRIVE],
        ...quoting({ ...SAID, attachments: [UPLOADED] }),
      }),
    )

    expect(message?.enclosures.map(({ name, from }) => ({ name, from }))).toEqual([
      { name: 'design.fig', from: null },
      { name: 'screenshot.png', from: 'users/99' },
    ])
  })

  it('makes no empty quotation out of a snapshot with no words', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(
      inSpace('look', quoting({ sender: 'users/99', attachments: [UPLOADED] })),
    )

    expect(message?.quotation).toBeNull()
    expect(message?.enclosures).toHaveLength(1)
  })

  it('says so when a quoted message arrived and nothing was read out of it', () => {
    const { adapter, logged } = newAdapter()

    const message = adapter.toIngress(
      inSpace('why?', quoting({ someFutureField: 'x' }, { quoteType: 'REPLY' })),
    )

    expect(message?.quotation).toBeNull()
    expect(logged).toEqual([
      {
        event: 'quote-unread',
        keys: [
          'name',
          'lastUpdateTime',
          'quotedMessageSnapshot',
          'quoteType',
          'quotedMessageSnapshot.someFutureField',
        ],
      },
    ])
  })

  it('says which of the two shapes arrived', () => {
    const { adapter, logged } = newAdapter()

    adapter.toIngress(inSpace('why?', quoting(null)))

    expect(logged).toEqual([{ event: 'quote-unread', keys: ['name', 'lastUpdateTime'] }])
  })

  it('says nothing to an operator when it understood the quotation', () => {
    const { adapter, logged } = newAdapter()

    adapter.toIngress(inSpace('why?', quoting(SAID)))

    expect(logged).toEqual([])
  })
})

describe('replying in Chat', () => {
  it('replies into the thread, with the option that establishes one [fence:gchat-reply-into-a-thread-name]', async () => {
    const why =
      'A Conversation Key in a space is a thread resource name, spaces/{space}/threads/{thread}, ' +
      'and a reply goes into it with REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD (ADR-0004). ' +
      'spaces/{space}/messages/{message} is a message name: an adapter parsing for that reads ' +
      'every real thread key as malformed and never replies in a space at all.'
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted, why).toEqual({
      space: SPACE,
      thread: THREAD,
      text: `${TO}the answer`,
      replyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    })
  })

  it('posts plainly in a DM', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted).toEqual({ space: DM, thread: null, text: `${TO}the answer` })
  })

  it('needs nothing it was told earlier to know where to reply', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.messages[0]?.posted.space).toBe(SPACE)
  })

  it('refuses a Conversation Key that is not a Chat one', async () => {
    const { adapter } = newAdapter()

    for (const key of [
      'not-a-chat-key',
      `${SPACE}/messages/msg-1`,
      'spaces/',
      `${SPACE}/threads/`,
    ]) {
      await expect(adapter.deliver(to(key, { kind: 'stopped' }))).rejects.toThrow(
        /conversation key/i,
      )
    }
  })

  it('does not swallow a Chat API failure [fence:gchat-deliver-rejects-what-chat-refused]', async () => {
    const why =
      '`deliver` must reject when Chat refused the post (ADR-0003: a delivery that rejects is ' +
      'the one failure the Core cannot absorb, and it acts on it). Swallowed, the Core believes ' +
      'the Conversation was told, and from the Conversation an instruction that reached nobody ' +
      'looks exactly like a message that was never received (#26).'
    const { adapter, api } = newAdapter()
    api.failNextPost(new Error('quota exceeded'))

    await expect(adapter.deliver(to(THREAD, { kind: 'result', text: 'hi' })), why).rejects.toThrow(
      'quota exceeded',
    )
  })
})

describe('the acknowledgement', () => {
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

  it('is one per Task, not one per Conversation', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'queued', position: 2 } }, 'task-2'),
    )

    expect(api.calls).toEqual(['post', 'post'])
    expect(api.texts).toEqual([`${TO}Working…`, `${TO}Queued — 2 waiting.`])
  })

  it('is never what the result is written into [fence:gchat-result-is-its-own-message]', async () => {
    const why =
      'A result must be posted as a message of its own, never edited into the acknowledgement ' +
      '(ADR-0003, Progress reporting: the rule is unconditional). The result is what people ' +
      'search for, quote and reply to months later, and a message that was mutating for the ' +
      'last five minutes is not one they can find (#26).'
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    expect(api.calls, why).toEqual(['post', 'post'])
    expect(api.texts, why).toEqual([`${TO}Working…`, `${TO}the answer`])
  })

  it('is one message when the next update comes before Chat has answered the first [fence:gchat-acknowledgement-held-from-the-post]', async () => {
    const why =
      'An acknowledgement is held from the instant its post is sent, as the promise of the ' +
      'message, not from when Chat answers with a name (ADR-0010: one acknowledgement per ' +
      'Task, edited in place). Stored once the create resolves, an update sent in between ' +
      'finds nothing and posts a second acknowledgement, and the Task has two messages ' +
      'mutating at once (#26).'
    const { adapter, api } = newAdapter()

    await Promise.all([
      adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } })),
      adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } })),
    ])

    expect(api.calls, why).toEqual(['post', 'edit'])
    expect(api.texts, why).toEqual([`${TO}Running awk…`])
  })

  it('tries again after a post that failed, rather than editing nothing [fence:gchat-acknowledgement-forgets-a-failed-post]', async () => {
    const why =
      'A post that failed leaves no message to edit, so the acknowledgement forgets it ' +
      '(ADR-0010). Kept, every later update for the Task edits a name that never existed and ' +
      'fails with an error from minutes ago, and one Chat hiccup silences the acknowledgement ' +
      'for the rest of a Task that is running perfectly well (#26).'
    const { adapter, api } = newAdapter()
    api.failNextPost(new Error('quota exceeded'))

    await expect(
      adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } })),
    ).rejects.toThrow('quota exceeded')
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool: 'awk' } }),
    )

    expect(api.calls, why).toEqual(['post', 'post'])
    expect(api.texts, why).toEqual([`${TO}Running awk…`])
  })

  it('says a Compaction is under way, in Claude Code’s own word for it', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'compacting' } }))

    expect(api.calls).toEqual(['post', 'edit'])
    expect(api.messages[0]?.text).toBe(`${TO}Compacting…`)
  })

  it('quotes only as much of a tool command as can be read at a glance', async () => {
    const { adapter, api } = newAdapter()
    const tool = `awk ${'-v x=1 '.repeat(1000)}`

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'tool', tool } }))

    const text = api.texts[0] ?? ''
    expect(api.calls).toEqual(['post'])
    expect(text.length).toBe(TO.length + 'Running '.length + 120 + '…'.length)
    expect(text.startsWith(`${TO}Running awk -v x=1 `)).toBe(true)
    expect(text).not.toContain(tool)
  })

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

  it('breaks an answer Chat would refuse into messages it will take [fence:gchat-split-under-the-limit]', async () => {
    const why =
      'An answer is split at a paragraph, line or word boundary into messages of at most ' +
      "Chat's 4096 characters, with the mention counted inside the limit (ADR-0009, " +
      'ADR-0010). Chat refuses a longer message outright, so a mention added after the split ' +
      'pushes the first message over and the whole answer never arrives; cutting mid-word ' +
      'makes a long answer read as corrupted (#67).'
    const { adapter, api } = newAdapter()
    const long = Array.from({ length: 60 }, (_, n) => `Paragraph ${n}. ${'word '.repeat(60)}`).join(
      '\n\n',
    )

    await adapter.deliver(to(THREAD, { kind: 'result', text: long }))

    expect(api.messages.length).toBeGreaterThan(1)
    for (const message of api.messages) {
      expect(message.text.length, why).toBeLessThanOrEqual(MAX_TEXT)
    }
    expect(api.texts.join('\n\n').replace(/\s+/g, ' '), why).toBe(
      `${TO}${long}`.replace(/\s+/g, ' '),
    )
  })

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

const BOTH_SHAPES =
  'A button press must be read off both of Chat’s parameter shapes: `common.parameters`, an ' +
  'object, and the older `action.parameters`, a list of key/value pairs — which one arrives ' +
  'depends on how the event was delivered (ADR-0002, ADR-0004, ' +
  'https://developers.google.com/workspace/chat/read-form-data). Reading one makes the button ' +
  'do nothing, silently, for every delivery carrying the other, and somebody presses it and ' +
  'keeps waiting (#29).'

describe('a Task the Shared Window has blocked', () => {
  it('says quota is spent, when it comes back, and that the Task is kept [fence:gchat-blocked-says-the-task-is-kept]', async () => {
    const why =
      "A blocked Task's message gives the reset time the event carried, never an estimate, " +
      'and says the Task is kept (ADR-0002: a parked Task runs again when the window resets). ' +
      'Told only that quota is spent, people send the message again — the duplicate the ' +
      'acknowledgement exists to prevent (#29).'
    const { adapter, api } = newAdapter()

    await adapter.deliver(
      to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }),
    )

    expect(api.texts, why).toEqual([
      `${TO}The shared Claude quota is spent. It comes back at 2026-07-28 20:40 UTC — I have kept your task and will run it then.`,
    ])
  })

  it('carries the offer as a button naming the Task it is about [fence:gchat-overflow-names-the-task]', async () => {
    const why =
      'The Overflow button is named by the Task, never by the Conversation (ADR-0002: Overflow ' +
      'is offered at the moment a Task blocks). A Conversation can have a second Task blocked ' +
      'behind this one, and "the blocked Task here" would spend money on whichever roma looked ' +
      'at first (#29).'
    const { adapter, api } = newAdapter()

    await adapter.deliver(
      to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: true }, 'task-77'),
    )

    expect(api.messages[0]?.posted.actions, why).toEqual([
      {
        label: 'Run it on metered billing',
        action: 'takeOverflow',
        parameters: { taskId: 'task-77' },
      },
    ])
  })

  it('posts no button where the Core did not offer one', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(
      to(THREAD, { kind: 'blocked', resetsAt: 1785271200, overflowOffered: false }),
    )

    expect(api.messages[0]?.posted.actions).toBeUndefined()
  })

  it('reads a click on it as the Task it was offered for [fence:gchat-press-reads-both-shapes]', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toOverflowTaken({
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId: 'task-77' } },
      }),
      BOTH_SHAPES,
    ).toBe('task-77')
  })

  it('reads the older parameter shape too [fence:gchat-press-reads-both-shapes]', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toOverflowTaken({
        type: 'CARD_CLICKED',
        action: {
          actionMethodName: 'takeOverflow',
          parameters: [{ key: 'taskId', value: 'task-77' }],
        },
      }),
      BOTH_SHAPES,
    ).toBe('task-77')
  })

  it('reads an ordinary message as no such click', () => {
    const { adapter } = newAdapter()

    expect(adapter.toOverflowTaken(inSpace())).toBeNull()
  })

  it('reads a click as no ingress message either', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toIngress({
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId: 'task-77' } },
      }),
    ).toBeNull()
  })

  it('names /clear when the context cannot be reduced any further', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'context-full' }))

    expect(api.texts).toEqual([
      `${TO}Claude cannot shorten this conversation any further, so it cannot take another ` +
        'message. Send /clear to start a fresh session — nothing from this one carries over.',
    ])
  })

  it('keeps the acknowledgement it was mutating', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'context-full' }))
    await adapter.deliver(
      to(THREAD, { kind: 'progress', progress: { phase: 'writing', characters: 14 } }),
    )

    expect(api.calls).toEqual(['post', 'post', 'edit'])
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

  it('does not price a Turn nothing priced [fence:gchat-unpriced-is-not-free]', async () => {
    const why =
      'An Overflow Turn nothing priced is said to be unpriced, never "$0.00" (ADR-0002: the ' +
      'spend is shown in the reply). "$0.00" reports money as free, the one claim the Audit ' +
      'Record refuses to make about a Turn nothing priced (#29).'
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'result', text: 'done', overflowCostUsd: null }))

    expect(api.texts, why).toEqual([
      `${TO}done`,
      'Ran on metered billing. What it cost was never reported.',
    ])
  })
})

describe('addressing the person who asked', () => {
  it('mentions the Caller on the acknowledgement and on the result', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(to(THREAD, { kind: 'result', text: 'the answer' }))

    for (const text of api.texts) expect(text.startsWith(`<${SENDER}> `)).toBe(true)
  })

  it('addresses each of a thread’s two Tasks to its own Caller', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { kind: 'progress', progress: { phase: 'working' } }))
    await adapter.deliver(
      to(
        THREAD,
        { kind: 'progress', progress: { phase: 'queued', position: 2 } },
        'task-2',
        'users/99',
        'Bob',
      ),
    )

    expect(api.texts).toEqual([`<${SENDER}> Working…`, '<users/99> Queued — 2 waiting.'])
  })

  it('mentions on the first message of an answer and no other [fence:gchat-mention-once-per-answer]', async () => {
    const why =
      'A long answer mentions the Caller on its first message only (ADR-0009). Each piece is ' +
      'a separate post, and Chat notifies on each: a mention on every one notifies somebody ' +
      'once per 4096 characters of the answer (#67).'
    const { adapter, api } = newAdapter()
    const long = 'word '.repeat(2000)

    await adapter.deliver(to(THREAD, { kind: 'result', text: long, overflowCostUsd: 0.42 }))

    expect(api.texts.length).toBeGreaterThan(2)
    expect(
      api.texts.filter((text) => text.includes(`<${SENDER}>`)),
      why,
    ).toHaveLength(1)
  })

  it('mentions the Caller in a DM too, rather than carrying an exception', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(DM, { kind: 'result', text: 'the answer' }))

    expect(api.texts).toEqual([`<${SENDER}> the answer`])
  })
})

describe('choosing a model, an effort or a Caveman by pressing', () => {
  const PRESSER_WHY =
    'A Menu press is read by `readChosenOption`, off `event.user`, and never through ' +
    "`readIngressMessage` (ADR-0023: pressing is typing). The message on a press is roma's " +
    "own card, whose sender is an app: that reader's bot guard swallows the press, and " +
    'relaxing the guard re-opens two apps answering each other and credits the choice to ' +
    'roma (#140).'
  const MENUS_WHY =
    'The Chat reader reads back exactly the Menus `OutboundInstruction` offers, and no ' +
    'other Command (ADR-0023). A Menu the Core offers and this cannot read back is a button ' +
    'that does nothing under a Caller who goes on waiting; a Command it reads that no Menu ' +
    'offers is `/stop` or `/clear` reachable through a door meant for a Menu. The reader keys ' +
    'a `Record` over `choice.chooses`, so widening either side alone fails to compile ' +
    '(#140, #192).'

  function press(
    chooses: string,
    option: string,
    { key = THREAD, direct = false }: { key?: string; direct?: boolean } = {},
  ): ChatEvent {
    return {
      type: 'CARD_CLICKED',
      user: { name: SENDER, displayName: 'Ada', type: 'HUMAN' },
      space: direct
        ? { name: SPACE, type: 'DM', spaceType: 'DIRECT_MESSAGE' }
        : { name: SPACE, type: 'ROOM', spaceType: 'SPACE' },
      message: {
        name: `${SPACE}/messages/msg-9`,
        sender: { name: 'users/roma', displayName: 'roma', type: 'BOT' },
        text: 'This conversation is on sonnet (claude-sonnet-5).',
        ...(direct ? {} : { thread: { name: key } }),
      },
      common: { invokedFunction: 'choose', parameters: { chooses, option } },
    }
  }

  const MODEL_MENU = {
    kind: 'choice',
    text: 'This conversation is on sonnet (claude-sonnet-5). You can choose: fable, opus, sonnet, haiku, default.',
    chooses: 'model',
    options: ['fable', 'opus', 'sonnet', 'haiku', 'default'],
    refused: null,
  } as const

  it('posts one button per name on the Menu, labelled by the name', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, MODEL_MENU))

    expect(api.messages[0]?.posted.actions).toEqual([
      { label: 'fable', action: 'choose', parameters: { chooses: 'model', option: 'fable' } },
      { label: 'opus', action: 'choose', parameters: { chooses: 'model', option: 'opus' } },
      { label: 'sonnet', action: 'choose', parameters: { chooses: 'model', option: 'sonnet' } },
      { label: 'haiku', action: 'choose', parameters: { chooses: 'model', option: 'haiku' } },
      { label: 'default', action: 'choose', parameters: { chooses: 'model', option: 'default' } },
    ])
  })

  it('draws the Caveman Menu six wide, and the operator’s two levels nowhere on it', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(
      to(THREAD, {
        kind: 'choice',
        text: 'This conversation runs at caveman default (off).',
        chooses: 'caveman',
        options: ['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'],
        refused: null,
      }),
    )

    expect(api.messages[0]?.posted.actions).toEqual(
      ['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'].map((option) => ({
        label: option,
        action: 'choose',
        parameters: { chooses: 'caveman', option },
      })),
    )
    for (const withheld of ['wenyan-lite', 'wenyan-ultra']) {
      expect(api.messages[0]?.posted.actions).not.toContainEqual(
        expect.objectContaining({ label: withheld }),
      )
    }
  })

  it('posts the words as well as the buttons', async () => {
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, MODEL_MENU))

    expect(api.texts).toEqual([`${TO}${MODEL_MENU.text}`])
  })

  it('reads a press as the Command the Caller would have typed [fence:gchat-press-is-read-off-the-presser]', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(press('model', 'opus')), PRESSER_WHY).toEqual({
      conversationKey: THREAD,
      caller: SENDER,
      callerName: 'Ada',
      text: '/model opus',
      enclosures: [],
      quotation: null,
    })
  })

  it('reads an effort press the same way', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(press('effort', 'xhigh'))?.text).toBe('/effort xhigh')
  })

  it('reads a Caveman press, hyphen and all, as the Command it stands for', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(press('caveman', 'wenyan-full'))?.text).toBe('/caveman wenyan-full')
  })

  it('reads every name on every Menu back as the Command a Caller would have typed [fence:gchat-reads-only-the-menus-it-draws]', async () => {
    const menus = [
      { chooses: 'model' as const, names: MENU_NAMES },
      { chooses: 'effort' as const, names: EFFORT_NAMES },
      { chooses: 'caveman' as const, names: CAVEMAN_NAMES },
    ]

    for (const { chooses, names } of menus) {
      const { adapter, api } = newAdapter()
      await adapter.deliver(
        to(THREAD, { kind: 'choice', text: 'pick one', chooses, options: names, refused: null }),
      )
      const actions = api.messages[0]?.posted.actions ?? []
      expect(actions).toHaveLength(names.length)

      for (const action of actions) {
        const pressed = adapter.toIngress({
          ...press('unread', 'unread'),
          common: { invokedFunction: action.action, parameters: action.parameters },
        })
        expect(readCommand(pressed?.text ?? ''), MENUS_WHY).toEqual({
          command: chooses,
          argument: action.label,
        })
      }
    }
  })

  it('takes the Caller from whoever pressed, not from the card roma posted [fence:gchat-press-is-read-off-the-presser]', () => {
    const { adapter } = newAdapter()

    const message = adapter.toIngress(press('model', 'opus'))

    expect(message?.caller, PRESSER_WHY).toBe(SENDER)
    expect(message?.caller, PRESSER_WHY).not.toBe('users/roma')
  })

  it('lands in the thread it was pressed in, and in the space in a DM [fence:gchat-conversation-key-from-the-space]', () => {
    const why =
      'A press is keyed by the reading a message is keyed by; two readings drift, and a ' +
      'Conversation Key that drifts is a Session that loses its context (ADR-0004, #140).'
    const { adapter } = newAdapter()

    expect(adapter.toIngress(press('model', 'opus'))?.conversationKey, why).toBe(THREAD)
    expect(adapter.toIngress(press('model', 'opus', { direct: true }))?.conversationKey, why).toBe(
      SPACE,
    )
  })

  it('reads the older parameter shape too', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toIngress({
        ...press('model', 'opus'),
        common: undefined,
        action: {
          actionMethodName: 'choose',
          parameters: [
            { key: 'chooses', value: 'model' },
            { key: 'option', value: 'haiku' },
          ],
        },
      })?.text,
    ).toBe('/model haiku')
  })

  it('reads a press naming any other Command as no message at all [fence:gchat-reads-only-the-menus-it-draws]', () => {
    const { adapter } = newAdapter()

    expect(adapter.toIngress(press('clear', 'anything')), MENUS_WHY).toBeNull()
    expect(adapter.toIngress(press('stop', 'now')), MENUS_WHY).toBeNull()
    expect(adapter.toIngress(press('config', 'model=opus')), MENUS_WHY).toBeNull()
    expect(adapter.toIngress(press('constructor', 'opus')), MENUS_WHY).toBeNull()
  })

  it('reads an Overflow press as no choice, and a choice press as no Overflow', () => {
    const { adapter } = newAdapter()

    expect(
      adapter.toIngress({
        type: 'CARD_CLICKED',
        common: { invokedFunction: 'takeOverflow', parameters: { taskId: 'task-77' } },
      }),
    ).toBeNull()
    expect(adapter.toOverflowTaken(press('model', 'opus'))).toBeNull()
  })

  it('puts the buttons under the last message when the text has to split [fence:gchat-buttons-under-the-last-piece]', async () => {
    const why =
      'Buttons go on the last message of a split answer and no other (ADR-0023). On every ' +
      'piece, an answer long enough to split repeats the whole Menu under each one, and ' +
      'buttons belong under the text that explains them (#140).'
    const { adapter, api } = newAdapter()

    await adapter.deliver(to(THREAD, { ...MODEL_MENU, text: 'word '.repeat(2000) }))

    expect(api.messages.length).toBeGreaterThan(1)
    expect(api.messages.at(-1)?.posted.actions, why).toHaveLength(MODEL_MENU.options.length)
    for (const message of api.messages.slice(0, -1)) {
      expect(message.posted.actions, why).toBeUndefined()
    }
  })
})
