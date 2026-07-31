# 15. roma installs no cloud CLI, and mints the agent's Cloud Token

Date: 2026-07-31

## Status

Accepted, and **built** in #95. `src/cloud/` holds everything that knows this is
Google — the key, the assertion, the exchange, the announcement, the Shortcut —
and `src/cloud-containment.test.ts` keeps it there and keeps Application Default
Credentials out of it. The Minter port gained a cloud half, `FreshTokens` (which
was `InstallationTokens`) now serves both credentials from one piece of expiry
arithmetic, and the socket answers a second kind of request.

**Still unmeasured, and still the one thing that matters:** no Cloud Reach has
ever existed. Every response in `src/cloud/google-cloud-minter.test.ts` is
written from Google's documentation, and only a real service account can settle
whether Google behaves this way.

**One thing §8 asks for that is not built.** It says a failed boot proof is "one
of the problems the single `readConfiguration` refusal reports". `readConfiguration`
is synchronous and the proof is a network round trip, so what was built instead
refuses in that same *shape* — a `ConfigurationMissing` from `startRoma` — rather
than joining that same *message*. A deployment with both a missing audit root and
a revoked key therefore still boots twice. Everything a key file can be wrong
about short of being revoked — unreadable, empty, not JSON, not a service account
key — is caught by `readCloudEnv` and does join the single refusal, so only the
revoked case diverges. The `minter.installation()` check has had the identical
property since ADR-0008, so this is the existing shape rather than a new
exception. Closing it means `readConfiguration` collecting problems rather than
throwing them, which changes how every reader reports and was not in scope here.

**This record has been reversed twice and merged once, all in the session that
wrote it.** The history matters, because what overturned it both times was
measurement rather than opinion:

1. The first version decided `gcloud` would ship in a second image tag,
   `X.Y.Z-gcloud`, pinned by tarball and checksum with the ceremony `gh` gets. It
   rested on two unmeasured claims and named one of them as carrying the whole
   decision. Both were measured within the hour, and the second killed it: the
   image can already do everything a cloud CLI does.
2. A companion record then decided the agent would be handed a **static** service
   account key in its own environment, with roma minting nothing — a deliberate
   departure from ADR-0008, argued honestly and rested entirely on the cost of
   minting. Most of that cost was the cost of wrapping somebody else's CLI. With
   no CLI, the cost went away and the concession stopped being worth making.
3. The two records were then merged into this one, because the first no longer
   passed its own test for being an ADR: with the decision reduced to "install
   nothing", it is no longer hard to reverse, which is one of the three
   conditions `docs/agents/domain.md` requires. Its measurements are the evidence
   for the Cloud Shortcut and they live on below.

Extends ADR-0008 rather than qualifying it: the same rule, a second provider.
Leaves ADR-0007 untouched — one image, one pin, no floating tags, all unchanged.

### Verification status

**Measured — what a cloud CLI costs.** Google Cloud CLI 578.0.0, `linux x86_64`,
downloaded and unpacked in this session:

```
google-cloud-cli-linux-x86_64.tar.gz    88,566,196 bytes  (compressed)
unpacked                               460,335,231 bytes  (439 MiB)
```

Against a runtime stage that is `node:22-slim` plus five apt packages and one Go
binary. **Not** an image-layer measurement — no Docker daemon was available — so
this is on-disk footprint. A layer would be of the same order.

**Measured — the image can already do all of it, with nothing installed.** On
Node 22, using only `node:crypto`, with no dependency whatsoever:

- an RS256-signed JWT, which is exactly what a Google service account key is
  exchanged with;
- the SigV4 HMAC-SHA256 key derivation chain, which is what AWS requires;
- global `fetch` is present, so not even `curl` is needed.

**Measured — the token endpoints answer a credential-shaped request.** One POST
each from this session's sandbox, with deliberately invalid credentials:

| endpoint | answered |
| --- | --- |
| `oauth2.googleapis.com/token` | `invalid_request` |
| `login.microsoftonline.com/…/oauth2/v2.0/token` | `AADSTS700016: Application with identifier 'bogus' was not found` |
| `sts.amazonaws.com` | `MissingAuthenticationToken` |

Each rejected the *credential* rather than the request: a valid one would have
been exchanged. Azure's is a plain POST with no signing at all.

