import { describe, expect, it } from 'vitest'
import { HttpDiscordApi } from './http-discord-api.js'

// SEAM 3 — the REST half, asserted on the request Discord would have received.
// Nothing here reaches a network, and nothing here decides anything: which
// message to ask for was decided before it got this far.

const TOKEN = 'a-bot-token'
const API = 'https://discord.example/api/v10'

/** Every request roma made, and whatever the test decided came back. */
function answering(answer: (url: string) => Response) {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input)
    requests.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
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
