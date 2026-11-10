import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function shimBesideThisFile(): string {
  const here = fileURLToPath(import.meta.url)
  return here.replace(/shims\.(m?[jt]s)$/, 'git-credential-shim.$1')
}

function loaderFor(shim: string): string {
  if (!shim.endsWith('.ts') && !shim.endsWith('.mts')) return ''
  return ` --import ${createRequire(import.meta.url).resolve('tsx')}`
}

export function gitCredentialHelper(shim = shimBesideThisFile(), node = process.execPath): string {
  return `!${node}${loaderFor(shim)} ${shim}`
}

export function gitConfig(helper = gitCredentialHelper()): string {
  return ['[credential]', `\thelper = ${helper}`, '\tuseHttpPath = true', ''].join('\n')
}
