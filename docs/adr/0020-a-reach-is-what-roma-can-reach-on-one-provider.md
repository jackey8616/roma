# 20. A Reach is what roma can reach on one provider

Date: 2026-08-02

## Status

Accepted, and implemented by the change that carries it. Nothing here was measured
and nothing here cost money: it is a decision about shape, and the one thing that
could have made it unbuildable — a consumer of what roma reports at boot — turned
out not to exist. See §4.

**Generalises ADR-0008's Installation and ADR-0015's Cloud Reach into one term.**
Neither is re-litigated. An Installation is still the only boundary there is on the
forge and still required; a Cloud Reach is still optional, still without an
inventory, and still not the identity roma runs on. What changes is that they stop
being two parallel arrangements that happen to rhyme and become two instances of
one thing roma has a name for.

**Amends ADR-0015 §4 in how it is enforced, not in what it says.** The source-match
test that carried it is deleted, and §7 below is why that is a strengthening rather
than a removal. That is the paragraph of this ADR most likely to be read by
somebody about to undo it.

## Context

roma reaches two providers. Below the seam that matters this is already one idea:
`MintsTokens` has two adapters, and `FreshTokens` — the refresh margin, the
single-flight mint, the discard-with-cooldown — is written once against it and paid
back twice. That part works and is untouched.

Above that seam it is written twice. `startRoma` has taken two differently shaped
option objects, two boot proofs written two ways, two failure types, two result
fields, a log record union that names one of the two providers, and a per-Task
recorder that exists on one side only. The asymmetries each had a reason when they
arrived; what none of them had was a shared shape to be an exception to.

The cost is measurable against the other seam in the same file. A second Channel
costs **zero** edits to `startup.ts` — `channel: ChannelAdapter` is one field, and
`serve.ts` pairs Adapter and Transport under one type variable. A second credential
provider cost roughly **ten** structural edits to `startup.ts` and touched eight
files. Two seams in one composition root, one of which is a list and one of which
is a pair of named slots.

There is also a safety property with nowhere to live. ADR-0015 §4 says roma mints
from the key file it was named and never from a resolution chain, and the rule that
binds `src/cloud/` cannot bind the composition root — that is the one file where
both identities are legitimately in scope. So the property was carried by
`expect(root).toContain('new GoogleCloudMinter(cloudEnv)')`, a match against source
text that the test's own comment admits a rename of a local would break.

## Decision

### 1. The term is Reach, and Installation and Cloud Reach are its two instances

A **Reach** is what roma can reach on one provider at all: the credential that
reaches it, what it reaches, and what every Session is told about it.

The name is not invented for this. ADR-0008 and ADR-0015 already argued the same
paragraph twice — *a term that is the whole of a security property should be a
term* — and CONTEXT.md's Cloud Reach entry already said the two are "the same idea
on two providers". What was missing was a name for the idea rather than for each
instance. `provider` is not it: that word names the company on the other end, and
CONTEXT.md's Minter entry already lists "credential provider" as a thing to avoid.

A Minter remains the half of a Reach that holds the key. That is the narrower term
and it keeps its narrower rule.

### 2. An unconfigured Reach is unavailable, never absent

ADR-0015 §9 decided that a deployment with no Cloud Reach is the ordinary case, and
that the Cloud Shortcut is installed either way so an agent reads a sentence rather
than `command not found`. That is now the shape rather than a branch: a Reach
nobody configured is still in the list, still answers, and carries the sentence it
answers with.

```
Reach = { credential, prove(), announce() }
      & ({ minter } | { unavailable: string })
```

The gain is that "there is none" stops being a `null` two modules apart have to
agree about. `ShimServer` loses the `wanted.account === null` sentinel and the
branch around it; the sentence `NO_CLOUD_REACH` moves to `src/cloud/`, where the
knowledge that there is a cloud already lives.

The failure this prevents is the one ADR-0015 §9 was written against and could not
express in a type: a Reach that is missing reads, to whatever consults it, as a
Reach that does not apply — and answering nothing is the one answer that sends an
agent off to investigate its `PATH`.

