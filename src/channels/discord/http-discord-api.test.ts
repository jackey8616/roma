import { describe, expect, it } from 'vitest'
import { DiscordRefusal, MAX_BUTTONS } from './discord-api.js'
import { HttpDiscordApi } from './http-discord-api.js'

// SEAM 3 — the REST half, asserted on the request Discord would have received.
// Nothing here reaches a network, and nothing here decides anything: which
// message to ask for was decided before it got this far.
//
// The two exceptions are the two things a caller cannot read anywhere else, and
// they are the reason this file grew with the outbound half: how long Discord
// asked roma to wait, and whether a refused thread was refused because it
// already exists. Both are facts about a *response*, so they are asserted where
// a response can be written out (ADR-0029).

const TOKEN = 'a-bot-token'
const API = 'https://discord.example/api/v10'

/** One request, as much of it as a test asserts on. */
interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | null
}

/** Every request roma made, and whatever the test decided came back. */
function answering(answer: (url: string) => Response) {
  const requests: RecordedRequest[] = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    return Promise.resolve(answer(url))
  }
  return { requests, api: new HttpDiscordApi({ botToken: TOKEN, apiBase: API, fetch }) }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('asking Discord for a message', () => {
  it('asks the route the message lives on', async () => {
    const { api, requests } = answering(() => json({ id: 'm-1', content: 'the deploy failed' }))

    expect(await api.message('c-1', 'm-1')).toMatchObject({ content: 'the deploy failed' })
    expect(requests[0]?.url).toBe(`${API}/channels/c-1/messages/m-1`)
  })

  // The scheme is what tells Discord which kind of credential this is. A bare
  // token is refused as unauthorized, which arrives at the other end as a
  // Quotation that silently never resolves.
  it('sends the token as a bot token rather than as a bare one [fence:discord-bot-token-scheme]', async () => {
    const { api, requests } = answering(() => json({ id: 'm-1' }))

    await api.message('c-1', 'm-1')

    expect(requests[0]?.headers['authorization'], BOT_TOKEN).toBe(`Bot ${TOKEN}`)
  })

  // Rejecting rather than answering with nothing: the one caller turns a
  // rejection into no Quotation at all, and an empty message would be a
  // Quotation with nothing in it.
  it('rejects where Discord refuses', async () => {
    const { api } = answering(() => new Response('', { status: 403 }))

    await expect(api.message('c-1', 'm-1')).rejects.toThrow(/403/)
  })
})

describe('redeeming an attachment', () => {
  // **The token goes nowhere near this one.** An attachment URL is a signed link
  // on a content host rather than a call to the API, and a credential added here
  // is a credential handed to whatever is on the end of a URL that arrived in
  // somebody's message.
  it('fetches the link as it stands, with no credential on it [fence:discord-download-carries-no-token]', async () => {
    const { api, requests } = answering(() => new Response('the bytes', { status: 200 }))

    const content = await api.download('https://cdn.example/attachments/screenshot.png?ex=1')

    expect(new TextDecoder().decode(content)).toBe('the bytes')
    expect(requests[0]?.headers, NO_TOKEN_ON_DOWNLOAD).toEqual({})
  })

  it('rejects where the link has expired', async () => {
    const { api } = answering(() => new Response('', { status: 404 }))

    await expect(api.download('https://cdn.example/gone.png')).rejects.toThrow(/404/)
  })
})

