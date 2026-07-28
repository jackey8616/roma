# 2. Shared personal subscription credential

Date: 2026-07-28

## Status

Accepted

Recorded separately from ADR-0001 because this is the decision most likely to be
revisited, and it should be possible to supersede it without disturbing the
architecture.

## Context

The bridge described in ADR-0001 is open to every member of the Workspace. It
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

The valve is **off by default** and offered at the moment a task is blocked,
rather than as a setting to be enabled in advance — people are poor at
predicting which work will turn out to be interruptible, and are well placed to
judge it once blocked.

- Anyone may press it. Restricting it to an admin turns a person into an
  approval queue and leaves urgent work stuck whenever they are offline.
- It applies to **that task only**. A persistent per-thread toggle gets enabled
  once and then quietly spends money for every later task in the thread.
- Spend is shown in the reply, and a **monthly overflow cap** is enforced;
  beyond it, overflow is refused outright and the owner is notified. Without a
  cap, "off by default" would be ceremony rather than protection.

## Consequences

**Accepted risk: this is account sharing.** Subscriptions are individual under
Anthropic's terms. The decision was raised, restated, and reaffirmed; the owner
carries it.

**Operational consequences:**

- Peak contention is real. Several concurrent users can drain the shared window
  before midday, blocking everyone for the remainder of it.
- Per-user attribution does not exist at the provider. It has to come from our
  own audit log, which is why ADR-0001 records the caller and cost of every task.
- The monthly overflow figure is the number that makes the eventual argument for
  or against moving fully to API billing. Without it that discussion is
  conducted on impressions.

**Upstream direction.** The documented trajectory — `--bare` recommended for
scripted use and slated to become the `-p` default, while never reading OAuth —
points toward API keys as the expected path for programmatic callers. This
decision runs against that current and should be expected to need revisiting.

## Superseding this

Migrating to option 2 (per-member tokens) or option 3 (API key) changes only the
environment map handed to each spawned process, plus a binding flow for option
2. ADR-0001 is unaffected. This was a deliberate goal when the credential
handling was placed at the spawn boundary.
