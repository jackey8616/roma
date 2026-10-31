import type { OperatorLog } from '../../operator-log.js'
import { bind, type ChannelBinding } from '../../serve.js'
import { DiscordAdapter, type DiscordAdapterLogRecord } from './discord-adapter.js'
import type { DiscordEventLogRecord } from './discord-events.js'
import type { DiscordEnv } from './env-config.js'
import { GatewayTransport, type GatewayLogRecord, type GatewaySocket } from './gateway-transport.js'
import { HttpDiscordApi } from './http-discord-api.js'

export type DiscordLogRecord = GatewayLogRecord | DiscordEventLogRecord | DiscordAdapterLogRecord

export type DiscordLog = OperatorLog<DiscordLogRecord>

export function discordBinding(discord: DiscordEnv, log: DiscordLog): ChannelBinding {
  const api = new HttpDiscordApi({ botToken: discord.botToken, apiBase: discord.apiBase })

  return bind(
    new DiscordAdapter({ api, log }),
    new GatewayTransport({
      token: discord.botToken,
      url: discord.gatewayUrl,
      connect: webSocket,
      api,
      log,
    }),
  )
}

function webSocket(url: string): GatewaySocket {
  const socket = new WebSocket(url)
  return {
    send: (frame) => {
      socket.send(frame)
    },
    close: (code) => {
      socket.close(code)
    },
    on: (event: 'message' | 'close' | 'error', listener: (arg: never) => void) => {
      if (event === 'message') {
        socket.addEventListener('message', ({ data }) => {
          ;(listener as (frame: string) => void)(typeof data === 'string' ? data : String(data))
        })
        return
      }
      if (event === 'close') {
        socket.addEventListener('close', ({ code }) => {
          ;(listener as (code: number) => void)(code)
        })
        return
      }
      socket.addEventListener('error', () => {
        ;(listener as (error: Error) => void)(new Error('the Gateway socket faulted'))
      })
    },
  }
}