describe('saying something in a channel', () => {
  it('posts the words to the channel it was given', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    expect(await api.post({ channel: 'c-1', text: 'the answer', replyTo: null, buttons: [] })).toBe(
      'm-9',
    )
    expect(requests[0]?.url).toBe(`${API}/channels/c-1/messages`)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toMatchObject({ content: 'the answer' })
  })

  // How a Caller is addressed on this Channel — Discord's own reply rather than
  // an @-mention, which is what Chat has and what would spend characters out of
  // a limit half the size (ADR-0029).
  it('answers the Caller’s message with a reply rather than a mention [fence:discord-reply-survives-deleted-message]', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({ channel: 'c-1', text: 'the answer', replyTo: 'm-1', buttons: [] })

    expect(requests[0]?.body?.['message_reference'], REPLY_SURVIVES_DELETION).toEqual({
      message_id: 'm-1',
      // **Never let this default.** It is true unless it is said otherwise, so a
      // reply to a message somebody deleted while the Task ran would not be a
      // plainer answer but no answer at all.
      fail_if_not_exists: false,
    })
  })

  // The words in a Result are written by a model that reads whatever anybody put
  // in front of it, so an answer containing `@everyone` is one prompt away — and
  // on Discord that is a notification to a whole guild rather than a rendering
  // detail. `parse: []` leaves the characters and takes the ping out of them.
  it('lets nothing the text asks for be a mention, and keeps the reply’s [fence:discord-text-mentions-nobody]', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({
      channel: 'c-1',
      text: '@everyone the deploy is done',
      replyTo: 'm-1',
      buttons: [],
    })

    expect(requests[0]?.body?.['allowed_mentions'], MENTIONS_NOBODY).toEqual({
      parse: [],
      replied_user: true,
    })
  })

  // A message with nothing to press carries no `components` at all, rather than
  // an empty list: an empty action row is a card with nothing in it, and Discord
  // is entitled to refuse one.
  it('sends no components on a message with nothing to press', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({ channel: 'c-1', text: 'the answer', replyTo: null, buttons: [] })

    expect(requests[0]?.body).not.toHaveProperty('components')
  })

  // An action row holds five buttons and the Effort Menu is six, so the sixth is
  // a row of its own — and the order across the rows is the Menu's, because that
  // is what somebody reading the card is reading.
  it('lays a Menu out in rows of five, in the order it was given [fence:discord-buttons-fit-one-message]', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({
      channel: 'c-1',
      text: 'This conversation runs at high.',
      replyTo: null,
      buttons: ['low', 'medium', 'high', 'xhigh', 'max', 'default'].map((label) => ({
        label,
        customId: `choose:effort:c-1:${label}`,
      })),
    })

    expect(requests[0]?.body?.['components'], FITS_ONE_MESSAGE).toEqual([
      {
        type: 1,
        components: ['low', 'medium', 'high', 'xhigh', 'max'].map((label) => ({
          type: 2,
          style: 2,
          label,
          custom_id: `choose:effort:c-1:${label}`,
        })),
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'default', custom_id: 'choose:effort:c-1:default' },
        ],
      },
    ])
  })

  // The widest Menu roma will draw, laid out: Discord holds a message to five
  // action rows of five buttons, and refuses the whole message past either.
  it('fits the widest Menu roma will draw into five rows of five [fence:discord-buttons-fit-one-message]', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))
    const buttons = Array.from({ length: MAX_BUTTONS }, (_, at) => ({
      label: `option-${at}`,
      customId: `choose:model:c-1:option-${at}`,
    }))

    await api.post({ channel: 'c-1', text: 'Choose one.', replyTo: null, buttons })

    const rows = requests[0]?.body?.['components'] as { components: unknown[] }[]
    expect(rows.length, FITS_ONE_MESSAGE).toBeLessThanOrEqual(5)
    for (const row of rows) expect(row.components.length, FITS_ONE_MESSAGE).toBeLessThanOrEqual(5)
    expect(rows.flatMap((row) => row.components)).toHaveLength(MAX_BUTTONS)
  })

  // What a Menu too wide for one message becomes is the Adapter's decision; this
  // file lays out what it is given and decides nothing.
  it('sends every button it is given, and trims no Menu [fence:discord-http-trims-no-menu]', async () => {
    const why =
      'HttpDiscordApi must send every button it is handed and trim none (ADR-0023). Dropping ' +
      'a tail is a decision: a card quietly missing its tail says those are all the names ' +
      'there are, and only the caller knows whether the answer is complete without them. ' +
      'Past MAX_BUTTONS, Discord refusing the whole message is the honest failure (#191).'
    const { api, requests } = answering(() => json({ id: 'm-9' }))
    const wide = Array.from({ length: MAX_BUTTONS + 1 }, (_, at) => ({
      label: `option-${at}`,
      customId: `choose:model:c-1:option-${at}`,
    }))

    await api.post({ channel: 'c-1', text: 'Choose one.', replyTo: null, buttons: wide })

    const rows = requests[0]?.body?.['components'] as { components: { custom_id: string }[] }[]
    expect(
      rows.flatMap((row) => row.components.map(({ custom_id }) => custom_id)),
      why,
    ).toEqual(wide.map(({ customId }) => customId))
  })

  it('edits a message roma posted, in place', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.edit('c-1', 'm-9', 'Working…')

    expect(requests[0]?.url).toBe(`${API}/channels/c-1/messages/m-9`)
    expect(requests[0]?.method).toBe('PATCH')
    expect(requests[0]?.body).toMatchObject({ content: 'Working…' })
  })
})

