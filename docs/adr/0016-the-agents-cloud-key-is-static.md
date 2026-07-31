# 16. The agent's Cloud Key is static, and roma mints nothing

Date: 2026-07-31

## Status

Accepted, and **unbuilt**. Nothing below exists in the repository yet, and the
same warning ADR-0015 carries applies here: this is a design agreed in one
sitting, not a report on anything that has run.

Builds on ADR-0015, which decided that `gcloud` reaches an agent through a second
image rather than a wider one. This ADR decides what it authenticates as.

Deliberately **departs from ADR-0008** on the one question the two share. That is
the substance of this document, and it is argued rather than assumed.

### Verification status

- **Not measured — that `gcloud` can be pinned to one identity from outside the
  binary.** Google's Application Default Credentials is a precedence chain, and
  the Decision below cuts it to one rung. The mechanism is expected to be
  environment variables and has not been tested. If it turns out `gcloud` cannot
  be pinned this way, **the decision stands and the means must change** — a
  per-Session configuration written by roma, or a wrapper. What may not happen is
  the fallback being left in place because pinning it was awkward.
- **Not measured — that a service account key can be proved live at boot cheaply.**
  Minting an access token from a key with `google-auth-library` is expected to be
  sub-second and free. It is neither timed nor run.
- **Not measured — anything else.** No part of this has been deployed.

## Context

ADR-0008 answered this question for GitHub, and answered it the other way.

> **Minter**: The only thing that holds the App's private key, and therefore the
> only thing that can produce an Installation Token. […] the private key never
> enters the space the agent can reach.

The argument that got it there is an arithmetic one, and it transfers whole:

> An hour long, asked for at the moment a tool needs one, and never put in a
> process environment — an environment is fixed at spawn and would be stale
> within the hour, and a token that reaches a Transcript is in a record roma
> never deletes.

A Google Cloud access token is also about an hour. A Resident Session outliving an
hour is ordinary. roma also already has the means: `google-auth-library` is a
runtime dependency — it survives `npm ci --omit=dev` — so minting is available
without adding anything.

So the Minter's reasoning applies here in full, and this ADR does not follow it.

Two further facts shape what is being decided:

**roma does not necessarily run on Google Cloud.** ADR-0003 expects a GCE VM and
that is not a requirement; a deployment may hold a service account key from
somewhere else entirely. The credential therefore cannot be assumed ambient.

**On a Google host the opposite risk appears.** `gcloud` with no credential
configured is not `gcloud` with no identity: it reaches the metadata server and
authenticates as the VM's own service account — which is roma's, the one holding
`pubsub.subscriber` on roma's own ingress. Nobody has to configure anything for
that to happen. It happens on exactly the hosts roma is designed for and on no
developer machine, so it is invisible until it is production.

## Decision

### 1. A Cloud Reach, and it is not the identity roma runs on

One Google Cloud identity, chosen by whoever deploys roma. The roles they gave it
are the whole of what the agent can touch. Every Conversation reaches all of it,
and so does everyone who can message roma — the same shape as an Installation and
for the same reason. roma neither sets it nor can check it: work refused for want
of a role is refused by Google, never by roma.

It is **not** the identity roma itself runs on. An agent standing in roma's own
identity can delete the subscription roma pulls from, publish forged events to the
topic roma trusts, and mint itself a key that outlives every rotation — and each
of those presents as roma quietly not working rather than as an attack. A
deployment where those two identities are the same has no boundary at all.

### 2. The Cloud Key is static, and it goes into the agent's environment

A service account key file, mounted, named to roma by a path rather than inline —
following `ROMA_GITHUB_PRIVATE_KEY_FILE` and `GOOGLE_APPLICATION_CREDENTIALS` on
the rule already written down in this repo: multi-line secrets belong in mounts.

`buildEnv`'s allowlist grows by what it takes to point a Session's tools at that
file. That file's own rule is that it "admits almost nothing — so widening the
list needs saying rather than doing", and this is the saying.

No Minter for Google Cloud. No Credential Shim for Google Cloud. Nothing is minted
per invocation, and the credential the agent holds does not expire.

### 3. One identity, never a chain

Application Default Credentials resolves in precedence order. roma cuts it to one
rung, **always** — with a Cloud Key configured and without one. The agent's
`gcloud` authenticates as the Cloud Reach or it fails to authenticate.

Specifically: the metadata server is cut off whether or not a Cloud Key exists,
so a missing, revoked, unreadable or rotated-away key produces a *failure* and
never a *substitution*.

This repository has already paid for the general version of this mistake, in
`build-env.ts`:

