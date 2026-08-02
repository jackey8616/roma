/**
 * The Claude Code commands roma hands over as themselves.
 *
 * A Relay is named by what roma does with it rather than by what it costs
 * (ADR-0012, ADR-0018): roma relays it to the Session's process instead of
 * giving it to the model to read. The list spans two cost classes and the name
 * says nothing about either, which is the point — a term defined by one build's
 * behaviour is a term that turns false on somebody else's release, and
 * `shared-window.ts` is already a case of that.
 *
 * **Called a Readout until ADR-0018.** That name was true of four entries that
 * each read a value out, and became a lie the moment one of them discarded sixty
 * thousand tokens of conversation and billed several times a quiet Turn. ADR-0012
 * was careful that the *definition* would not rot and left the *name* naming its
 * members' behaviour; widening the membership is what made the name the exact
 * kind of claim that ADR was written to prevent.
 *
 * **This list is a person's judgement about Claude Code 2.1.220** — the ADR-0007
 * pin, and the build every entry below was measured on. The version is named here
 * so the drift report's working-tree sweep lists this file under what rests on
 * the pin, which is what ADR-0012 left open: "roma now has a list that must be
 * re-audited whenever the ADR-0007 pin moves. Nothing enforces that." It still
 * does not enforce it. What changes is that the re-audit list stops being
 * something somebody has to remember and becomes something the report prints.
 * `src/model-menu.ts` carries the same line for the same reason. Since ADR-0018
 * that re-audit asks each entry a second question — not only "is this still safe"
 * but "does it still cost what the table says".
 *
 * **The membership rule: a Relay is non-interactive, and it changes nothing roma
 * holds a belief about.** ADR-0012's rule said "read-only, non-interactive,
 * drives no Turn, changes no state of the Session or of Claude Code"; two of
 * those four are gone and the last is rewritten, because it was a claim about
 * *Claude Code's* state, which moves on somebody else's release schedule. What
 * roma believes is a list rather than a judgement:
 *
 * | roma believes | broken by |
 * | --- | --- |
 * | which session id this Conversation resumes to | `/clear` |
 * | which model this Session runs on | `/model` |
 * | which effort it runs at | `/effort` |
 * | what the settings file every Session shares says | `/config` |
 * | that auto-compaction is on, as a decision roma made | `/autocompact` |
 * | **what is in the context** | **nobody — roma never reads the Transcript** |
 *
 * The last row is why `/compact` is here, and it is here as a consequence of the
 * rule rather than as an exception carved for it: `/compact` changes Claude
 * Code's state and changes nothing that is roma's.
 *
 * Applied by a person, and re-applied whenever the pin moves — nothing in the
 * stream marks a command as safe, so this cannot be checked by machine. Exactly
 * one part of it can: that no string here is also a Command, which is what keeps
 * the dangerous spellings out of reach by construction rather than by name, and
 * `relays.test.ts` asserts it against the real table.
 *
 * A whitelist rather than a denylist, and that is the decision rather than the
 * shortcut. Under a denylist a release that adds a destructive non-interactive
 * command adds it to roma as permitted; under this, the same release adds one
 * that does not work until somebody puts it here. It fails closed. The pool a
 * denylist would have to keep up with is populated and dangerous — `/clear`
 * moves Claude Code to a session roma does not know about, `/model` takes a
 * Session off the model roma believes it is on, `/config` sets anything at all —
 * and every one of those is free and non-interactive on the pinned build.
 *
 * `/clear` is out of reach twice over since ADR-0013, and `/model` since
 * ADR-0014: both are roma's own Commands now, and the Core reads a Command before
 * it consults this list. `/model` is the sharper of the two — relayed, the choice
 * would live in a process that ends at Eviction, so what a Caller would get is a
 * setting that reverts at a moment they cannot see rather than model switching.
 */

/**
 * What one entry is expected to cost, which is what decides how it is governed.
 *
 * Not part of what a Relay *is* — ADR-0018's whole argument is that the shape a
 * message takes on the wire and what governs it are different axes — but roma
 * has to hold an expectation in order to be surprised by it, and the drift check
 * in the Core is what does the being surprised.
 */
export type RelayCost =
  /**
   * Answers locally: no model work, no money, milliseconds.
   *
   * Governed exactly as ADR-0012 left it — serialised against its Session,
   * outside the concurrency cap, acknowledged only where it cannot answer at
   * once, and out of `/stop`'s reach.
   */
  | 'free'
  /**
   * Drives a Turn, so it is governed as a Task in every respect: queued, counted
   * against the cap of three, stoppable, Parkable, Overflowable and audited.
   *
   * Nothing is invented for it. ADR-0012 bought the free entries' exemption from
   * the cap by arguing "no Turn, no money, no retry", and not one clause of that
   * survives a twenty-second, five-cent Turn.
   */
  | 'paid'

