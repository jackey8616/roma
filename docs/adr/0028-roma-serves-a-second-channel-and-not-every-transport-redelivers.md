# 28. roma serves a second Channel, and not every Transport redelivers

Date: 2026-08-12

## Status

Proposed. **Nothing here is implemented.** This ADR and ADR-0029 are the
decisions; the code that keeps them is separate work.

With ADR-0029, this is the first exercise of the contract `src/channel-adapter.ts`
calls provisional:

> **Provisional.** It was designed against one Channel and cannot be validated
> until a second exists, so it is deliberately the smallest thing that serves the
> Channel roma actually has. Expect the second Channel to change it, and prefer
> changing it then to guessing now.

Amends **ADR-0003** inline, at *Ingress is a queue, not a webhook*.

## Context

The tally is the reason this ADR is short. Designing ADR-0029's Adapter against a
Channel that differs from Google Chat in every mechanism — a long-lived socket
rather than a queue, 2000 characters rather than 4096, an app that can open a
thread rather than one that cannot — moved almost nothing:

| | |
| --- | --- |
| `ChannelAdapter`'s four members | unchanged |
| `ChannelCapabilities` | unchanged; both flags are `true` for Discord |
| `IngressMessage` | unchanged |
| `OutboundInstruction`'s nine kinds | all renderable |
| `Delivery.id` | unchanged, and still earning its place |
| **`Transport.nack`** | **its promise is wrong for one implementation** |
| **`serve`** | **takes one Channel and must take several** |

So the interface survives, and the two things that do move are the subject of
this ADR. Neither is in `ChannelAdapter`.

## Decision

### A second Channel is a second Core over one pool

This is not a new decision. It is written twice in the source already:

> A second Channel means a second Core over this same pool and queue.
> (`src/startup.ts`)

> One Core per Channel, sharing one pool. That is what keeps the Core free of
> Channel identity: there is no routing table to consult and no field to inspect,
> because a Core only ever has one place to reply to. (`src/core.ts`)

What this ADR adds is that it stops being a comment, and that **one process** is
the load-bearing half of it. `startRoma` already builds every shared thing once
and injects it — the queue, the pool, the Work Root, the Audit Log, the two
Chosen Records — so a second Core inherits all of them by construction. Each of
those is singular for a reason that a second Channel does not touch:

- **The queue** caps concurrency at 3 against the Shared Window, and a Shared
  Window does not get larger because a second chat product points at it.
- **The pool** caps resident processes against the VM's memory, which is one VM.
- **The Audit Log** is one month of one wallet: ADR-0002's monthly Overflow cap
  is enforced against the sum of the month's records, and ADR-0027's `/usage`
  answers from the same walk.
- **The Work Root and the Chosen Records** are keyed by Conversation, and two
  Channels' key shapes do not collide.

One correction falls out of this. `src/channels/google-chat/main.ts` says *"A
second Channel gets a second one of these, over the same Core"* — that
contradicts both quotations above and is wrong. It is corrected in the same
change as this ADR.

**The composition root moves to `src/channels/main.ts`.** `src/core.test.ts`
refuses any file in `src/` outside `channels/` that names a Channel, and
`/\bdiscord\b/i` is already in its list. A root that names both Channels
therefore cannot live in `src/` proper, and should not live inside either
Channel's directory. `startGoogleChatRoma` stays where it is and stops being the
program.

**Each Channel's configuration becomes optional, at least one required.** A
deployment serving only Discord should not have to name a Pub/Sub subscription.

### `serve` takes bindings, and the pairing guarantee survives

`ServeOptions<Event>` names the Adapter and the Transport with one type variable,
and says why:

> a Transport delivering events this Adapter cannot read produces a roma that
> runs perfectly and ignores everything it is sent. Neither `Core` nor
> `Transport` can see that on its own — this is where the two meet.

The obvious generalisation throws that away. A `readonly channels: readonly
{ channel: ChannelAdapter<any>; transport: Transport<any> }[]` type-checks and
pairs nothing.

So the pair is made at a function boundary and the variable is erased after it is
checked — a `bind<E>(channel: ChannelAdapter<E>, transport: Transport<E>)`
returning something opaque that `serve` holds a list of. The guarantee is kept in
the one place it can be stated; what `serve` stores no longer has to name `E`.

### A Transport need not redeliver

ADR-0003 decided *Ingress is a queue, not a webhook*, and grounded it on exactly
two properties:

> - The VM opens no inbound ports; its firewall denies all ingress.
> - It removes the webhook response deadline (~30s), which a minutes-long turn
>   cannot meet.

Discord's Gateway has **both** properties and is **not a queue**. It is a
WebSocket roma opens outward, so no port is exposed; it imposes no deadline on
answering a message. What it does not have is durable redelivery: a resumed
session replays what it missed, and an invalidated one starts fresh with the gap
gone.