**Measured — scopes are a property of the exchange, not an invention.** Read out
of the installed `google-auth-library`: `scopes` is optional on the JWT client,
and the client takes one of two paths — a self-signed JWT bound to a target
audience when no scopes are set, or an access-token exchange when they are. With
neither scopes nor an audience it returns empty headers. So a general-purpose
access token requires naming scopes, and the only way to avoid naming them is to
bind the credential to one API up front.

**What the endpoint measurement is not.** It was taken from this session's
sandbox and not from a roma deployment, so it establishes the protocol shape and
not any particular deployment's egress. The README states that roma has no egress
allowlist and no firewall, which is the only reason the shape is the whole story.

**Not measured.** The cost of a mint against a real service account, expected to
be sub-second and free. How usable narrow scopes are across Google's APIs. And
everything else: no part of this has been deployed, and no Cloud Reach has ever
existed.

## Context

`Dockerfile`'s runtime stage argues for its own narrowness:

> Deliberately small. roma's agent runs arbitrary shell commands, so this image
> is a workspace and not only a runtime — but guessing at which tools it will
> want produces an image nobody can explain, every line of it attack surface on a
> public registry. […] Widening this list is a separate decision with its own
> evidence.

`gh` is the one widening that has happened, and it brought the evidence that
sentence asks for: it is the only tool that can be handed a freshly minted
Installation Token on every invocation, which no library and no MCP server can.
Google Cloud arrived as the same request and does not bring the same evidence.

The credential half was settled for GitHub by ADR-0008:

> **Minter**: The only thing that holds the App's private key, and therefore the
> only thing that can produce an Installation Token. […] the private key never
> enters the space the agent can reach.

The reasoning that got it there is arithmetic, and it transfers whole:

> An hour long, asked for at the moment a tool needs one, and never put in a
> process environment — an environment is fixed at spawn and would be stale
> within the hour, and a token that reaches a Transcript is in a record roma
> never deletes.

A Google Cloud access token is also about an hour. A Resident Session outliving
an hour is ordinary. `google-auth-library` is already a runtime dependency,
surviving `npm ci --omit=dev`, so the means are present.

Two further facts shape the rest.

**roma does not necessarily run on Google Cloud.** ADR-0003 expects a GCE VM and
that is an expectation, not a requirement. A deployment may hold a service
account key from anywhere, so the credential cannot be assumed ambient.

**On a Google host the opposite risk appears.** Anything resolving Application
Default Credentials with nothing configured does not fail — it reaches the
metadata server and authenticates as the VM's own service account, which is
roma's, holding `pubsub.subscriber` on roma's own ingress. Nobody configures
that. It happens on exactly the hosts roma is designed for and on no developer
machine, so it is invisible until it is production.

## Decision

### 1. No cloud CLI ships — not in this image, and not in a second one

`Dockerfile` is untouched. `src/packaging.test.ts` gains no third pinned version.
`release.yml` still publishes exactly one image tag and
`scripts/verify-image.sh` still runs once.

439 MiB buys no capability. roma **is** a Node program, so Node cannot be taken
out of the image, and Node alone signs both credential shapes and speaks HTTPS.
A CLI does not add access to a cloud. It adds convenience.

**And a CLI would not have been a boundary either.** Written down because the
misreading is available and costs money: an image without a cloud CLI is not an
agent that cannot reach a cloud. The measurements above cover Amazon Web Services
and Azure too, neither of which was ever under discussion — Azure's
client-credentials exchange is one POST with no signature. Whatever bounds what
an agent can do in a cloud, it is not the contents of `/usr/local/bin`.

### 2. A Cloud Reach, and it is not the identity roma runs on

One Google Cloud identity, chosen by whoever deploys roma. The roles they gave it
are the whole of what the agent can touch. Every Conversation reaches all of it,
and so does everyone who can message roma — an Installation's shape, on a second
provider.

It is **not** the identity roma itself runs on. An agent standing in roma's own
identity can delete the subscription roma pulls from, publish forged events to
the topic roma trusts, and mint itself a key that outlives every rotation — each
of which presents as roma quietly not working rather than as an attack. A
deployment where those two identities are the same has no boundary at all.

### 3. roma mints; the key never enters the agent's space

The Minter holds the service account key, as it already holds the App's private
key, and produces a Cloud Token from it on request. One component and one term
for both, because it is one rule: a long-lived key never enters the space the
agent can reach.

