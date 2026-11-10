import { isDnsName } from './egress-proxy.js'

export const AGENT_ALLOWLIST = ['registry.npmjs.org'] as const

export function isPattern(pattern: string): boolean {
  return isDnsName(pattern.startsWith('*.') ? pattern.slice(2) : pattern)
}

export function allows(patterns: readonly string[]): (host: string) => boolean {
  const exact = new Set(patterns.filter((pattern) => !pattern.startsWith('*.')))
  const suffixes = patterns
    .filter((pattern) => pattern.startsWith('*.'))
    .map((pattern) => pattern.slice(1))
  return (host) => exact.has(host) || suffixes.some((suffix) => host.endsWith(suffix))
}

export function agentAllowlist(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set([...AGENT_ALLOWLIST, ...groups.flat()])]
}