**Amendment to ADR-0003.** The two reasons carry. The mechanism does not. A
Transport owes the Core the two promises `src/transport.ts` already names — here
are the events, here is how to stop — and redelivery is not among them.
`src/transport.ts` had already generalised this far ahead of ADR-0003's text:

> One Channel may deliver over a queue and the next may need a receiver of its
> own inside its Adapter; what both owe the Core is the same pair of promises.

So `Delivery.nack` becomes a no-op where there is nothing to hand back, and its
documentation stops promising *"Hand it back, to be delivered again"* as though
every Transport could.

**`Delivery.id` is unaffected and keeps its whole argument.** A Gateway that
replays on resume hands the same event over twice, and its id is what tells that
apart from a second message saying the same words.

### The remedy for a failed post is another post, not another Turn

`nack` exists for one case, and `src/serve.ts` states it precisely: *"roma could
not tell the Conversation anything at all."*

That case cannot be repaired by re-reading the event. If the Channel is
unreachable, roma cannot speak — so the redelivery arrives at a roma that still
cannot speak, having spent the Turn again on the way. Discord makes the shape
obvious because its two directions are two connections: the Gateway is fine while
the REST API returns 503 is the ordinary case there, and re-reading a socket
repairs no POST.

**So the remedy belongs in `ChannelAdapter.deliver`.** A failed post is retried
where it failed, by the Adapter that knows what its Channel's failures mean.

This exposes the shape of the existing arrangement rather than only serving the
new one. The Chat Adapter has no retry anywhere in its outbound path, so today a
transient 503 from Chat is repaired by re-running a Turn that costs minutes and
money. That is a defect this ADR names and does not fix; it is filed separately
as #168, because it is Chat's and predates Discord.

## Consequences

- **One Channel can starve another, and the Core cannot see it.** The cap of 3 is
  global and the queue is first-come-first-served, so a busy Channel can hold
  every slot while the other queues. Deliberately not repaired: raising the cap
  spends one Shared Window more concurrently without creating capacity, and
  per-Channel fairness would be a policy invented with no evidence. It is not
  silent — `progress: queued` carries the waiting Task's position — and it is the
  same fact as ADR-0003's *"Adding a channel widens that blast radius, and the
  core cannot see it"*, seen from the resource side rather than the trust side.
- **Both Channels spend one wallet.** The Overflow monthly cap and `/usage` cover
  the pair. That is correct — there is one subscription — and it is worth stating
  because the rejected alternative would have doubled the cap without anybody
  deciding to.
- **A Transport that cannot redeliver loses in-flight work on shutdown.**
  `Serving.shutdown` hands its Deliveries back precisely so a deploy does not
  lose running Tasks; where nothing can be handed back, that protection is gone
  and the person is told nothing (#171). The alternative it is traded against is
  not free either — `src/serve.ts` already records that a redelivered Task can be
  *"answered **and** run again"*.
- **The glossary loses three assumptions.** **Transport** is no longer *"the wire
  the ingress queue runs on"*, **Settling** is no longer always *"one of two
  ways"*, and a **Delivery**'s id is no longer explained by *"a queue that
  promises to lose nothing"*.

## Alternatives considered

**Two processes, one Channel each.** Rejected, and it is the alternative that
looks cheapest. Every cap roma has is per-process: the concurrency cap of 3
becomes 6 against one Shared Window, and the Overflow monthly cap — enforced
against the sum of the month's Audit Records under `ROMA_AUDIT_ROOT` — is
enforced twice, so twice the ceiling is spendable with no configuration looking
wrong. ADR-0027's `/usage` would answer for one Channel about a subscription both
share. Pointing the two processes at one root instead trades those for two
writers on one JSONL and two resident pools on one `auth.json`, which is #155
made worse rather than a fix.

**Discord's Gateway publishing onward into Pub/Sub.** ADR-0003 explicitly
sanctions the shape — *"a channel without native delivery needs an HTTPS receiver
inside its own adapter that publishes onward"* — and it would have kept `nack`
honest. Rejected because the durability is mostly illusory: the hop from socket
to publish is itself unacknowledged, so a roma that dies loses the event at
exactly the point the queue was supposed to protect. It also makes a Discord
deployment depend on a Google project, and it would have answered the question
this interface has been waiting to be asked by dressing a WebSocket as a queue.

**A `redelivers` flag on `Transport`, declared the way `ChannelCapabilities` are.**
Rejected for now. `serve.ts` would not branch on it today — a no-op `nack` and a
declared inability produce identical behaviour — and a flag nothing reads is a
second thing to keep true. #171 is what would give it something to branch on —
the day roma wants to say something to a Conversation whose work it is about to
drop.

**Per-Channel fairness in the queue.** Rejected. See the first consequence.
