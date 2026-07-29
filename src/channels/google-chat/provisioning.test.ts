import { describe, expect, it } from 'vitest'
import { sources } from '../../../test/support/sources.js'

/**
 * "roma provisions nothing" is a claim, and this is where it is kept.
 *
 * The topic, the subscription, the service account and the grant that lets Chat
 * publish are all made by `infra/`, which is Terraform somebody runs by hand.
 * ADR-0004 and `readChatEnv` both say roma only reads them, and the reason is
 * not tidiness: a program that could create its own subscription is a program
 * that can silently create the wrong one and then sit listening to it, answering
 * nobody while looking perfectly healthy.
 *
 * Enforced by reading the sources, in the idiom `src/core.test.ts` uses for the
 * Channel-name denylist, and for the same reason — the day it stops being true
 * is a day nobody would otherwise notice.
 *
 * Unlike that one, this binds `src/channels/` too: `main.ts`, where the `PubSub`
 * client is actually constructed, is the file most able to break it.
 */
describe('roma provisions nothing', () => {
  it('has no code that could create a Pub/Sub resource, write a grant, or run the Terraform', () => {
    const offenders = sources().filter(({ source }) =>
      PROVISIONING.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

/**
 * Every way `src/` could stop only reading.
 *
 * Three groups. The Pub/Sub admin surface — `PubSub.createTopic`, `Topic.create`
 * and their neighbours; the bare `.create(` is the widest of them, since the
 * client library spells creation that way on every resource it has, and
 * `Object.create` is excused because it is the one common call that is not
 * provisioning anything. Then the grants, which are resources too: ADR-0004's
 * boundary is not held by a roma that creates no topic but hands itself
 * `roles/pubsub.subscriber`. Then roma running the Terraform, which would make
 * provisioning something roma does at runtime by a longer route.
 *
 * The last group matches a `terraform` that is being *invoked* — a subcommand, or
 * the name as a string literal on its way to a spawn — rather than the word. A
 * comment pointing a reader at `infra/` is the documentation working, not the
 * boundary breaking.
 */
const PROVISIONING = [
  /\bcreateTopic\b/,
  /\bcreateSubscription\b/,
  /\bcreateSchema\b/,
  /\bcreateSnapshot\b/,
  /(?<!\bObject)\.create\s*\(/,
  /\bsetIamPolicy\b/,
  /\bsetPolicy\b/,
  /\bterraform\s+(init|plan|apply|destroy)\b/i,
  /['"`]terraform['"`\s]/i,
]
