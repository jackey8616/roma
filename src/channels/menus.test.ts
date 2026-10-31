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

type Menu = Extract<OutboundInstruction, { kind: 'choice' }>['chooses']

const MENUS: Record<Menu, readonly string[]> = {
  model: MENU_NAMES,
  effort: EFFORT_NAMES,
  caveman: CAVEMAN_NAMES,
}

const EVERY_MENU: readonly Menu[] = ['model', 'effort', 'caveman']

const SELF = '800000000000000001'
const DISCORD_CALLER = '700000000000000002'
const DISCORD_CONVERSATION_KEY = '900000000000000003'

const CHAT_SPACE = 'spaces/AAAA'
const CHAT_THREAD = `${CHAT_SPACE}/threads/thread-1`
const CHAT_CALLER = 'users/17'

function readBackByDiscord(chooses: Menu, option: string): string | null {
  const event: DiscordEvent = {
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

  const actions = api.messages.at(-1)?.posted.actions ?? []
  return actions.map(pressed)
}

function pressed(button: ChatAction): string | null {
  const event: ChatEvent = {
    type: 'CARD_CLICKED',
    user: { name: CHAT_CALLER, displayName: 'Ada' },
    space: { name: CHAT_SPACE, type: 'ROOM', spaceType: 'SPACE' },
    message: { name: `${CHAT_SPACE}/messages/msg-9`, thread: { name: CHAT_THREAD } },
    common: { invokedFunction: button.action, parameters: button.parameters },
  }
  return readChatChoice(event)?.text ?? null
}

describe('a Menu the Core offers, read back by every Channel that draws it', () => {
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

  it('is read back by Chat as the same Command, off the card it actually posted', async () => {
    for (const chooses of EVERY_MENU) {
      const names = MENUS[chooses]
      const texts = await readBackByChat(chooses, names)

      expect(texts).toHaveLength(names.length)
      for (const [at, option] of names.entries()) {
        expect(readCommand(texts[at] ?? '')).toEqual({ command: chooses, argument: option })
      }
    }
  })

  it('covers every Menu in the table, and finds none of them empty', () => {
    expect([...EVERY_MENU].sort()).toEqual(Object.keys(MENUS).sort())
    for (const chooses of EVERY_MENU) expect(MENUS[chooses].length).toBeGreaterThan(0)
  })
})