A Cloud Token is what the agent gets — an hour long, obtained when something
needs one, never written into a process environment fixed at spawn, and never
persisted anywhere that outlives the command it was made for.

The key is named to roma by a path rather than inline, following
`ROMA_GITHUB_PRIVATE_KEY_FILE` and `GOOGLE_APPLICATION_CREDENTIALS`: multi-line
secrets belong in mounts. It is **not** added to `buildEnv`'s allowlist, so that
file's rule — "Nothing is inherited implicitly" — stays exactly as strong as it
is today. It is read at boot and held, as `readMinterEnv` already reads the App's
PEM, which means a key rotated in place is not picked up until roma restarts.

The direction this creates is one-way, and it is the property the whole decision
buys: **the agent can narrow what it was given and can never widen it.** Google's
own downscoping is available to it — `downscopedclient` is in the installed
library — and minting is not, because minting needs the key.

### 4. roma mints from the named key, never through Application Default Credentials

The key file is loaded explicitly, by the path the environment gave. roma never
asks a Google library to *find* a credential, because finding one is a precedence
chain ending at the metadata server: on a Google host, a missing or unreadable
key would otherwise resolve silently to roma's own identity, and roma would mint
Cloud Tokens for the one identity §2 exists to exclude.

This repository has paid for the general version of that mistake already, in
`build-env.ts`:

> A union rather than two optional fields, because the two are mutually exclusive
> in fact and not only in intent: Claude Code resolves credentials in precedence
> order, so a process handed both runs on one and silently changes model.

Same shape, second vendor. A missing key must produce a *failure*, never a
*substitution*.

### 5. A Cloud Token is scoped to `cloud-platform`, and that is not configurable

The exchange requires naming scopes (see Verification status). roma names
`cloud-platform`, which is a constant and not a setting.

The value is chosen for what the sentence means: `cloud-platform` is "whatever
the roles allow", which is the Cloud Reach's definition. The boundary is meant to
be the IAM roles — visible to whoever deployed roma, auditable in Google's own
console, and changeable without touching roma. A configurable scope would be a
second boundary, invisible from there, whose failures present as "roma is broken"
rather than as "that scope is narrow".

Narrowing further is not lost, and it lands in the two places it belongs: the
roles, for a deployment that wants less; and Google's downscoping, for an agent
that wants less for one call.

### 6. The Cloud Shortcut exists to save Turns, and is not a boundary

One command in the agent's userland, `roma-cloud-token`, on `PATH`. Its purpose
is money: without it, every Task needing Google Cloud pays the model to write a
JWT signer and a token exchange again, and those Turns are Shared Window quota
with somebody waiting at the other end.

**What it prints:** the raw token on stdout, and nothing else. `--json` gives the
token, its expiry and the identity's account. The bare form is the common one and
is a one-liner — `curl -H "Authorization: Bearer $(roma-cloud-token)"` — with
nothing to parse, because a tool invented to save the model's output tokens
should not require the model to write a parser to use it. Expiry is in `--json`
rather than the default because re-running is free and stateless: an agent does
not need to reason about how long it has left, it needs to ask again.

**It is named for itself, not for somebody else.** `roma-` prefixed, unlike a
Credential Shim, which occupies the name of a vendor tool so the correct path is
taken without anybody choosing it. Nothing is being stood in front of here.

**It does not have to be complete, and is not.** Where it does not go far enough
the agent writes the API call itself. That is the Shortcut working as intended
rather than a gap in it — and the long way round is writing the *call*, never a
second route to a Cloud Token, because of §3.

**It is not a boundary.** The agent has a shell and can ignore it. Like a
Credential Shim (ADR-0008), what it does is make the cheap path the ordinary one.

### 7. The agent is told, in the announcement roma already makes

Discovery has to be free, or the tool defeats itself: a `--help` is a Turn, and a
Session remembers nothing, so it would be a Turn paid once per Session to save
Turns.

roma already solves this problem, for the other provider, and the solution says
so in its own first line — `src/github/announce.ts`:

> **A capability nobody knows about is a capability nobody has.** Claude Code in
> an empty directory has no reason to believe it can clone anything, and an agent
> that explains it has no access instead of trying is the failure this text exists
> to prevent.

That text is appended to every Session's system prompt at `startup.ts`, and it
tells the agent that credentials are present, what they reach, and that there is
nothing for it to renew or handle. A Cloud Reach needs those same three
sentences, so it goes in the same place: a sibling announcement, appended when a
deployment has one and absent when it has not.