**The unavailable arm is reachable from a key that is absent, and from nothing
else.** A `prove()` that fails throws and blocks the boot, exactly as
`startup.ts`'s cloud proof does today (ADR-0015 §8: *a key that exists and does not
work still stops the boot*). This rule is written here because the new shape puts a
temptation where there was none: the unavailable arm and the failing proof now live
in the same factory, which already has a legitimate reason to return unavailable,
and a `try/catch` around `cloudReachFrom` is the most natural-looking edit in that
file. It would turn a revoked key into a deployment that reports having no Cloud
Reach and tells the agent §9's sentence — which would then be a lie. Under the old
shape the same mistake meant deleting a `throw` from `startup.ts` with twenty-two
lines of comment explaining why it was there.

### 3. `startRoma` takes one Reach per credential, and required is a type

`MintingOptions` and `CloudOptions` are gone. `StartRomaOptions` gains

```ts
readonly reaches: { readonly code: AvailableReach; readonly cloud: Reach }
```

**Not an array.** An array was the first shape and it is wrong, for a reason worth
writing down because the array reads better: `readonly Reach[]` cannot say "one per
credential", so `reaches: []` typechecks, and a roma with no `code` Reach proves no
key at boot, announces nothing, and fails every `git` request inside somebody's
Turn — which is the exact failure ADR-0008 blocks the boot to prevent, made
reachable again by omission rather than by a bad key. Omission is worse: a bad key
at least throws.

`CredentialWanted` is a closed union (§8), so a record keyed by it is total by
construction. TypeScript refuses a member that is not filled, at the composition
root, at compile time — which is where `MintingOptions.minter: Minter` refused it
before. Adding a third credential turns that totality into a compile error
everywhere a Reach must be supplied, which is the correct amount of friction for a
change that also needs a wire member and a program in the image.

Required-versus-optional is therefore **not** a field and **not** a convention. It
is two types. `AvailableReach` is the arm that carries a `MintsTokens`;
`githubReachFrom` returns it and cannot return the other, so ADR-0008's *"there is
no development mode that skips it, because required means required"* survives as a
thing the compiler knows rather than a thing a factory body happens to do. `cloud`
is the full `Reach`, because ADR-0015 §9 makes its unavailable arm legitimate.

Two fields leave `MintingOptions` rather than moving with it, because neither was
ever about minting: `shimDir` names the socket **both** credentials are served
over, and `gitConfig` is how `git`'s Credential Shim is installed. They become one
`shims: { dir, gitConfig }` option, which is the "one option rather than four loose
ones" argument `MintingOptions` already carried, minus the Minter. `startRoma`'s
existing `const shims = await ShimServer.listen(…)` is renamed `shimServer` — the
option is the Shims' directory and the local is the server that answers on it, and
one of the two had to give up the name.

**A Reach is typed by the credential it answers for**, not by the bare union:
`AvailableReach<'code'>` fills the `code` slot and nothing else can. Without the
type parameter `{ code: cloudReachFrom(env), cloud: githubReachFrom(minterEnv) }`
typechecks — a record that is total, populated, and wired backwards — and a `git`
is handed a Cloud Token. That is the failure `ShimServer`'s own comment names:
"looks like everything working until the first API call". Totality alone was not
enough, and finding that out is what the record shape is worth.

### 4. `prove()` yields an account, and roma stops reporting what it proved

Every Reach proves itself at boot or blocks the boot. What it returns is
`{ account: string | null }` and nothing else.

It is not the inventory. ADR-0015 is explicit that a Cloud Reach reports none —
roma is told which identity to hand over and nothing about what that identity may
do — and inventing a field for it so the two could match would be this ADR
flattening a decision it claims not to re-litigate. The Installation's repository
list is still fetched, and it is still what the announcement is built from; it is
simply the GitHub Reach's own business and reaches `startRoma` never.

