# 2. Shared personal subscription credential

Date: 2026-07-28

## Status

Accepted. **Amended 2026-07-29** after prototype verification
(`docs/headless-session-verification.md`, Claude Code v2.1.220).

The decision is unchanged — the prototype confirmed it. What the amendments
correct is the evidence beneath it and the severity of its failure mode.
Amendments are marked inline.

Recorded separately from ADR-0001 because this is the decision most likely to be
revisited, and it should be possible to supersede it without disturbing the
architecture. ADR-0001 has since been superseded by ADR-0003 and ADR-0004 for
unrelated reasons; that separation still holds, and now applies to ADR-0003.

## Context

The agent described in ADR-0003 is open to every member of every connected
channel — at the time of writing, every member of the Workspace (ADR-0004). It
has to authenticate to Anthropic somehow. Three options were on the table:

1. One personal Claude Code subscription token, shared by everyone.
2. Each member binds their own token (`claude setup-token` on their machine,
   handed to the service for encrypted storage).
3. An API key, billed per token.

## Decision

**Everyone shares a single personal subscription token.**

`claude setup-token` produces a long-lived credential whose own help text reads
"requires Claude subscription", so headless `-p` runs draw on subscription quota
rather than metered API billing. That is the property we are after.

**Amended — this is now verified rather than inferred from help text.** Under
`CLAUDE_CODE_OAUTH_TOKEN` alone, with `ANTHROPIC_API_KEY` absent and no keychain
login reachable, runs succeed and emit a `rate_limit_event`:

```json
{"status":"allowed","resetsAt":1785271200,"rateLimitType":"five_hour",
 "overageStatus":"rejected","isUsingOverage":false}
```

`rateLimitType: "five_hour"` is direct evidence that headless runs draw on the
subscription's rolling window rather than metered API billing. `total_cost_usd`
is populated — neither zero nor absent — so cost is observable on the
subscription path too.

Option 2 was recommended and declined. Option 3 was declined for cost.

### Credential handling is per-invocation, not per-container

This is not an implementation detail; it is what makes the decision work at all.

Upstream documents that `ANTHROPIC_API_KEY`, when set, "overrides your Claude
Pro/Max/Team/Enterprise subscription in interactive mode (with user approval)
and **always in non-interactive mode**."

So the obvious approach — keeping an API key in the container environment for
the overflow valve below — would silently route *every* run to metered billing
and never touch the subscription. There is no warning; it would surface as an
unexpected invoice.

**Amended — confirmed, and worse than described. The key takes the model with
it.** With both credentials present, the prototype observed:

```
apiKeySource="ANTHROPIC_API_KEY"   model=claude-opus-5[1m]
```

Under the OAuth token every run used `claude-sonnet-5`. The stray key did not
merely convert billing to metered — it silently switched to a substantially more
expensive model at the same time, so the unexpected invoice is larger than the
reasoning above implies. ADR-0003 pins `--model claude-sonnet-5` explicitly and
has the startup self-check assert on both `system/init.apiKeySource` and the
reported model, which is what makes this detectable rather than merely feared.

**A second aggravating factor: the bad credential does not fail fast.** It
produced 10 `api_retry` events across 182 seconds before surfacing the 401, so a
misconfiguration occupies a concurrency slot for over three minutes. That
consequence lands on ADR-0003's concurrency cap, which now bounds the retry
storm.

Therefore each `claude` process is spawned with an explicitly constructed
environment:

```
normal:    { CLAUDE_CODE_OAUTH_TOKEN: <token> }   # ANTHROPIC_API_KEY absent
overflow:  { ANTHROPIC_API_KEY: <key> }           # OAuth token absent
```

The key must be **absent**, not empty — an empty string still occupies its slot
in the precedence order. Both secrets are read from GCP Secret Manager into the
Node process and never enter the container's global environment, the image, or
version control.

A consequence worth noting: the overflow valve stops being a special mode and
becomes just a different environment map.

### Quota exhaustion

The shared token means one shared 5-hour rolling window and one shared weekly
limit. When they are spent, everyone — including the token's owner — is blocked
at once.

On exhaustion the bot states plainly that quota is spent, gives the expected
reset time, and queues the task. It also offers an **overflow valve**: a button
that reruns the task on a metered API key.

**Amended — the expected reset time has a real source.** It is `resetsAt` on the
`rate_limit_event` above, not an estimate. `overageStatus` and `isUsingOverage`
on the same event tell us whether overage is even available before we offer the
valve.

The valve is **off by default** and offered at the moment a task is blocked,
rather than as a setting to be enabled in advance — people are poor at
predicting which work will turn out to be interruptible, and are well placed to
judge it once blocked.

