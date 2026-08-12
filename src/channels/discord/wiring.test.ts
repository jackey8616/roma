import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from '../../build-env.js'
import { PINNED_MODEL } from '../../claude-session.js'
import { bind, serve, type Serving } from '../../serve.js'
import { sessionIdFor } from '../../session-id.js'
import type { ClaudeEvent } from '../../stream-events.js'
import { DiscordAdapter } from './discord-adapter.js'
import { GatewayTransport, type DiscordLogRecord } from './gateway-transport.js'
import { HttpDiscordApi } from './http-discord-api.js'
import { flush } from '../../../test/support/fake-claude.js'
import { FakeGatewayNetwork } from '../../../test/support/fake-gateway.js'
import { FakeMinter, fakeShims } from '../../../test/support/fake-minter.js'
import { githubReach } from '../../github/reach.js'
import { noCloudReach } from '../../cloud/reach.js'
import { noDocumentReach } from '../../documents/reach.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../../../test/support/roma-fixture.js'
import { BLOCKED_WITH_OVERAGE, feed, kindOf, OK } from '../../../test/support/recorded-stream.js'

// The one place the Discord seams meet: roma assembled out of its real parts. A
// Gateway frame goes in, `GatewayTransport` decodes it, `DiscordAdapter` reads
// it, the Core runs it, and `HttpDiscordApi` turns the answer into the request
// Discord would have received. Only three things are doubles, and they are the
// three nothing here can have: Claude Code (the recorded stream), the socket,
// and the network behind the REST calls.
//
// It exists for the reason Chat's does — every other test in this repo proves one
// of these in isolation, and the failure they cannot see is the one at the joins:
// a Transport emitting events the Adapter cannot read produces a roma that runs
// perfectly and answers nobody. `bind`'s type parameter catches that at compile
// time; this catches the rest of it.
//
// It is also the only place ADR-0023's whole safety argument can be asserted,
// because that argument crosses two seams. Seam 1 knows the Core answers
// `/model opus` by moving the Session; seam 3 knows a press becomes the text
// `/model opus`. What neither proves is that the button roma *actually posted*
// carries what its own reader actually reads.
//
// The frames below are **written from Discord's documented shape, not
// captured** — there is no guild and no application here — which is the same
// footing `discord-channel.test.ts` says it stands on.

const TOKEN = 'a-bot-token'
const GATEWAY = 'wss://gateway.example/?v=10&encoding=json'
const API = 'https://discord.example/api/v10'

const ROMA = '100000000000000001'
const CALLER = '200000000000000002'
const GUILD = '300000000000000004'
/** One of the guild's own channels, so a message here is answered in a thread. */
const CHANNEL = '400000000000000005'
/** The Caller's message, whose id is the thread's and therefore the Conversation Key. */
const MESSAGE = '700000000000000009'
const CARD = '700000000000000017'
const INTERACTION = '900000000000000018'

const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma'] }

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'oauth-token' }
const METERED: Credential = { kind: 'overflow', apiKey: 'metered-key' }

/**
 * A model the Effort Matrix has never been read about.
 *
 * The only way to reach its third answer, which is what a deployment that pinned
 * something off the Model Menu has: `null` is neither yes nor no, and roma may
 * not withhold an offer on the strength of a reading it never made (ADR-0023).
 */
const UNMEASURED = 'claude-something-nobody-measured'

/** One request, as much of it as a test asserts on. */
interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Discord's own hello, and the only thing it says. */
const HELLO = { op: 10, d: { heartbeat_interval: 41_250 } }

const READY = {
  op: 0,
  s: 1,
  t: 'READY',
  d: {
    session_id: 'session-one',
    resume_gateway_url: GATEWAY,
    user: { id: ROMA, username: 'roma' },
  },
}

const GUILD_CREATE = {
  op: 0,
  s: 2,
  t: 'GUILD_CREATE',
  d: { id: GUILD, channels: [{ id: CHANNEL, type: 0 }], threads: [] },
}

function dispatch(name: string, payload: unknown, sequence = 3): unknown {
  return { op: 0, s: sequence, t: name, d: payload }
}