`Roma.installation` and `Roma.cloudReach` are **deleted**. No production code reads
either — not `serve.ts`, not `main.ts`, and nothing outside this repository, which
is `private: true` with one composition root. Two tests do, and both are rewritten:
`startup.test.ts`'s *"reports what it found, for the boot log"* and *"starts
perfectly well with no Cloud Reach at all"* move onto the boot log line §5 gives
them, which is what both were reaching for the field to observe.

**One thing is genuinely lost, and it is a loss rather than a move.** That first
test also asserts the repository list. `ReachProof` has no field for it, so after
this the repositories are reported to exactly one audience — the agent, in
`--append-system-prompt` — and to no operator anywhere. §5 says GitHub gains the
account on the boot log; this is the other half of the trade, and it is accepted
rather than overlooked. The list is still fetched, still proved, and still tested
where it is produced (`github-minter.test.ts`).

`Roma.selfCheck` stays. `main.ts` reads it.

**The proofs run one at a time, in order, and the order is `code` first.** Today
that is enforced by data flow: the Installation is fetched at one statement and the
cloud key is proved at the next, so a deployment broken both ways is told about the
free check first and a boot with a bad App key makes no network call to Google at
all. `await Promise.all(…)` over the record compiles, reads as the natural generic
form, and silently loses both — the refusal an operator sees becomes whichever
provider lost the race, and a doomed boot now reaches a second provider it had no
business reaching. There is no test in the tree that would catch it, so this ADR
says it and the change adds one.

### 5. The Operator Log is reach-generic, and GitHub gains a boot line

`CloudLogRecord` becomes `ReachLogRecord`:

```
{ event: 'reach',              credential, account: string | null }
{ event: 'reach-token-minted', credential, account }
```

The `cloud-reach` record's own argument is kept whole and applied to both: a line
on **every** boot, including the boots where the answer is none, so that which
deployment an operator is looking at can be read off the log rather than inferred
from a line that is not there. One line per Reach rather than one line about the
cloud.

The consequence is that GitHub acquires a boot line it has never had. Today the
Installation's account is proved at boot and then written down nowhere; an operator
wanting to know which account roma is acting as has no line to read. That was an
asymmetry nobody chose, and making the record generic is what surfaced it.

**`reach-token-minted` is written for the Installation Token too, and that is a
decision rather than fallout.** Today only the cloud side has an `onMint`, so the
mint of an Installation Token is invisible. The argument the `cloud-token-minted`
record was given applies to `git` word for word — *something in the agent's
userland asks on every invocation by design, and almost every ask is served from
the token roma already holds, so an operator watching for a mint storm needs the
count that can actually storm* — and `git` asks far more often than the Cloud
Shortcut does. Making the record generic and then suppressing it for one credential
would be a rule somebody has to write; making it generic and keeping it is the
shape saying the true thing. It is named here because uniformity produced it and
nobody asked for it.

These are changes to a log format, and they are the only user-visible changes in
this ADR. Nothing totals the Operator Log (CONTEXT.md is explicit), so what they
cost is an operator's grep and not a number.

### 6. Per-Task attribution belongs to the socket, not to the Reach

`onCloudToken` becomes `onCredential(taskId, credential, path)` — one observer over
every request, rather than a callback named for one of them.

A Reach is not asked which Tasks used it. What a Task reached for is a property of
the requests that crossed the socket, and `ShimServer` is what sees them: it
already has the Session, the Task the queue resolves it to, the credential, and the
path. Putting a `usedBy(taskId)` on the Reach would have been the nullable method
this ADR exists to avoid — and it would have fitted only the cloud, because the
Audit Record's two provider facts are not the same shape. Whether the Cloud Reach
was used is a yes or a no and deliberately never a count (ADR-0015 §10). Which
repositories a Task minted for is a list, accumulated from `path`, and is a
separate ticket. One observer serves both; a boolean method serves one.

`Core.usedCloudReach` keeps its exact shape and its exact reasoning — *a question
rather than a component, because this is the whole of what the Core is allowed to
know about it*. The Core still cannot be asked whether there is a Google.

### 7. ADR-0015 §4's guard becomes structural, and the source match is deleted