**Amended.** This section first decided that roma would write a `CLAUDE.md` into
the Session's Working Directory, and rejected the system prompt on the grounds
that it is global where a file could vary per Session. That was written without
reading `announce.ts`, and it is wrong twice over: the mechanism already exists,
and a Cloud Reach *is* global — one per deployment, fixed at boot, identical in
every Session, which is the Installation's shape exactly. Nothing here needed a
new mechanism, and inventing one would have opened a second exception to
ADR-0008's "roma checks nothing out" for a fact that does not vary.

What that also buys is a thing that cannot be deleted. A file in the Working
Directory can be removed by the agent, after which the capability is invisible
again; the announcement cannot.

### 8. The key is proved live at boot, by using it

A Cloud Token is minted once at startup and discarded. Failure is one of the
problems the single `readConfiguration` refusal reports.

`readMinterEnv` is the precedent — it reads the App's PEM at boot "so that an
unreadable key is one of the problems a single boot reports rather than a failure
inside somebody's first Turn" — and so is the Startup Self-Check, which exists
because `claude auth status` "reports a token valid right up to the moment it
401s". A syntactically perfect but revoked service account key is that blind spot
in Google's colours, and here the real invocation is nearly free: no Turn, no
model, no money.

It lives beside the other configuration readers, **not** inside
`startup-self-check.ts`. `CONTEXT.md` defines that term as the live *Turn* roma
drives at boot; a check driving no Turn would make the definition false.

It proves the key is live. It does not prove the Cloud Reach has the roles a Task
will need, so permission-denied still surfaces inside a Turn.

### 9. A Cloud Reach is optional, and its absence is answered rather than refused

No key, no Cloud Reach: roma starts normally, says so once in the Operator Log,
and announces nothing about the cloud to any Session. The command is still
installed, and answers that this deployment has no Cloud Reach.

Installed rather than omitted because the alternative is `command not found`,
which a model reads as a broken `PATH` or a broken image and spends a Turn
investigating. One clear sentence costs nothing and is repeatable to a person.

**An earlier version refused to start on this**, applying `readOverflow`'s
both-or-neither rule to a CLI present without a key and a key present without a
CLI. §1 left one image, so neither mismatch can occur and there is nothing left
to pair. What survives of that refusal is §8, which is the half that was
protecting something: a key that exists and does not work still stops the boot.

### 10. An Audit Record says whether a Task used the Cloud Reach

One field, and it is a yes or a no.

Not a count. A count of mints is not a count of actions — one token does unlimited
API calls for an hour — so a number would be read as a measure of activity that
roma does not have. This repository already refuses that trade in the other
direction, writing an unpriced Turn down as unpriced rather than as free.

Not what was reached for, either, because roma cannot know. `CONTEXT.md` draws
the line for GitHub — "git names the repository every time it asks for a
credential, so what a Task reached for is free — and what it did once it got
there is not" — and on this side even the first half is not free: a request to
the Shortcut carries no destination, and asking the agent to declare one would
record an unverifiable self-report.

It records the ordinary path only. An agent that reaches the metadata server
itself is invisible here, the same honesty the `Requested-by:` trailer carries.

### 11. `infra/` provisions none of it, and roma's own identity is renamed

`infra/main.tf` is one project, and it is the project holding roma's control
plane — the topic, the subscription, the identity roma runs on. Creating the
Cloud Reach there would put it one IAM binding from the ingress it must never
touch, and would imply the agent's Google Cloud is roma's. Often it will not be:
roma may not run on Google Cloud at all, and the project the agent works in may
belong to somebody else.

`infra/README.md` gains a section instead, written like the one already refusing
to create service account keys: the manual steps, the recommendation that the
Cloud Reach live in a **different project** from the ingress, and the plain
statement that the roles on it are the whole boundary.

**And the identity roma runs on is renamed from `roma-agent` to `roma-runtime`.**
In roma's vocabulary the agent is the Claude Code process, and `roma-agent@` is
precisely the identity a Cloud Reach must never be. The name is not merely
imprecise, it is an invitation: somebody configuring the agent's Google Cloud
access finds an account named for exactly what they are setting up. A Google
Cloud account id is immutable, so this is a destroy-and-create — but
`service_account_id` is already a variable, so a deployment that pins the old
value in `terraform.tfvars` is untouched. One loud release note, against a name
that misleads forever.