/**
 * A message addressed to roma, as Discord sends one.
 *
 * `channel` is the whole of which Conversation it starts: one of the guild's own
 * channels is top level and keyed on the message's *own* id — the id the thread
 * roma opens will take — and anything else is already a thread and is keyed on
 * itself. So a second message in one Conversation is one sent to `MESSAGE`.
 */
function mentioned(text: string, { id = MESSAGE, channel = CHANNEL } = {}): unknown {
  return dispatch('MESSAGE_CREATE', {
    id,
    channel_id: channel,
    guild_id: GUILD,
    author: { id: CALLER, username: 'ada', global_name: 'Ada', bot: false },
    content: `<@${ROMA}> ${text}`,
    mentions: [{ id: ROMA, username: 'roma' }],
    attachments: [],
  })
}

/** The same, in the thread the first one opened — so it is the same Conversation. */
function inThread(text: string, id: string): unknown {
  return mentioned(text, { id, channel: MESSAGE })
}

/**
 * A press on one of the buttons roma actually posted.
 *
 * Built from the `custom_id` off the request Discord would have received, so
 * that a button carrying something roma's own reader cannot read back fails
 * here — which is the whole reason this file exists.
 */
function pressing(customId: string, id = INTERACTION): unknown {
  return dispatch('INTERACTION_CREATE', {
    id,
    token: 'an-interaction-token',
    type: 3,
    application_id: ROMA,
    channel_id: MESSAGE,
    guild_id: GUILD,
    member: { user: { id: CALLER, username: 'ada', global_name: 'Ada' } },
    data: { custom_id: customId, component_type: 2 },
    // roma's own card, which is what a press always arrives carrying.
    message: {
      id: CARD,
      channel_id: MESSAGE,
      guild_id: GUILD,
      author: { id: ROMA, username: 'roma', bot: true },
      content: 'You can choose…',
    },
  })
}

/**
 * The same recorded probe Turn reporting a different model on its `system/init`.
 *
 * `withApiKeySource`'s discipline, for the one deployment this file needs and no
 * capture holds: the startup self-check compares the model the stream reports
 * against the one roma pinned, so pinning something off the Model Menu means the
 * probe has to report it. The stream is real and the one field under test is the
 * only thing changed.
 */
function reporting(model: string): readonly ClaudeEvent[] {
  return OK.map((event) => (kindOf(event) === 'system/init' ? { ...event, model } : event))
}

let running: Serving[] = []
let fixtures: RomaFixture[] = []

async function boot({ model = PINNED_MODEL }: { model?: string } = {}) {
  const fixture = romaFixture('discord-wiring')
  fixtures.push(fixture)

  // Discord with the network taken out, and nothing else taken out: the requests
  // recorded here are the ones Discord would have been sent.
  const requests: RecordedRequest[] = []
  let posted = 0
  const api = new HttpDiscordApi({
    botToken: TOKEN,
    apiBase: API,
    fetch: (input, init) => {
      const url = String(input)
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      requests.push({ url, method: init?.method ?? 'GET', body })
      posted += 1
      // A thread answers with the id of the message it was started from, which
      // is the fact the whole Conversation Key table rests on.
      const answer = url.endsWith('/threads')
        ? { id: url.split('/').at(-2) }
        : { id: `posted-${posted}` }
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }))
    },
  })

  const network = new FakeGatewayNetwork()
  const log: DiscordLogRecord[] = []
  const minter = new FakeMinter({ installation: INSTALLATION })
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const serving = serve({
    credential: OAUTH,
    reaches: { code: githubReach(minter), cloud: noCloudReach(), documents: noDocumentReach() },
    shims,
    overflow: { credential: METERED, monthlyCapUsd: 100 },
    channels: [
      bind(
        new DiscordAdapter({ api }),
        new GatewayTransport({
          token: TOKEN,
          url: GATEWAY,
          connect: network.connect,
          api,
          log: (record) => log.push(record),
          jitter: () => 1,
        }),
      ),
    ],
    ...(model === PINNED_MODEL ? {} : { model }),
    ...fixture.dirs,
    spawn: fixture.claude.spawn,
    log: () => {},
    selfCheckTimeoutMs: 1_000,
  })

  await fixture.answerProbe(model === PINNED_MODEL ? OK : reporting(model))
  const roma = await serving
  running.push(roma)

  return {
    claude: fixture.claude,
    requests,
    network,
    log,
    roma,
    /** Push one frame, and let the work behind it get as far as it can. */
    async take(frame: unknown): Promise<void> {
      network.socket.push(frame)
      await flush()
    },
    procFor: (conversationKey = MESSAGE) => fixture.procFor(conversationKey),
  }
}

