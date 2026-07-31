import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PendingEnclosure } from './channel-adapter.js'
import { writeEnclosures } from './enclosures.js'

let roots: string[] = []

function workingDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'roma-enclosures-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

/** One Enclosure that hands over the bytes it was built with. */
function sent(name: string, content = 'bytes'): PendingEnclosure {
  return { name, redeem: () => Promise.resolve(new TextEncoder().encode(content)) }
}

describe('writing an Enclosure into a Working Directory', () => {
  it('puts the bytes where it says it has', async () => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent('screenshot.png', 'PNG')], cwd)

    expect(readFileSync(join(cwd, written!.path), 'utf8')).toBe('PNG')
  })

  it('keeps what the sender called it, beside the path rather than as one', async () => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent('nginx-error.log')], cwd)

    expect(written!.name).toBe('nginx-error.log')
    expect(written!.path).not.toContain('nginx-error')
  })

  // The reason ADR-0011 mints a path at all. `contentName` is chosen by whoever
  // sent the message, so a name used as a path is a way out of the Working
  // Directory — and out of it is where the Transcript and roma's own files are,
  // which is not somewhere the agent's own shell already reaches.
  it('cannot be walked out of the Working Directory by the sender', async () => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent('../../../etc/passwd')], cwd)

    expect(written!.path.startsWith('./.enclosures/')).toBe(true)
    expect(written!.path).not.toContain('..')
    expect(readdirSync(join(cwd, '.enclosures'))).toHaveLength(1)
  })

  // Two people in one thread paste `screenshot.png` a minute apart. Under the
  // sender's name the second would overwrite the first, and the marker naming
  // the first would then point at somebody else's image.
  it('gives two Enclosures of the same name two files', async () => {
    const cwd = workingDirectory()

    const written = await writeEnclosures(
      [sent('screenshot.png', 'first'), sent('screenshot.png', 'second')],
      cwd,
    )

    expect(written[0]!.path).not.toBe(written[1]!.path)
    expect(readFileSync(join(cwd, written[0]!.path), 'utf8')).toBe('first')
    expect(readFileSync(join(cwd, written[1]!.path), 'utf8')).toBe('second')
  })

  // Carried across because tools dispatch on it, and an image written as `.bin`
  // may simply not be read as one.
  it('keeps the extension', async () => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent('Diagram.PNG')], cwd)

    expect(written!.path.endsWith('.png')).toBe(true)
  })

  // The whitelist, from the other side: anything that could express a separator,
  // a parent or a second extension is not one, and gets none.
  it.each([
    ['no dot at all', 'Makefile'],
    ['a separator in it', 'passwd../../etc'],
    ['longer than an extension', 'archive.averylongsuffix'],
    ['nothing after the dot', 'trailing.'],
  ])('gives no extension to a name with %s', async (_, name) => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent(name)], cwd)

    expect(/\.[A-Za-z0-9]+$/.test(written!.path)).toBe(false)
  })

  it('writes nothing and makes no directory for a message with none', async () => {
    const cwd = workingDirectory()

    expect(await writeEnclosures([], cwd)).toEqual([])
    expect(readdirSync(cwd)).toEqual([])
  })

  // The failure ADR-0011 routes through the Task rather than swallowing. For a
  // Channel with a class of attachment it cannot reach — Chat's `driveDataRef` —
  // this is the normal path, and a Task that ended with a reason is the point.
  it('rejects when an Enclosure cannot be fetched', async () => {
    const cwd = workingDirectory()
    const unreachable: PendingEnclosure = {
      name: 'design.fig',
      redeem: () => Promise.reject(new Error('roma has no Drive scope')),
    }

    await expect(writeEnclosures([unreachable], cwd)).rejects.toThrow('no Drive scope')
  })
})