**Read this before reinstating anything.**

§4's failure mode is silent, arrives by roma *doing nothing*, and lands only on
production hosts: a `GoogleCloudMinter` built from a resolution chain rather than
from the named key file mints against roma's own identity, and every call works.
Two things guarded it. `RESOLVES_A_CREDENTIAL` bans the library's finding calls
inside `src/cloud/`, and it is **kept, unchanged**. The second was a match against
the text of the composition root, which the directory rule deliberately does not
bind because that is the one file holding both identities at once.

The substitution the source match watched for can no longer be written, because the
composition root no longer names the constructor. `new GoogleCloudMinter` moves
inside `src/cloud/`, behind

```ts
export function cloudReachFrom(env: CloudEnv | null): Reach
```

which is inside the directory `RESOLVES_A_CREDENTIAL` already binds, and which
takes the key or takes nothing. The composition root's only remaining move is to
call it with something other than `readCloudEnv`'s output — and anything of that
shape *is* key material somebody already has, which is not the resolution chain §4
is about.

There is a second gain, and it is the larger one: `src/cloud/reach.ts` lands
*inside* `containment('cloud')`, so `RESOLVES_A_CREDENTIAL` now binds the
construction site itself — which it has never done, because the construction was in
the one file that rule cannot bind.

So the guard moves from "the source says the right thing" to "the wrong thing
cannot be said here". The deleted test is not coverage lost; it is coverage that
had become a check on a line that could no longer do the damage.

**What is lost with it is the only rule aimed at the composition root at all.**
`compositionRoot()` has one caller, and after this it has none. Every containment
rule excludes `main.ts` by design — assembling roma means naming what it is
assembled out of — so the repo keeps no mechanism for asserting anything about the
one file where both identities are in scope. That is acceptable for §4, which no
longer needs one. It is recorded here because rebuilding it later is a new helper
rather than a new expectation, and because the next person to want a rule about the
composition root should know the machinery was removed rather than never built.

### 8. What is deliberately not made uniform

A third Reach is **not** free, and this ADR does not claim it is.

`CredentialWanted` is a wire enum in `shim-protocol.ts`, sent by programs living in
the agent's userland. A third Reach needs a member of it and a Shim or Shortcut
program to send it — a protocol change and an image change, neither of which a list
in `startRoma` can absorb. What becomes free is the composition root's branching,
the log record types, and the fields on `Roma`.

Saying so here because the shape invites the opposite claim, and a list that looks
open while the protocol behind it is closed is how somebody plans a fortnight of
work off a paragraph.

### 9. The socket answers every request the same way

`ShimServer` returns `{ token, expiresAt, account }` on every successful answer,
whichever credential was asked for. It used to withhold the expiry and the account
from anything but the Cloud Shortcut, on the grounds that "a Credential Shim hands
its token to `git` or to one child process's environment, neither of which has a
field for either".

That was minimalism rather than protection, and it cost something: the branch that
did it — `wanted.account === null ? { token } : { token, expiresAt, account }` —
was the place a Reach could be paired with the wrong tokens, and it read as a
safety property while being a formatting one. Neither Credential Shim can see the
widened answer in any case: `shim-client.ts` collapses the response to a token and
a complaint before either Shim touches it. The account is not a secret — it is
already in the system prompt and on the Operator Log.

What replaces the branch is a test: each answer carries *its own* Reach's account,
which is a stronger claim than the one it replaces and the only thing standing
where the ternary stood.

## Consequences

- `src/minter.ts` becomes `src/reach.ts` and holds `MintedToken`, `MintsTokens`,
  `ReachProof`, `Reach` and `Reaches`. The `Minter` interface disappears and its
  `installation()` becomes the forge Reach's `prove()`; `Installation` moves to
  `src/github/installation.ts`, beside the only things that read it. `CloudMinter`
  moves to `src/cloud/`, where it is now a Minter that knows its own account. The
  `CloudReach` **type** is deleted outright rather than moved: it was one field,
  `ReachProof` is that field, and `announceCloud` takes the account. Both **terms**
  stay in CONTEXT.md — they are security properties, and the argument for naming
  them is untouched by which directory a type lives in.
