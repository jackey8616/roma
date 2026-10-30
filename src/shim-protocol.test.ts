import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR } from './shim-protocol.js'

/** The non-test files under `src/` whose code, not counting comments, spells `text` as a string. */
function spelledIn(text: string): string[] {
  const src = fileURLToPath(new URL('.', import.meta.url))
  return globSync('**/*.ts', { cwd: src })
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(src + file, 'utf8'),
        ts.ScriptTarget.Latest,
      )
      let found = false
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text.includes(text)) found = true
        ts.forEachChild(node, visit)
      }
      visit(source)
      return found
    })
}

describe('the variables a Session finds roma by', () => {
  it('are spelled once, where roma sets them and the Shims read them [fence:shim-variables-named-once]', () => {
    const why =
      'roma sets these variables in buildEnv and the Shims read them in shim-client; both import ' +
      'the one constant in shim-protocol.ts. A second spelling of the string is a second place ' +
      'for it to drift, and a Shim that looks for a name roma never sets has no roma to ask ' +
      'for a credential (ADR-0008).'

    for (const name of [MINTER_SOCKET_VAR, SESSION_ID_VAR]) {
      expect(spelledIn(name), `${name}: ${why}`).toEqual(['shim-protocol.ts'])
    }
  })
})