/** Every message roma posted, in the order Discord would have received them. */
function said(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter(({ url, method }) => method === 'POST' && url.endsWith('/messages'))
    .map(({ body }) => String(body['content'] ?? ''))
}

/** Just enough of a posted card to read its buttons back out. */
interface PostedRow {
  readonly components: readonly { readonly label: string; readonly custom_id: string }[]
}

/** What the last card roma posted offers, in the order Discord was asked to show it. */
function buttonsOf(requests: readonly RecordedRequest[]) {
  const carrying = requests.filter(({ body }) => body['components'] !== undefined)
  const rows = (carrying.at(-1)?.body['components'] ?? []) as readonly PostedRow[]
  return rows.flatMap((row) => row.components)
}

function labelsOf(requests: readonly RecordedRequest[]): string[] {
  return buttonsOf(requests).map(({ label }) => label)
}

/** The `custom_id` off the button with this label, or a failure naming the card's. */
function customIdFor(requests: readonly RecordedRequest[], label: string): string {
  const button = buttonsOf(requests).find((candidate) => candidate.label === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button.custom_id
}

afterEach(async () => {
  await teardownRoma(
    running,
    fixtures.flatMap(({ roots }) => roots),
  )
  running = []
  fixtures = []
})

describe('a Discord message, all the way through and back', () => {
  // The first thing this Channel has to get right, over the real parts: a
  // top-level @-mention is answered in a thread opened from it, and the key
  // minted before that thread existed is the id it took.
  it('opens the thread its key names and answers in it', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()
    feed(roma.procFor(), OK)
    await until(() => said(roma.requests).includes('ok'))

    expect(roma.requests).toContainEqual({
      url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}/threads`,
      method: 'POST',
      body: { name: 'summarise this' },
    })
    // In the thread, which is the Conversation Key, and replying to the question.
    expect(roma.requests).toContainEqual({
      url: `${API}/channels/${MESSAGE}/messages`,
      method: 'POST',
      body: {
        content: 'ok',
        message_reference: { message_id: MESSAGE, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: true },
      },
    })
  })

  // The Session is derived from the Conversation Key the Adapter minted out of
  // the frame, with nothing stored in between. Getting this wrong is how every
  // message in a channel would share one context, or each get its own.
  it('runs it on the Session its Conversation Key derives to', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()

    expect(roma.claude.lastSpawn.cwd).toContain(sessionIdFor(MESSAGE))
  })
})

describe('a Menu, out as buttons and back as a press', () => {
  /**
   * The design's whole safety argument, and it crosses both seams: *pressing is
   * typing* (ADR-0023).
   *
   * What neither seam proves alone is that the button roma actually posted
   * carries what the reader actually reads — an Adapter emitting a `custom_id`
   * its own reader cannot read back gives you a roma that runs perfectly and
   * answers nobody, which is the failure this file exists for.
   */
  it('moves the Session onto the model whose button came back', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)
    // Counted rather than assumed zero: booting spawns the Startup Self-Check's
    // own probe, and what matters here is that answering `/model` adds nothing to
    // it — roma owns the answer, so no process, no Turn and no money.
    const atBoot = roma.claude.processes.length

    await roma.take(mentioned('/model'))
    expect(labelsOf(roma.requests)).toEqual(['opus', 'sonnet', 'haiku', 'default'])
    expect(roma.claude.processes).toHaveLength(atBoot)

    // The press, built out of the card roma posted. Nothing of roma's is
    // remembered between the two.
    await roma.take(pressing(customIdFor(roma.requests, 'opus')))

    // And the Session is on it, by the same path a typed `/model opus` takes —
    // asked in the thread the first message opened, which is that Conversation.
    await roma.take(inThread('hello', '700000000000000020'))
    await flush()

    expect(roma.claude.lastSpawn.args).toContain('claude-opus-5')
  })

  // The other half of the same claim: a press is answered in the Conversation it
  // was pressed in, exactly as the typed Command would have been — and it is the
  // Conversation the *button* names, not the channel the card sits in.
  it('answers the press in the Conversation the button named', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/effort'))
    expect(labelsOf(roma.requests)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])

    await roma.take(pressing(customIdFor(roma.requests, 'xhigh')))

    expect(said(roma.requests).at(-1)).toContain('xhigh')
    expect(roma.requests.at(-1)?.url).toBe(`${API}/channels/${MESSAGE}/messages`)
  })

  // Inside three seconds or the token is invalidated, and roma's Core takes
  // minutes — so the acknowledgement goes out before the press reaches anything
  // that could answer it, and it is the one that leaves the card alone.
  it('acknowledges the press before it answers it, and never edits the card', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)
    await roma.take(mentioned('/model'))
    const before = roma.requests.length

    await roma.take(pressing(customIdFor(roma.requests, 'haiku')))

    const after = roma.requests.slice(before)
    expect(after[0]).toEqual({
      url: `${API}/interactions/${INTERACTION}/an-interaction-token/callback`,
      method: 'POST',
      body: { type: 6 },
    })
    expect(after.some(({ method }) => method === 'PATCH')).toBe(false)
  })

  /**
   * **The Effort Matrix's third use, end to end** (ADR-0023). Where it answers
   * `false` the Core sends no `choice` at all, so there is nothing for the
   * Adapter to draw — roma declines to *invite* an action it has, in the same
   * message, just called inert. The typed Command is untouched, which is why
   * this is not the refusal ADR-0016 forbids.
   */
  it('draws no effort buttons on a model the Matrix says takes none', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/model haiku'))
    await roma.take(inThread('/effort', '700000000000000021'))

    expect(said(roma.requests).at(-1)).toContain('takes none')
    expect(roma.requests.some(({ body }) => body['components'] !== undefined)).toBe(false)
  })

  // The case a falsy check would break and an equality check does not. A model
  // the Matrix has never been read about answers neither yes nor no, and roma may
  // not withhold an offer on the strength of a reading it never made — the rule
  // is `Core.#effortApplies`'s `takesEffort(...) !== false`, and this is the same
  // rule seen from the far end of both seams.
  it('draws them on a model the Matrix has never been read about', async () => {
    const roma = await boot({ model: UNMEASURED })
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('/effort'))

    expect(labelsOf(roma.requests)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
    expect(said(roma.requests).at(-1)).not.toContain('takes none')
  })
})

describe('the Overflow offer, out as a button and back as a press', () => {
  // The whole round trip through the real parts, and the one thing no other test
  // covers: the Task id goes out inside a `components` payload and comes back
  // inside an interaction, through two files that have to agree about a shape
  // neither of them owns.
  //
  // It is also the only thing in roma nobody can do by typing, which is why the
  // Menus could have waited here and this could not (ADR-0029).
  it('reruns the Task on metered billing when the button comes back', async () => {
    const roma = await boot()
    await roma.take(HELLO)
    await roma.take(READY)
    await roma.take(GUILD_CREATE)

    await roma.take(mentioned('summarise this'))
    await flush()
    feed(roma.procFor(), BLOCKED_WITH_OVERAGE)
    await flush()

    expect(labelsOf(roma.requests)).toEqual(['Run it on metered billing'])

    await roma.take(pressing(customIdFor(roma.requests, 'Run it on metered billing')))
    await flush()
    feed(roma.procFor(), OK)
    await until(() => said(roma.requests).includes('ok'))

    expect(roma.claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    // What it cost is shown, which is ADR-0002's requirement of a metered reply.
    expect(said(roma.requests).at(-1)).toMatch(/metered billing/)
  })
})

/**
 * Wait for something the subscriber does detached from the frame that started it.
 *
 * A Gateway frame is not awaited by whatever pushed it — a Task takes minutes,
 * and awaiting one would stop roma reading the socket — so there is no promise
 * for a test to hold. Polling the observable result is the honest way to wait.
 */
async function until(condition: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await flush()
  }
  throw new Error('gave up waiting')
}