describe('opening a thread from a message', () => {
  // The route is the message's own, and the thread it makes takes that message's
  // id — which is the fact the whole Conversation Key table rests on.
  it('asks the route the message lives on, and answers with its id', async () => {
    const { api, requests } = answering(() => json({ id: 'm-1', name: 'summarise this' }))

    expect(await api.startThread('c-1', 'm-1', 'summarise this')).toBe('m-1')
    expect(requests[0]?.url).toBe(`${API}/channels/c-1/messages/m-1/threads`)
    expect(requests[0]?.body).toEqual({ name: 'summarise this' })
  })

  /**
   * **The refusal that is not one.**
   *
   * *"A message can only have a single thread created from it"*, so a creation
   * Discord carried out and then failed to report is one roma re-attempts — and
   * read as a failure, every retry would be permanent and the answer would go to
   * the parent channel of a thread roma had already opened.
   *
   * The code is read from Discord's JSON error code table rather than from the
   * route's own documentation, which is why being wrong about it has to fail
   * harmlessly: roma would take the refusal at its word and answer in the
   * channel the message arrived in, which is ADR-0029's harmless direction.
   */
  it('reads a message that already has a thread as the thread it wanted [fence:discord-thread-already-created-is-success]', async () => {
    const { api } = answering(
      () =>
        new Response(
          JSON.stringify({ code: 160004, message: 'A thread has already been created' }),
          { status: 400 },
        ),
    )

    expect(await api.startThread('c-1', 'm-1', 'summarise this'), ALREADY_CREATED).toBe('m-1')
  })

  // Every other refusal is the signal ADR-0029 says it is: no permission, or a
  // forum or media channel where the route does not work at all. The one caller
  // posts in the channel the message arrived in instead.
  it('rejects where Discord refused for any other reason', async () => {
    const { api } = answering(() => new Response(JSON.stringify({ code: 50013 }), { status: 403 }))

    await expect(api.startThread('c-1', 'm-1', 'x')).rejects.toThrow(/403/)
  })
})

describe('answering a press inside its three seconds', () => {
  // Type 6 and no other. *"ACK an interaction and edit the original message
  // later; the user does not see a loading state"* — every other callback type
  // either posts something or shows a spinner, and both would have roma
  // answering one Command twice. Pressing is typing, and typing does not rewrite
  // the message you typed into (ADR-0023, ADR-0029).
  it('acknowledges without touching the card [fence:discord-press-ack-leaves-card]', async () => {
    const { api, requests } = answering(() => new Response(null, { status: 204 }))

    await api.acknowledgePress('i-1', 'interaction-token')

    expect(requests[0]?.url).toBe(`${API}/interactions/i-1/interaction-token/callback`)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body, ACK_LEAVES_CARD).toEqual({ type: 6 })
  })

  // Rejects like any other call. What the one caller does with that is write it
  // down and answer the press anyway — the person has already chosen.
  it('rejects where Discord refused it, rather than reporting a press that failed', async () => {
    const { api } = answering(() => new Response('', { status: 404 }))

    await expect(api.acknowledgePress('i-1', 'gone')).rejects.toThrow(/404/)
  })
})

