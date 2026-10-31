import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MENU } from '../src/model-menu.js'
import { effortMatrix, matrixReport } from './claude-code-effort-matrix.js'

try {
  main()
} catch (error) {
  console.error(
    `claude-code effort matrix failed: ${error instanceof Error ? error.message : error}`,
  )
  process.exit(1)
}

function main(): void {
  const bundle = process.argv[2] ?? locateClaude()
  console.error(`reading ${bundle}`)
  const source = readFileSync(bundle, 'latin1')
  const { rows, gates } = effortMatrix(source, Object.values(MENU))
  console.log(matrixReport(rows, gates))
}

function locateClaude(): string {
  try {
    const onPath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
    return execFileSync('readlink', ['-f', onPath], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      'no `claude` on PATH, and no bundle path given — pass one as an argument: ' +
        'npm run check:claude-code-effort-matrix -- /path/to/claude',
    )
  }
}