- `startup.ts` loses the cloud-shaped `try`/`catch`, the `cloud-reach` log line, the
  two named `FreshTokens` constructions, the `onCloudToken` wiring, the
  `appendSystemPrompt` conditional join, and two fields on `Roma`.
- `FreshTokens` is still built by `startRoma` rather than inside a Reach, so that
  the `onMint` record stays in the Core with every other log record. A Reach hands
  over a `MintsTokens` and roma does the arithmetic — which is `FreshTokens`' own
  argument, that the state is per-credential and the arithmetic is one class.
- `ShimServer` answers every request with `{ token, expiresAt, account }`. The
  gating that withheld two of the three was a minimalism argument rather than a
  safety one, and it is what the deleted sentinel was reading.
- **`announce()` becomes order-dependent where it was not.** `MintingOptions.announce`
  took the Installation as an argument, so prove-before-announce was impossible to
  get wrong — you could not call it without the proof. `Reach.announce(): string`
  can be called at any time, and the GitHub Reach holds what it proved in a
  closure between the two. It **throws** on an unproved Reach rather than
  announcing an empty repository list, because `github/announce.ts` renders an
  empty list as *"the App is installed on ${account} but reaches no
  repositories"* — an agent told that has been told it has no access when it has
  all of it, which is the failure ADR-0008's announcement exists to prevent. A
  wrong order used to be a crash; without the throw it would be a plausible,
  wrong sentence.
- An announcement that is `''` is filtered before the join, not joined and
  trimmed. Two tests assert the system prompt with `toBe`, and a trailing `\n\n`
  fails both — but the reason to filter is that `--append-system-prompt` is gated
  on `undefined` and never on `''`, so an empty string reaches the argv.
- `shim-client.ts` must pass a null `account` through rather than dropping it. Its
  filter is `typeof account === 'string'`, and a widened `account: string | null`
  would otherwise make "roma answered no account" indistinguishable from "an older
  roma answered none at all" in `roma-cloud-token --json`.
- `ROMA_MINTER_SOCKET` and `minter.sock` do **not** follow the rename. They are an
  image and environment contract, asserted in `startup.test.ts`, and the file
  moving is not a reason to move them.
- An operator's log lines change shape. See §5.
- A boot with no Cloud Reach now writes `{event:'reach', credential:'cloud',
  account:null}` where it wrote `{event:'cloud-reach', account:null}`. Same claim,
  same frequency, different spelling.

## Alternatives considered

**Leave the asymmetry; only rehome the safety property.** The narrowest change that
fixes the one thing that is indefensible: `cloudReachFrom` exists, the source-match
test goes, and `startRoma` is untouched. Rejected because it buys the smallest of
the three wins and leaves the composition root's two-slot shape in place, so the
next provider pays the full ten edits for a file that had just been opened.

**A Reach-shaped module without a list.** One module owning "boot proof plus
announcement plus per-Task use" for both providers, with the required/optional and
inventory/none differences preserved as named fields rather than list entries.
Rejected in favour of the list, but honestly: this was the safer design, and its
advantage is that it never has to write §8. What decided it was §4 — once
`Roma.installation` and `Roma.cloudReach` turned out to have no readers, the reason
to keep named access disappeared, and a named module with nothing to name is a list
with extra steps.

**Keep `Roma.installation` and `Roma.cloudReach`.** Argued on the grounds that
`Roma` is exported and something outside this repository could read them. Rejected:
roma is `private: true`, has one composition root, and the fields have never had a
reader. Keeping an interface against a hypothetical consumer is how the two log
unions and the `SessionPoolOptions.model` field already got here.

**A uniform `usedBy(taskId): boolean` on every Reach.** Rejected in §6. It would
have made GitHub implement a boolean nobody asked for, alongside the repository
list somebody actually wants, and the two would have said the same thing at
different resolutions.