**Amended again — what a spent window looks like is still unmeasured, and the
implementation says so.** Every capture in `test/fixtures/claude-stream/` reports
`status: "allowed"`, including the one quoted above; measuring the other case
means deliberately draining the window the whole team shares, which blocks
everybody until it resets. So `spentUntil` in `src/quota.ts` reads *anything that
is not `allowed`* as spent, and that one function is the whole of the guess —
deliberately shaped to survive being wrong, since a status roma has never seen
parks a Task and says so rather than running it into a wall. It also refuses to
call the window spent when the event carries no `resetsAt`: a Task parked against
a moment that never arrives waits for ever, and nothing would come and look at it
again. Correct it there, and nowhere else, once somebody has seen one.

- Anyone may press it. Restricting it to an admin turns a person into an
  approval queue and leaves urgent work stuck whenever they are offline.
- It applies to **that task only**. A persistent per-thread toggle gets enabled
  once and then quietly spends money for every later task in the thread.
- Spend is shown in the reply, and a **monthly overflow cap** is enforced;
  beyond it, overflow is refused outright and the owner is notified. Without a
  cap, "off by default" would be ceremony rather than protection.
  - **The cap is a required part of configuring overflow at all**, not a setting
    with a default: a default would be roma deciding how much of somebody's money
    to spend on their behalf. A metered key and a cap are configured as one
    thing, so a deployment cannot end up with half of it.
  - The cap is enforced against the audit log's per-turn totals for the calendar
    month, which is the number ADR-0003's observability section exists to make
    correct. The comparison is against a figure that log is explicit is a *floor*
    — tasks nothing priced are not in it, and neither are records that could not
    be read — so it errs towards allowing. A cap that refused on every torn line
    would close overflow for the rest of the month over one power loss; both
    counts go into the refusal an operator reads, so the softness is visible
    where the decision is.
  - **Overflow is taken for one attempt, not for one task.** A task that takes
    it and then fails again is back on the subscription and has to be offered it
    afresh — which is what puts the cap in front of every metered attempt rather
    than only the first. The per-task rule above is the floor, not the ceiling.
  - **Known bound: the cap is checked against finished tasks only.** Two blocked
    tasks taking overflow at the same moment both read the same total and both
    pass a cap their sum would exceed. The overshoot is bounded by the
    concurrency cap — at most three tasks in flight — so it is a cap that can be
    exceeded by three tasks' worth and not by more. Reserving spend before it is
    made would close it and is not built.
  - **The owner is notified through the operator log**, not through a channel.
    The person who asked is told they were refused; a month that has spent its
    budget is not theirs to act on, and a notification the core posted into some
    configured conversation would be the core knowing about a channel.

## Consequences

**Accepted risk: this is account sharing.** Subscriptions are individual under
Anthropic's terms. The decision was raised, restated, and reaffirmed; the owner
carries it.

**Operational consequences:**

- Peak contention is real. Several concurrent users can drain the shared window
  before midday, blocking everyone for the remainder of it.
- Per-user attribution does not exist at the provider. It has to come from our
  own audit log, which is why ADR-0003 records the caller and cost of every task.
- The monthly overflow figure is the number that makes the eventual argument for
  or against moving fully to API billing. Without it that discussion is
  conducted on impressions.
- **Amended — that figure must be computed from per-turn deltas.**
  `total_cost_usd` is a cumulative **process** total, not a per-turn figure; on a
  resident multi-turn process the fifth task is otherwise recorded at the sum of
  tasks one through five. Both the monthly overflow cap and the eventual
  API-billing argument would be made on inflated numbers. ADR-0003 specifies the
  fix. The total belongs to the process rather than to the session — measured
  when the session pool first evicted and resumed one, and recorded in ADR-0003's
  observability section — so the baseline restarts with every process and nothing
  has to be carried across an eviction.

**Amended — "off by default" is a variable roma names for itself.** The ingress
subscriber (#13) is where a deployment first has to say whether overflow exists,
and it reads the metered key from `ROMA_OVERFLOW_API_KEY` rather than from
`ANTHROPIC_API_KEY`. The obvious name is the wrong one: it is set on developer
machines and in CI images for reasons that have nothing to do with roma, so
reading it would turn metered billing on for a whole deployment because somebody's
shell profile mentioned it — this decision's default reversed by an environment
nobody looked at. It is the same stray-key failure the startup self-check exists
to catch, arriving through roma's own front door instead of Claude Code's. The
monthly cap is required whenever the key is set and vice versa, so neither half
can be configured alone.

**Upstream direction.** The documented trajectory — `--bare` recommended for
scripted use and slated to become the `-p` default, while never reading OAuth —
points toward API keys as the expected path for programmatic callers. This
decision runs against that current and should be expected to need revisiting.

## Superseding this

Migrating to option 2 (per-member tokens) or option 3 (API key) changes only the
environment map handed to each spawned process, plus a binding flow for option
2. ADR-0003 and ADR-0004 are unaffected. This was a deliberate goal when the
credential handling was placed at the spawn boundary.

One amendment-era caveat: because the credential also determines the model, a
migration must set `--model` deliberately rather than inherit whatever the new
credential defaults to. Otherwise a change of billing silently becomes a change
of capability and cost.