/**
 * Every string roma relays, and what each is expected to cost.
 *
 * The cost class is a claim about the pinned build and is checked two ways: a
 * seam 2 case per entry, which fires before a deploy, and the drift check the
 * Core runs on every free Relay, which fires after. Both are needed —
 * `/autocompact`'s own gate is a remote experiment flag, so Claude Code's
 * behaviour can move under a fixed binary, and a pin-move ritual alone assumes
 * the binary is the whole contract.
 */
const RELAYS: Readonly<Record<string, RelayCost>> = {
  // Show current context usage: how full this Session's context window is.
  '/context': 'free',
  // Show session cost, plan usage, and activity stats — with `/cost` and
  // `/stats`, which Claude Code declares as aliases of it. The aliases are here
  // because leaving them out reproduces exactly the fault ADR-0012 exists to
  // fix, only for two more strings: somebody types `/cost` and is billed for a
  // plausible sentence about what `/cost` would have said.
  '/usage': 'free',
  '/cost': 'free',
  '/stats': 'free',
  // Replace this Session's conversation with a summary, keeping what the Caller
  // asked to keep. The first entry that costs money, and the whole of ADR-0018.
  // One spelling: the pinned build's descriptor declares no aliases, so
  // ADR-0013's fault — a spelling roma leaves unclaimed is one somebody is
  // billed for — has nothing to bite on here.
  '/compact': 'paid',
}

/**
 * The heads that may be followed by an argument, and nothing else may.
 *
 * The shape is `commands.ts`'s and its defence carries over verbatim: what
 * ADR-0003 rejected was a *general* "begins with a slash and looks like ours"
 * rule, because such a rule inherits every command a later release adds. A named
 * list does not grow on its own — which is a thing somebody has to keep true
 * rather than an observation about the number of entries.
 *
 * `/compact` alone, and it is here because dropping the argument would leave it
 * differing from auto-compaction only in *timing*. "What gets kept" is the other
 * half of the want, and it is the half upstream's own warning advertises:
 * "Autocompact will trigger soon, which discards older messages. Use `/compact`
 * now to control what gets kept."
 */
const TAKES_AN_ARGUMENT: readonly string[] = ['/compact']

/** One Relay as it was typed: which command, what followed it, what it costs. */
export interface RelayRequest {
  /** The canonical spelling from the table, which is what goes on the wire. */
  readonly command: string
  /**
   * What followed the head, **verbatim** — case, newlines and all. Null where
   * nothing did.
   *
   * Unlike a Command's argument, which is lowercased and checked against a Menu.
   * This one is prose for a summariser and roma validates none of it: `/model
   * opus` has the Model Menu to check against, and `keep the architecture
   * decisions` has nothing. Not an escalation — the same person can already put
   * any text in front of the model as a Task — but a real consequence in a shared
   * thread, since one person's instructions decide what survives for everybody.
   * The Audit Record answers it afterwards, and nothing announces it at the time.
   *
   * roma does not inspect it for marker-shaped text either. Naming another person
   * in a compaction instruction — "keep what Bob said about the deploy" — is the
   * feature working, so a rule that treats a name as suspicious fights the thing
   * it is protecting.
   */
  readonly argument: string | null
  readonly cost: RelayCost
}

/**
 * Read a message as a Relay, or null if it is not one.
 *
 * Either the whole message is an entry, or it is an argument-taking head and
 * everything after the first run of whitespace is its argument. The whole-message
 * half is ADR-0012's and carries the safety of the marker's placement: because an
 * exact match is required there, what roma puts on the wire is a string from the
 * table above rather than anything a person typed, which is what makes writing
 * the Caller Marker *after* it safe — there is no Caller text for a forged marker
 * to hide in.
 *
 * Case is ignored on the head, and the canonical spelling is what gets sent. A
 * phone keyboard capitalises the first letter of a message on its own, and
 * `/Context` is nobody asking for something else. The **argument** is left
 * exactly as it was typed: it is an instruction to a summariser rather than a
 * name to be matched, and lowercasing somebody's prose would be roma editing what
 * they asked to keep.
 */
export function readRelay(text: string): RelayRequest | null {
  const message = text.trim()

  const whole = RELAYS[message.toLowerCase()]
  if (whole !== undefined) return { command: message.toLowerCase(), argument: null, cost: whole }

  // The first run of whitespace ends the head; every character after it is the
  // argument. `[\s\S]` rather than `.` so a multi-line instruction survives —
  // Claude Code splits the same way and carries the inner newlines through to
  // the summariser, measured.
  const split = /^(\S+)\s+([\s\S]+)$/.exec(message)
  if (split === null) return null
  const head = (split[1] ?? '').toLowerCase()
  const argument = split[2] ?? ''
  if (!TAKES_AN_ARGUMENT.includes(head)) return null

  const cost = RELAYS[head]
  return cost === undefined ? null : { command: head, argument, cost }
}

/**
 * Every spelling on the list, in the order the table declares them.
 *
 * Exported for the two checks that have to read the real table rather than a
 * copy of it: that no string here is also a Command — the one machine-checkable
 * half of the membership rule — and the seam 2 case that asserts each entry's
 * cost class against the pinned build.
 */
export function relaySpellings(): readonly string[] {
  return Object.keys(RELAYS)
}