> A union rather than two optional fields, because the two are mutually exclusive
> in fact and not only in intent: Claude Code resolves credentials in precedence
> order, so a process handed both runs on one and silently changes model.

Same shape, second vendor. The same file also insists that an absent variable be
absent rather than empty, "because an empty string still occupies its slot in
credential precedence". A fallback rung is that empty string with a service
account behind it.

### 4. Both or neither

Refused at boot, in the one refusal `readConfiguration` makes:

- a `-gcloud` image with **no Cloud Key** — the agent gets a tool that can only
  fail, and it will not know that, so it will try, retry and work around, on real
  Turns against the Shared Window with somebody waiting;
- a plain image with **a Cloud Key** — a private key mounted where nothing can use
  it. Pure blast radius, zero capability: no `gcloud` does not mean no reach, and
  the agent still has a shell and `curl`.

This is `readOverflow`'s rule, applied unchanged: "both or neither, and never
one." Which image roma is in is **asked** rather than declared — roma looks for
the real binary at the path a variable names, following `ROMA_GH_BIN`.

### 5. The Cloud Key is proved live at boot, by using it

An access token is minted from the key once at startup and thrown away. Failure is
one of the problems the single refusal reports.

The precedent is `readMinterEnv`, which reads the App's PEM at boot "so that an
unreadable key is one of the problems a single boot reports rather than a failure
inside somebody's first Turn" — and the Startup Self-Check, whose whole existence
is the refusal to accept a check that is not a real invocation: `claude auth
status` "reports a token valid right up to the moment it 401s". A syntactically
perfect but revoked service account key is that blind spot, in Google's colours.

Here the real invocation is nearly free — no Turn, no model, no money — so the
Self-Check's guarantee is available at none of the Self-Check's cost.

This lives beside the other configuration readers and **not** inside
`startup-self-check.ts`. That term is defined in `CONTEXT.md` as the live *Turn*
roma drives at boot; putting a check that drives no Turn inside it would make the
definition false.

It proves the key is live. It does not prove the Cloud Reach has the roles the
agent will need — roma cannot know what it will be asked to do, so a
permission-denied still surfaces inside a Turn.

### 6. `gcloud`'s own state is per-Session

`gcloud` is stateful, and `buildEnv` passes `HOME` through to every Session, so
its configuration directory would otherwise be one directory shared by all of
them and reclaimed by nothing. Two consequences, both bad: one Conversation's
`gcloud config set project` silently relocates another's work, and a credential
the agent activates for itself outlives `/clear`, outlives Eviction, and outlives
every Session, in a path no reclaim touches.

So each Session gets its own, on the Working Directory's clock: replaced when
`/clear` moves the Session Generation, reclaimed with everything else after seven
idle days (ADR-0003).

`ROMA_SHIM_DIR`'s rule decides that this is defaulted rather than required —
default what is lost by design, refuse what cannot be lost. Nothing here is
anybody's data: the account of what an agent did is the Transcript (ADR-0005),
and this holds CLI preferences and caches.

Like the Credential Shims, this is not a boundary against the agent. It has a
shell and can write wherever it likes. It bounds how long the ordinary path's
leftovers last.

### 7. `infra/` provisions none of it, and roma's own identity is renamed

`infra/main.tf` is one project, and it is the project holding roma's control
plane — the topic, the subscription, the identity roma runs on. Creating the Cloud
Reach's identity there would put it one IAM binding away from the ingress it must
never touch, and would imply that the agent's Google Cloud is roma's Google Cloud.
It frequently will not be: roma may not run on Google Cloud at all, and the
project the agent works in may belong to somebody else entirely.

`infra/README.md` gains a section instead, written like the one that already
refuses to create service account keys: the manual steps, the recommendation that
the Cloud Reach live in a **different project** from the ingress, and the plain
statement that the roles on it are the whole boundary.

**And the identity roma runs on is renamed from `roma-agent` to `roma-runtime`.**
In roma's vocabulary the agent is the Claude Code process, and `roma-agent@` is
precisely the identity a Cloud Reach must never be. The name is not merely
imprecise, it is an invitation: somebody setting up the agent's Google Cloud
access, looking through a console for the right account, finds one named for
exactly what they are configuring. The account id is immutable in Google Cloud, so
this is a destroy-and-create — but `service_account_id` is already a variable, so
an existing deployment that pins the old value in `terraform.tfvars` is untouched.
A loud release note, once, against a name that misleads forever.

## Why static, when ADR-0008 argued the other way

**What is given up, stated plainly:**

