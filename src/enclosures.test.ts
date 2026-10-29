import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const MINTED =
  'An Enclosure’s path must be minted by roma, carrying nothing of the sender’s name but a ' +
  'whitelisted extension (ADR-0011). The name is chosen by whoever sent the message: used as a ' +
  'path it walks out of the Working Directory, and even sanitised two people sending ' +
  '`screenshot.png` overwrite each other, leaving the first marker naming the second image. ' +
  'The extension crosses under a whitelist, never a sanitiser: a bounded charset and length ' +
  'cannot express a separator, a parent or a leading dot, so there is nothing left to strip.'

/** One Enclosure that hands over the bytes it was built with. */
function sent(name: string, content = 'bytes'): PendingEnclosure {
  return { name, from: null, redeem: () => Promise.resolve(new TextEncoder().encode(content)) }
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
  it('cannot be walked out of the Working Directory by the sender [fence:enclosures-name-is-minted]', async () => {
    const cwd = workingDirectory()

    const [written] = await writeEnclosures([sent('../../../etc/passwd')], cwd)

    expect(written!.path.startsWith('./.enclosures/'), MINTED).toBe(true)
    expect(written!.path, MINTED).not.toContain('..')
    expect(readdirSync(join(cwd, '.enclosures')), MINTED).toHaveLength(1)
  })

  // Two people in one thread paste `screenshot.png` a minute apart. Under the
  // sender's name the second would overwrite the first, and the marker naming
  // the first would then point at somebody else's image.
  it('gives two Enclosures of the same name two files [fence:enclosures-name-is-minted]', async () => {
    const cwd = workingDirectory()

    const written = await writeEnclosures(
      [sent('screenshot.png', 'first'), sent('screenshot.png', 'second')],
      cwd,
    )

    expect(written[0]!.path, MINTED).not.toBe(written[1]!.path)
    expect(readFileSync(join(cwd, written[0]!.path), 'utf8'), MINTED).toBe('first')
    expect(readFileSync(join(cwd, written[1]!.path), 'utf8'), MINTED).toBe('second')
  })

  it('stays out of the way of a clone in the Working Directory [fence:enclosures-out-of-the-agents-way]', async () => {
    const why =
      'Enclosures must be written into a dot-prefixed subdirectory of the Working Directory, ' +
      'never its root and never an undotted directory: the root is the agent’s to clone into ' +
      '(ADR-0008), and a repository of the same name would collide with them (ADR-0011; #92).'
    const cwd = workingDirectory()
    // The agent's clones, under every name the directory could plausibly have had.
    for (const clone of ['enclosures', 'attachments', 'uploads']) {
      mkdirSync(join(cwd, clone))
      writeFileSync(join(cwd, clone, 'README.md'), 'a repository')
    }

    await writeEnclosures([sent('screenshot.png'), sent('notes.txt')], cwd)

    const added = readdirSync(cwd).filter(
      (name) => !['enclosures', 'attachments', 'uploads'].includes(name),
    )
    expect(added, why).toHaveLength(1)
    expect(added[0]!.startsWith('.'), why).toBe(true)
    for (const clone of ['enclosures', 'attachments', 'uploads']) {
      expect(readdirSync(join(cwd, clone)), why).toEqual(['README.md'])
    }
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
      from: null,
      redeem: () => Promise.reject(new Error('roma has no Drive scope')),
    }

    await expect(writeEnclosures([unreachable], cwd)).rejects.toThrow('no Drive scope')
  })
})
