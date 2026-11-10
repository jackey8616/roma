import { createServer, isIP, type AddressInfo, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DIRECT_PROBES, probeDirectEgress } from './route.js'

let open: Server
let openPort: number
let closedPort: number

beforeAll(async () => {
  open = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve))
  openPort = (open.address() as AddressInfo).port
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  closedPort = (closed.address() as AddressInfo).port
  await new Promise<void>((resolve) => closed.close(() => resolve()))
})

afterAll(async () => {
  await new Promise<void>((resolve) => open.close(() => resolve()))
})

describe('probeDirectEgress', () => {
  it('reports a way out when any one target answers, though the others do not [fence:egress-probe-any-target-is-a-way-out]', async () => {
    const why =
      'GHSA-7hpq-f638-956r: one blocked or mis-resolved host is not an isolated network. ' +
      'With api.anthropic.com pointed at loopback, the single-host probe said "isolated" ' +
      'and roma started on a network that reached example.com directly.'
    const reached = await probeDirectEgress([
      { host: '127.0.0.1', port: closedPort },
      { host: '127.0.0.1', port: openPort },
    ])

    expect(reached, why).toBe(true)
  })

  it('reports no way out only when every target fails', async () => {
    expect(await probeDirectEgress([{ host: '127.0.0.1', port: closedPort }])).toBe(false)
  })

  it('probes at least one address by number, which no name resolution can redirect [fence:egress-probe-includes-an-address]', () => {
    const why =
      'A host name can be pointed anywhere by --add-host, /etc/hosts or a failing resolver; ' +
      'an address literal cannot, so a network that lets roma out by address is still seen.'

    expect(
      DIRECT_PROBES.some((target) => isIP(target.host) !== 0),
      why,
    ).toBe(true)
  })
})