describe('what a refusal carries back', () => {
  /** A refusal, so a test can read the two fields a retry acts on. */
  async function refusalFrom(response: Response): Promise<DiscordRefusal> {
    const { api } = answering(() => response)
    try {
      await api.post({ channel: 'c-1', text: 'the answer', replyTo: null, buttons: [] })
    } catch (error) {
      return error as DiscordRefusal
    }
    throw new Error('that response was not a refusal')
  }

  // Read off the response and never inferred: Discord's per-route limits are
  // dynamic and its reference says *"rate limits should not be hard coded into
  // your app"*. Seconds on the wire, and either header may be fractional.
  it('reads how long Discord asked roma to wait off the 429 [fence:discord-retry-after-is-read]', async () => {
    const refusal = await refusalFrom(
      new Response('', { status: 429, headers: { 'retry-after': '1.5' } }),
    )

    expect(refusal).toBeInstanceOf(DiscordRefusal)
    expect(refusal.status).toBe(429)
    expect(refusal.retryAfterMs, RETRY_AFTER_IS_READ).toBe(1500)
  })

  it('reads the bucket’s own reset where there is no retry-after [fence:discord-retry-after-is-read]', async () => {
    const refusal = await refusalFrom(
      new Response('', { status: 429, headers: { 'x-ratelimit-reset-after': '0.25' } }),
    )

    expect(refusal.retryAfterMs, RETRY_AFTER_IS_READ).toBe(250)
  })

  // A 503 while Discord moves something carries no time at all, and the caller
  // backs off on its own clock rather than inventing one here.
  it('says nothing about waiting where Discord named no time [fence:discord-retry-after-is-read]', async () => {
    const refusal = await refusalFrom(new Response('', { status: 503 }))

    expect(refusal.status).toBe(503)
    expect(refusal.retryAfterMs, RETRY_AFTER_IS_READ).toBeNull()
  })
})

const BOT_TOKEN =
  'Every API call must carry the token as `Bot <token>` (ADR-0029). Discord reads the scheme ' +
  'to decide what kind of credential it is, and a bare token is refused as unauthorized — ' +
  'which arrives as a Quotation that silently never resolves, or an answer nobody is told (#191).'

const NO_TOKEN_ON_DOWNLOAD =
  'An attachment download must carry no credential (ADR-0011, ADR-0029). Its URL is a signed ' +
  'link on a content host, not an API call, and it arrived in somebody’s message: a token put ' +
  'on it is handed to whatever is on the other end of that URL (#191).'

const REPLY_SURVIVES_DELETION =
  'A reply must say fail_if_not_exists: false (ADR-0029). It defaults to true, so a reply to a ' +
  'message somebody deleted while the Task ran is refused whole, and the Conversation is told ' +
  'nothing about work already paid for (#191).'

const MENTIONS_NOBODY =
  'allowed_mentions must parse nothing out of the text, and keep only the reply’s ping ' +
  '(ADR-0029). A Result is written by a model that read whatever anybody put in front of it, so ' +
  'an @everyone in one would notify a whole guild, and nobody can take that back (#191).'

const FITS_ONE_MESSAGE =
  'A message must carry at most five action rows of at most five buttons (ADR-0023, ' +
  'ADR-0029). Discord refuses the whole message past either, so a Menu one button too wide is ' +
  'not a shorter Menu but no message at all — and on the blocked path, an Overflow offer that ' +
  'never reaches the person waiting on it. MAX_BUTTONS is the lower of the two counts sources ' +
  'give (25, not #181’s 40) because too high costs the message, too low only its buttons (#191).'

const ALREADY_CREATED =
  'startThread must read code 160004, a message that already has a thread, as success ' +
  '(ADR-0029). A message can only have one thread, so a creation Discord carried out and failed ' +
  'to report is one roma re-attempts; read as a failure every retry is permanent, and roma ' +
  'answers in the parent channel of a thread it already opened (#191).'

const ACK_LEAVES_CARD =
  'A press must be acknowledged with DEFERRED_UPDATE_MESSAGE (type 6) and no other (ADR-0023, ' +
  'ADR-0029). Pressing is typing, and typing does not rewrite the message typed into: every ' +
  'other callback type posts something or shows a spinner, and either has roma answering one ' +
  'Command twice (#191).'

const RETRY_AFTER_IS_READ =
  'retryAfterMs must be read off retry-after or x-ratelimit-reset-after and never inferred ' +
  '(ADR-0029). Discord’s per-route limits are dynamic — "rate limits should not be hard coded ' +
  'into your app" — and 429s count toward the 10,000-per-10-minutes invalid-request limit ' +
  'whose block is on the whole API, so a guessed wait in one Conversation is an outage of every ' +
  'Conversation (#191).'
