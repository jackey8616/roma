import { describe, expect, it } from 'vitest'
import { RecordingChatApi } from '../../test/support/recording-chat-api.js'
import type { OutboundInstruction } from '../channel-adapter.js'
import { CAVEMAN_NAMES } from '../caveman.js'
import { readCommand } from '../commands.js'
import { EFFORT_NAMES } from '../effort-menu.js'
import { MENU_NAMES } from '../model-menu.js'
import {
  chooseId,
  readChosenOption as readDiscordChoice,
  type DiscordEvent,
} from './discord/discord-events.js'
import type { ChatAction } from './google-chat/chat-api.js'
import { readChosenOption as readChatChoice, type ChatEvent } from './google-chat/chat-events.js'
import { GoogleChatAdapter } from './google-chat/google-chat-adapter.js'

/**
 * The union a `choice` names its Command with, which is the whole mechanism
 * below: a `Record` over it is exhaustive, so widening it fails this file's
 * build.
 */
type Menu = Extract<OutboundInstruction, { kind: 'choice' }>['chooses']

/**
 * Every Menu roma has, keyed on the union the Core offers them by.
 *
 * **Never make this a list.** A `Record` over the union is what stops compiling
 * the day somebody widens `chooses` and adds no entry; a list is what would go
 * on covering three Menus out of four, which is the fault this file exists for.
 */
const MENUS: Record<Menu, readonly string[]> = {
  model: MENU_NAMES,
  effort: EFFORT_NAMES,
  caveman: CAVEMAN_NAMES,
}

/**
 * The same Menus named outright, and what the round trips below iterate.
 *
 * **Not `Object.keys(MENUS)`**, for two reasons that are one reason: that answers
 * `string[]`, which neither `chooseId` nor a `choice` instruction will take, and
 * a loop driven off the table it is checking passes over an emptied one. The
 * assertion joining the two is what makes a fourth Menu added to `MENUS` and
 * forgotten here a failure rather than a Menu nothing tests.
 */
const EVERY_MENU: readonly Menu[] = ['model', 'effort', 'caveman']

/** roma's own id on Discord, which a press never reads. */
const SELF = '800000000000000001'
const DISCORD_CALLER = '700000000000000002'
/** The Conversation Key the button carries, which is what makes a press self-describing. */
const DISCORD_CONVERSATION_KEY = '900000000000000003'

const CHAT_SPACE = 'spaces/AAAA'
const CHAT_THREAD = `${CHAT_SPACE}/threads/thread-1`
const CHAT_CALLER = 'users/17'

/**
 * One name off a Menu, as Discord writes it onto a button and reads it back.
 *
 * A true round trip: `chooseId` is what `choiceButtons` writes with, and both it
 * and the reader are exported, so nothing here re-implements either half.
 */
function readBackByDiscord(chooses: Menu, option: string): string | null {
  const event: DiscordEvent = {
    // roma's own card. Nothing on a press is read off it — the person is on the
    // event and the Conversation Key is on the button (ADR-0023).
    message: {},
    self: SELF,
    guildChannel: false,
    quotation: null,
    press: {
      caller: DISCORD_CALLER,
      callerName: 'Ada',
      customId: chooseId(chooses, DISCORD_CONVERSATION_KEY, option),
    },
  }
  return readDiscordChoice(event)?.text ?? null
}

/**
 * Every name on one Menu, as Chat draws it on a card and reads it back.
 *
 * Through the real Adapter because Chat's writer is `#choices`, which is
 * private: a card built here would be a copy of the shape the writer produces,
 * and `relays.test.ts` records what such a copy costs — the hardcoded one it
 * replaced held four of eight spellings and went on passing while covering half
 * the table. **Never export `#choices` to shorten this.** That widens a
 * Channel's surface to suit a test, and the recording double exists for exactly
 * this.
 */
async function readBackByChat(
  chooses: Menu,
  options: readonly string[],
): Promise<(string | null)[]> {
  const api = new RecordingChatApi()
  const adapter = new GoogleChatAdapter({ api })

  await adapter.deliver({
    kind: 'choice',
    text: 'pick one',
    chooses,
    options,
    refused: null,
    taskId: 'task-1',
    conversationKey: CHAT_THREAD,
    caller: CHAT_CALLER,
    callerName: 'Ada',
  })

  // The last message, because that is the one the buttons go under: an answer
  // long enough to split would otherwise repeat the Menu under every piece.
  const actions = api.messages.at(-1)?.posted.actions ?? []
  return actions.map(pressed)
}

/**
 * One button off a recorded card, pressed, as Chat documents an interaction
 * event.
 *
 * The whole `ChatAction` rather than its two halves, because the point is that
 * neither is the test's: both come off the card the Adapter recorded, which is
 * the part a hand-built event would have quietly copied. Only the envelope
 * around them is written here.
 */
