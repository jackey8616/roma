import type { ESLint, Rule } from 'eslint'
import { commentWhitelist, PLUGIN_RULES } from './comment-whitelist.js'

export const rules: Record<string, Rule.RuleModule> = {
  'comment-whitelist': commentWhitelist,
}

for (const name of Object.keys(rules)) PLUGIN_RULES.add(name)

export const plugin: ESLint.Plugin = { meta: { name: 'roma' }, rules }
