# 16. roma mints the agent's Cloud Token

Date: 2026-07-31

## Status

Accepted, and **unbuilt**. Nothing below exists in the repository yet.

**Replaces an earlier version of this same ADR**, which decided the opposite: a
static service account key handed into the agent's own environment, unexpiring
and readable by a process with a shell, with roma minting nothing. That version
argued the departure from ADR-0008 honestly and rested it entirely on cost —
"a second Minter, a wire protocol currently shaped entirely around repositories,
a wrapper in the image, and a `gcloud`-side mechanism nobody has confirmed
exists."

ADR-0015's reversal deleted most of that list. With no CLI shipping there is no
wrapper, no vendor protocol to match and no unconfirmed mechanism — and what is
left is small enough that the concession is no longer worth making. So this ADR
returns to ADR-0008's posture rather than departing from it.

Extends ADR-0008 rather than qualifying it: the same rule, a second provider.

### Verification status

- **Measured — the exchange needs nothing that is not already here.** An RS256
  JWT can be signed with `node:crypto` alone, and `google-auth-library` is
  already a runtime dependency, surviving `npm ci --omit=dev`. See ADR-0015 for
  the measurements.
- **Not measured — the cost of minting.** A key exchange is expected to be
  sub-second and free. Neither timed nor run against a real service account.
- **Not measured — anything else.** No part of this has been deployed, and no
  real Cloud Reach has ever existed.

## Context

ADR-0008 settled this question for GitHub:

> **Minter**: The only thing that holds the App's private key, and therefore the
> only thing that can produce an Installation Token. […] the private key never
> enters the space the agent can reach.

The reason it got there is arithmetic, and it transfers whole:

> An hour long, asked for at the moment a tool needs one, and never put in a
> process environment — an environment is fixed at spawn and would be stale
> within the hour, and a token that reaches a Transcript is in a record roma
> never deletes.

A Google Cloud access token is also about an hour. A Resident Session outliving
an hour is ordinary. `google-auth-library` is already a runtime dependency, so
the means are present.

Two further facts shape the rest:

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

### 1. A Cloud Reach, and it is not the identity roma runs on

One Google Cloud identity, chosen by whoever deploys roma. The roles they gave it
are the whole of what the agent can touch. Every Conversation reaches all of it,
and so does everyone who can message roma — an Installation's shape, on a second
provider.

It is **not** the identity roma itself runs on. An agent standing in roma's own
identity can delete the subscription roma pulls from, publish forged events to
the topic roma trusts, and mint itself a key that outlives every rotation — each
of which presents as roma quietly not working rather than as an attack. A
deployment where those two identities are the same has no boundary at all.

### 2. roma mints; the key never enters the agent's space

The Minter holds the service account key, as it already holds the App's private
key, and produces a Cloud Token from it on request. One term for both because it
is one rule: a long-lived key never enters the space the agent can reach.

A Cloud Token is what the agent gets — an hour long, obtained when something
needs one, never written into a process environment fixed at spawn, and never
persisted anywhere that outlives the command it was made for.

The key is named to roma by a path rather than inline, following
`ROMA_GITHUB_PRIVATE_KEY_FILE` and `GOOGLE_APPLICATION_CREDENTIALS`: multi-line
secrets belong in mounts. It is **not** added to `buildEnv`'s allowlist. That
file's rule — "Nothing is inherited implicitly" — stays exactly as strong as it
is today.

### 3. roma mints from the named key, never through Application Default Credentials

The key file is loaded explicitly, by the path the environment gave. roma never
asks a Google library to *find* a credential, because finding one is a precedence
chain ending at the metadata server: on a Google host, a missing or unreadable
key would otherwise resolve silently to roma's own identity, and roma would mint
Cloud Tokens for the one identity §1 exists to exclude.

This repository has paid for the general version of that mistake already, in
`build-env.ts`:

> A union rather than two optional fields, because the two are mutually exclusive
> in fact and not only in intent: Claude Code resolves credentials in precedence
> order, so a process handed both runs on one and silently changes model.

Same shape, second vendor. A missing key must produce a *failure*, never a
*substitution*.

### 4. The Cloud Shortcut exists to save Turns, and is not a boundary

One command in the agent's userland that prints a Cloud Token. Its purpose is
money: without it, every Task needing Google Cloud pays the model to write a JWT
signer and a token exchange again, and those Turns are Shared Window quota with
somebody waiting at the other end.

Three things follow, and all three are the decision rather than caveats on it:

- **It does not have to be complete, and is not.** Where it does not go far
  enough the agent builds what it needs — with `node:crypto` and `fetch`, which
  ADR-0015 measured as sufficient. That is the Shortcut working as intended, not
  a gap in it.
- **It is not a boundary.** The agent has a shell and can ignore it. Like a
  Credential Shim (ADR-0008), what it does is make the cheap path the ordinary
  one.