function pressed(button: ChatAction): string | null {
  const event: ChatEvent = {
    type: 'CARD_CLICKED',
    // Whoever pressed, who is never the card's own sender.
    user: { name: CHAT_CALLER, displayName: 'Ada' },
    space: { name: CHAT_SPACE, type: 'ROOM', spaceType: 'SPACE' },
    message: { name: `${CHAT_SPACE}/messages/msg-9`, thread: { name: CHAT_THREAD } },
    common: { invokedFunction: button.action, parameters: button.parameters },
  }
  return readChatChoice(event)?.text ?? null
}

/**
 * A Menu the Core can offer in a `choice` must be readable back by every Channel
 * that draws it, as the Command a Caller would have typed (ADR-0023).
 *
 * A structural invariant rather than a behaviour test, in the idiom
 * `commands.test.ts` describes for itself — a claim about this repository,
 * belonging to none of the three seams.
 *
 * That file holds the invariant one door away: every *name* on a Menu
 * round-trips through the Command reader. What nothing held is which *Commands*
 * have a Menu. The list lives in several places and the compiler sees almost
 * none of it — `chosen()` and Chat's reader check theirs at runtime — so half a
 * widening compiles clean, and half a widening is a Channel that draws a button
 * and then refuses the press. Nothing fails, nothing is logged, and a Caller
 * waits forever: the ADR-0023 fault the button design exists to prevent. #191
 * merging into #192 put the tree in exactly that state between two commits.
 *
 * **The compiler carries the exhaustiveness.** `MENUS` is a `Record` over the
 * same union `choice.chooses` uses, so a fourth Menu fails this file's build
 * until somebody adds the entry — and the entry then fails the round trips below
 * until both Adapters are widened too.
 *
 * Here rather than in either Channel's directory, on the precedent
 * `src/channels/main.ts` set: something that names two Channels for the same
 * reason belongs to neither of them. `src/core.test.ts`'s denylist would permit
 * it in `commands.test.ts`, since `coreSources()` excludes the tests — but that
 * is the letter of the rule against its spirit, and it would leave the Core's own
 * test file naming two Channels.
 *
 * **What this does not catch**, both of them for one reason — it keys on
 * `chooses`, which is the thing the Adapters must agree with. A `Command`
 * widened in `commands.ts` and `choice.chooses` left behind is a Core-internal
 * mismatch and passes here. So does a Channel that runs *ahead* of the Core: a
 * reader widened to a Menu nothing offers leaves the table below unchanged, and
 * every loop goes on passing. That direction is the inert half — a `custom_id`
 * arrives only on a card roma posted, so a Menu the Core never draws is a
 * Command with no door to reach it through, which is why the two Adapters say so
 * in prose (`chosen()`, `readChosenOption`) and this says so here.
 */
describe('a Menu the Core offers, read back by every Channel that draws it', () => {
  // From the identifier Discord actually writes onto a button, back through
  // Discord's own reader. A name that does not survive the trip is a press that
  // reaches the Core as nothing at all.
  it('is read back by Discord as the Command a Caller would have typed', () => {
    for (const chooses of EVERY_MENU) {
      for (const option of MENUS[chooses]) {
        expect(readCommand(readBackByDiscord(chooses, option) ?? '')).toEqual({
          command: chooses,
          argument: option,
        })
      }
    }
  })

  // The same claim on the other Channel, off the card the Adapter posted rather
  // than one written here. What comes out has to be the same message Discord's
  // press produced, because it is the same Command a Caller would have typed.
  it('is read back by Chat as the same Command, off the card it actually posted', async () => {
    for (const chooses of EVERY_MENU) {
      const names = MENUS[chooses]
      const texts = await readBackByChat(chooses, names)

      // One button per name. A card that drew fewer would otherwise shorten the
      // loop rather than fail it.
      expect(texts).toHaveLength(names.length)
      for (const [at, option] of names.entries()) {
        expect(readCommand(texts[at] ?? '')).toEqual({ command: chooses, argument: option })
      }
    }
  })

  // The second half of the check `commands.test.ts` gives itself: an assertion
  // that passes over an empty table is worse than no assertion. The first line
  // is what carries the compiler's exhaustiveness into the loops above — a Menu
  // the `Record` forced somebody to add and nothing drove fails here. What each
  // Menu *holds* is named outright in `commands.test.ts`, so this asks only that
  // none of them is empty.
  //
  // Sorted, because the claim is coverage and not order: reordering `MENUS` is a
  // no-op edit, and one that failed a test would teach somebody to distrust it.
  it('covers every Menu in the table, and finds none of them empty', () => {
    expect([...EVERY_MENU].sort()).toEqual(Object.keys(MENUS).sort())
    for (const chooses of EVERY_MENU) expect(MENUS[chooses].length).toBeGreaterThan(0)
  })
})