## Consequences

- Nothing in the packaging changes: one `Dockerfile`, one image, one tag per
  release, one verification run. The question "which vendor's CLI do we ship?"
  never has to be answered, and it would have been asked again for AWS and again
  for Azure.
- The agent's Google Cloud work is written against Google's REST APIs by the
  model, per Task. It will be more verbose than CLI usage and sometimes wrong in
  ways a CLI would not have been. **That is this decision's live cost, and its
  reversal trigger: if the API half costs more in Turns than 439 MiB was worth in
  bytes, the CLI comes back**, and cheaply — the mechanism is in this file's
  history.
- The agent cannot copy a key it never had. What it can leak is an hour old — and
  it will sometimes leak, because a Cloud Token printed rather than captured
  lands in a Transcript roma never deletes (ADR-0006). That is the exact leak
  ADR-0008's minting was argued for bounding, and it is bounded the same way.
- **On a Google host, none of this stops the agent reaching the metadata server
  itself** and standing in roma's own identity — one `fetch`, no credential, and
  roma has no egress control to prevent it. §2's separation bounds the Cloud
  Reach, not the host. A GCE deployment's real exposure is whatever roma's own
  service account can do, which is an argument for keeping it at the
  `pubsub.subscriber` it has today and nothing more.
- One Cloud Reach for the whole deployment. `/clear` does not narrow it, a
  Conversation cannot have its own, and there is no per-Caller scoping — an
  Installation's property, worth stating because a fresh Session reads like a
  fresh everything.
- Nothing new is put into a Working Directory. An Enclosure remains the only
  thing roma lands there, and ADR-0008's "roma checks nothing out" keeps its one
  exception rather than gaining a second.
- Renaming the deployment identity is a real operation for anybody already
  running roma: a destroyed and recreated service account, re-bound grants, a
  reissued key. Pinning `service_account_id` avoids all of it.

## Alternatives considered

**Ship `gcloud` in a second image tag, pinned like `gh`.** This record's own
first decision. Rejected once measured: 439 MiB against a slim runtime, buying
convenience only, plus a doubled build-and-verify on every release and a tag
matrix that would grow again with the next vendor.

**Widen the one image.** Rejected harder, and for the reason it was rejected
before: every deployment that never touches a cloud pays for it, on a public
registry, permanently.

**Install a CLI at boot when a Cloud Reach is configured.** Rejected. A container
whose contents depend on what a package index served that morning is not a pinned
artifact, and it puts a large download inside a boot path whose job is to refuse
quickly and say why.

**A static service account key in the agent's environment, with roma minting
nothing.** This record's own second decision, and it is gone because its price
changed rather than because its argument was wrong. It bought "nothing is built",
and once the CLI went there was little left to build. It cost an unexpiring key a
shell could read and copy into a Transcript roma never deletes, and every scrap
of attribution for Google Cloud work.

**Pass roma's own credential through to the agent.** Free, and it is the failure
this record exists to prevent. It also happens by *doing nothing at all* on a
Google host, which is why §4 loads the key explicitly rather than merely
declining to set a variable.

**Let the agent choose a Cloud Token's scopes per call.** Rejected as
self-defeating: an upper bound the requester picks is not a bound, and it would
present as a control while controlling nothing. Downscoping already gives an
agent that genuinely wants less a way to have it.

**No Cloud Shortcut — let the agent write the exchange every time.** Rejected on
the cost it was invented to remove: the same signer and the same exchange, paid
for out of the Shared Window, once per Task that needs Google Cloud.

**Tell the agent about the Shortcut in every message.** Rejected. ADR-0009 and
ADR-0012 fixed the order of what sits above a message and what a Readout may
carry; adding standing tool documentation to that frame repeats it on every
message for a fact that never changes within a deployment at all.

**Write it into a `CLAUDE.md` in the Working Directory.** This section's first
decision, amended in §7. Rejected once `announce.ts` was read: it invents a
mechanism roma already has, opens a second exception to ADR-0008's "roma checks
nothing out", and produces a notice the agent can delete — all to make a
deployment-wide constant vary per Session.

**Have `infra/` create the Cloud Reach with no roles bound**, as a named
placeholder. Rejected: it puts the agent's identity in the project holding roma's
control plane, and implies that is where it belongs.