- **It is not a Credential Shim.** A Shim occupies the name of somebody else's
  tool, so the correct path is taken without anybody choosing it. Nothing is
  being stood in front of here, and the agent chooses.

What it hands over is a Cloud Token and never the key, so the escape hatch costs
nothing: a hand-written call needs the token, not the credential it came from.

### 5. The key is proved live at boot, by using it

A Cloud Token is minted once at startup and discarded. Failure is one of the
problems the single `readConfiguration` refusal reports.

`readMinterEnv` is the precedent — it reads the App's PEM at boot "so that an
unreadable key is one of the problems a single boot reports rather than a failure
inside somebody's first Turn" — and so is the Startup Self-Check, which exists
because `claude auth status` "reports a token valid right up to the moment it
401s". A syntactically perfect but revoked service account key is that blind
spot in Google's colours, and here the real invocation is nearly free: no Turn,
no model, no money.

It lives beside the other configuration readers, **not** inside
`startup-self-check.ts`. `CONTEXT.md` defines that term as the live *Turn* roma
drives at boot; a check driving no Turn would make the definition false.

It proves the key is live. It does not prove the Cloud Reach has the roles a Task
will need, so permission-denied still surfaces inside a Turn.

### 6. A Cloud Reach is optional, and its absence is answered rather than refused

No key, no Cloud Reach, no Cloud Shortcut — and roma starts normally. Asked for a
Cloud Token, the Shortcut says this deployment has none.

**This replaces the earlier version's both-or-neither refusal**, which had two
image variants to disagree with each other (`readOverflow`'s rule, applied to a
CLI present without a key and a key present without a CLI). ADR-0015 left one
image, so neither mismatch can occur. What is left is a single optional
capability, and there is nothing dangerous about lacking it — the cost the
refusal was protecting against was an agent burning Turns discovering that its
tool could not work, and one clear sentence from the Shortcut buys that back
without a boot refusal.

### 7. `infra/` provisions none of it, and roma's own identity is renamed

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

### Deliberately not settled here

**What a Cloud Token is scoped to.** Minting requires scopes, and under the
version this replaces the question did not exist — the agent signed for itself
and chose. It now belongs to roma, and a default of `cloud-platform` is the whole
Reach in one string while a narrower default breaks work nobody predicted. Left
open on ADR-0008's precedent, which shipped a first slice and gave the rest
tickets of their own.

## Consequences

- An Audit Record can say something about Google Cloud again. Every Cloud Token
  passes through roma, so a Task's use of the Cloud Reach is recordable in the
  way `git` announcing a repository makes GitHub reach recordable. It records the
  ordinary path only — the agent can sign its own call and roma will never know —
  which is the same honesty `Requested-by:` carries.
- The agent cannot copy a key it never had. What it can leak is an hour old.
- **On a Google host, none of this stops the agent reaching the metadata server
  itself** and standing in roma's own identity — one `fetch`, no credential, and
  roma has no egress control to prevent it. §1's separation bounds the Cloud
  Reach, not the host. A GCE deployment's real exposure is whatever roma's own
  service account can do, which is an argument for keeping it at the
  `pubsub.subscriber` it has today and nothing more.
- One Cloud Reach for the whole deployment. `/clear` does not narrow it, a
  Conversation cannot have its own, and there is no per-Caller scoping — an
  Installation's property, worth stating because a fresh Session reads like a
  fresh everything.
- The key is read at boot, so a key rotated in place is not picked up until roma
  restarts. The opposite of the version this replaces, where roma handed over a
  path and never looked again.
- Renaming the deployment identity is a real operation for anybody already
  running roma: a destroyed and recreated service account, re-bound grants, a
  reissued key. Pinning `service_account_id` avoids all of it.

## Alternatives considered

**A static Cloud Key in the agent's environment, with roma minting nothing.**
This ADR's own previous decision, and the reason it is gone is that its price
changed rather than that its argument was wrong. It bought "nothing is built",
and once ADR-0015 removed the CLI there was little left to build. It cost an
unexpiring key a shell could read and copy into a Transcript roma never deletes
(ADR-0006), and every scrap of attribution for Google Cloud work. Not worth it at
the new price.

**Pass roma's own credential through to the agent.** Free, and it is the failure
this ADR exists to prevent. It also happens by *doing nothing at all* on a Google
host, which is why §3 loads the key explicitly rather than merely declining to
set a variable.

**Let Application Default Credentials resolve as designed, inside roma.**
Rejected. A fallback that fires only when the intended credential fails turns a
loud failure into a silent identity change, and the substitute is roma's own
identity.

**No Cloud Shortcut — let the agent write the exchange every time.** Rejected on
the cost it was invented to remove: the same signer and the same exchange, paid
for out of the Shared Window, once per Task that needs Google Cloud.

**Have `infra/` create the Cloud Reach with no roles bound**, as a named
placeholder. Rejected: it puts the agent's identity in the project holding roma's
control plane, and implies that is where it belongs.