- The Cloud Key does not expire. ADR-0008's minting is explicit that it "is not a
  boundary against the agent […] what it bounds is how long a token that escapes
  is worth anything". This ADR has no such bound.
- The agent can read it. It has a shell and the path is in its environment, so it
  can copy the key, use it elsewhere, or put it in a Transcript roma never deletes
  (ADR-0006).
- roma sees no `gcloud` invocation, so **an Audit Record says nothing at all about
  Google Cloud.** The GitHub side can honestly name the repositories a Task
  reached for, because `git` announces one every time it asks for a credential.
  There is no equivalent here and there cannot be: nothing passes through roma.
  Attribution for Google Cloud work stops at "somebody had the Cloud Key".

**What is bought:** none of it is built. No second Minter, no second Shim, no
widening of the wire between a Shim and roma — which is GitHub-shaped today,
carrying a session, an operation and a repository path — no wrapper in the image,
no tests for any of it.

**Why the trade is acceptable:** because the bounding is being done by the Cloud
Reach and not by the credential's lifetime. A one-hour token on an identity that
can delete a project is worse than a permanent key on one that can read a bucket.
ADR-0008 bounds the *value of a leak*; this bounds the *value of the identity*,
and asks the deployment to do that job by choosing roles.

**And it is a decision, not a gap.** The distinction matters, because this
repository already has the other kind: `docs/github-app-verification.md` records
that the agent can read the GitHub App's private key today — same container, same
uid — and says out loud that "ADR-0008 claims otherwise and is wrong about that".
That is a gap being confessed. This is not. The Cloud Key is in the agent's
environment on purpose, and nothing in this repository should claim otherwise.

**How it reverses.** If the trade goes wrong, the replacement is a Google Cloud
Credential Shim minting per invocation — the ADR-0008 design, second vendor. The
Cloud Reach survives that unchanged; it is the Cloud Key that is replaced. This is
written so the reversal is a swap of one term for one mechanism, not a redesign.

## Consequences

- Attribution for Google Cloud does not exist, at either end. ADR-0002 established
  that the provider attributes nothing and the Audit Record is the only place the
  question of who is answerable; for Google Cloud there is now no such place.
- Because roma hands over a *path* and not a secret, a key rotated in place is
  picked up by the next invocation with no restart. The boot-time proof is then a
  statement about the key that was there at boot, and nothing re-checks it.
- One Cloud Reach for the whole deployment. `/clear` does not narrow it, a
  Conversation cannot have its own, and there is no per-Caller scoping — the same
  property an Installation has, and worth stating because people will assume a
  fresh Session is a fresh anything else.
- `buildEnv`'s allowlist is no longer only PATH-shaped variables and roma's own
  two: it now carries a pointer to a credential. That file's opening claim —
  "Nothing is inherited implicitly" — stays true, but the list is a weaker
  statement than it was.
- Renaming the deployment identity is a real operation for anybody already
  running roma: a destroyed and recreated service account, re-bound grants, a
  reissued key. Pinning `service_account_id` avoids all of it.
- The refusal in §4 means the two images are not interchangeable at runtime. A
  deployment moving from `X.Y.Z` to `X.Y.Z-gcloud` must set a Cloud Key in the
  same change, and one moving the other way must remove it.

## Alternatives considered

**A Google Cloud Credential Shim, minting per invocation.** ADR-0008's design,
applied to the second provider, and the technically better answer: it needs no new
dependency, the one-hour arithmetic is identical, and it would let an Audit Record
say what a Task reached for. Rejected on cost for now — a second Minter, a wire
protocol currently shaped entirely around repositories, a wrapper in the image,
and a `gcloud`-side mechanism nobody has confirmed exists. It is the named
reversal path above rather than a road not taken.

**Pass roma's own credential through to the agent.** Free, and it is the failure
this ADR exists to prevent. It also happens by *doing nothing at all* on a Google
host, which is why §3 cuts the chain rather than merely declining to set a
variable.

**`gcloud auth activate-service-account` once at boot, into a shared
configuration directory.** Rejected: it takes both costs — a long-lived
credential written to disk exactly where the agent reads, plus shared mutable
state across every Session.

**Let Application Default Credentials fall back as designed.** Rejected. A
fallback that only fires when the intended credential fails is the worst
available: it turns a loud failure into a silent identity change, on the hosts
where the substitute identity is roma's own, and nowhere a developer would ever
see it.

**Have `infra/` create the Cloud Reach with no roles bound**, as a named
placeholder. Rejected. It puts the agent's identity in the project holding roma's
control plane and implies that is where it belongs.
