import { describe, expect, it } from 'vitest'
import { DiscordRefusal } from './discord-api.js'
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
  it('sends the token as a bot token rather than as a bare one', async () => {
    const { api, requests } = answering(() => json({ id: 'm-1' }))

    await api.message('c-1', 'm-1')

    expect(requests[0]?.headers['authorization']).toBe(`Bot ${TOKEN}`)
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
  it('fetches the link as it stands, with no credential on it', async () => {
    const { api, requests } = answering(() => new Response('the bytes', { status: 200 }))

    const content = await api.download('https://cdn.example/attachments/screenshot.png?ex=1')

    expect(new TextDecoder().decode(content)).toBe('the bytes')
    expect(requests[0]?.headers).toEqual({})
  })

  it('rejects where the link has expired', async () => {
    const { api } = answering(() => new Response('', { status: 404 }))

    await expect(api.download('https://cdn.example/gone.png')).rejects.toThrow(/404/)
  })
})

describe('saying something in a channel', () => {
  it('posts the words to the channel it was given', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    expect(await api.post({ channel: 'c-1', text: 'the answer', replyTo: null })).toBe('m-9')
    expect(requests[0]?.url).toBe(`${API}/channels/c-1/messages`)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toMatchObject({ content: 'the answer' })
  })

  // How a Caller is addressed on this Channel — Discord's own reply rather than
  // an @-mention, which is what Chat has and what would spend characters out of
  // a limit half the size (ADR-0029).
  it('answers the Caller’s message with a reply rather than a mention', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({ channel: 'c-1', text: 'the answer', replyTo: 'm-1' })

    expect(requests[0]?.body?.['message_reference']).toEqual({
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
  it('lets nothing the text asks for be a mention, and keeps the reply’s', async () => {
    const { api, requests } = answering(() => json({ id: 'm-9' }))

    await api.post({ channel: 'c-1', text: '@everyone the deploy is done', replyTo: 'm-1' })

    expect(requests[0]?.body?.['allowed_mentions']).toEqual({ parse: [], replied_user: true })
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
  it('reads a message that already has a thread as the thread it wanted', async () => {
    const { api } = answering(
      () =>
        new Response(
          JSON.stringify({ code: 160004, message: 'A thread has already been created' }),
          { status: 400 },
        ),
    )

    expect(await api.startThread('c-1', 'm-1', 'summarise this')).toBe('m-1')
  })

  // Every other refusal is the signal ADR-0029 says it is: no permission, or a
  // forum or media channel where the route does not work at all. The one caller
  // posts in the channel the message arrived in instead.
  it('rejects where Discord refused for any other reason', async () => {
    const { api } = answering(() => new Response(JSON.stringify({ code: 50013 }), { status: 403 }))

    await expect(api.startThread('c-1', 'm-1', 'x')).rejects.toThrow(/403/)
  })
})

describe('what a refusal carries back', () => {
  /** A refusal, so a test can read the two fields a retry acts on. */
  async function refusalFrom(response: Response): Promise<DiscordRefusal> {
    const { api } = answering(() => response)
    try {
      await api.post({ channel: 'c-1', text: 'the answer', replyTo: null })
    } catch (error) {
      return error as DiscordRefusal
    }
    throw new Error('that response was not a refusal')
  }

  // Read off the response and never inferred: Discord's per-route limits are
  // dynamic and its reference says *"rate limits should not be hard coded into
  // your app"*. Seconds on the wire, and either header may be fractional.
  it('reads how long Discord asked roma to wait off the 429', async () => {
    const refusal = await refusalFrom(
      new Response('', { status: 429, headers: { 'retry-after': '1.5' } }),
    )

    expect(refusal).toBeInstanceOf(DiscordRefusal)
    expect(refusal.status).toBe(429)
    expect(refusal.retryAfterMs).toBe(1500)
  })

  it('reads the bucket’s own reset where there is no retry-after', async () => {
    const refusal = await refusalFrom(
      new Response('', { status: 429, headers: { 'x-ratelimit-reset-after': '0.25' } }),
    )

    expect(refusal.retryAfterMs).toBe(250)
  })

  // A 503 while Discord moves something carries no time at all, and the caller
  // backs off on its own clock rather than inventing one here.
  it('says nothing about waiting where Discord named no time', async () => {
    const refusal = await refusalFrom(new Response('', { status: 503 }))

    expect(refusal.status).toBe(503)
    expect(refusal.retryAfterMs).toBeNull()
  })
})
