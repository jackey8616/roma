# 15. roma installs no cloud CLI

Date: 2026-07-31

## Status

Accepted, and **unbuilt**. Nothing below exists in the repository yet.

**Replaces an earlier version of this same ADR, reversed by measurement in the
session that wrote it.** That version decided `gcloud` would ship in a second
image tag, `X.Y.Z-gcloud`, pinned by tarball and checksum with the ceremony `gh`
gets. It rested on two unmeasured claims, said so in its own Verification status,
and named the first of them as the one carrying the whole decision. Both were
then measured, within the hour, and the second killed it.

The reversal is recorded rather than tidied away, because the measurements below
*are* the decision. An ADR reaching this conclusion without them would be a
preference.

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
each from this sandbox, with deliberately invalid credentials:

| endpoint | answered |
| --- | --- |
| `oauth2.googleapis.com/token` | `invalid_request` |
| `login.microsoftonline.com/…/oauth2/v2.0/token` | `AADSTS700016: Application with identifier 'bogus' was not found` |
| `sts.amazonaws.com` | `MissingAuthenticationToken` |

Each rejected the *credential* rather than the request: a valid one would have
been exchanged. Azure's is a plain POST with no signing at all.

**What that last measurement is not.** It was taken from this session's sandbox
and not from a roma deployment, so it establishes the protocol shape and not any
particular deployment's egress. The README states that roma has no egress
allowlist and no firewall, which is the only reason the shape is the whole story.

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
Google Cloud arrived as the same request. It does not bring the same evidence.

## Decision

**No cloud CLI ships — not in this image, and not in a second one.**

The agent is handed a Cloud Token by a Cloud Shortcut instead (ADR-0016). That is
a module in `dist/`, measured in kilobytes, and it changes the image by nothing.

`Dockerfile` is untouched. `src/packaging.test.ts` gains no third pinned version.
`release.yml` still publishes exactly one image tag, `scripts/verify-image.sh`
still runs once, and ADR-0007's "one image, no floating tags" needs no
qualification.

### Why 439 MiB buys nothing

The capability is already in the image. roma **is** a Node program, so Node
cannot be taken out, and Node alone signs both credential shapes and speaks
HTTPS. A CLI does not add access to a cloud. It adds convenience.

### A CLI would not have been a boundary either

Written down because the earlier version of this ADR argued it from reasoning and
this version can show it, and because it is the misreading that costs money.

**An image without a cloud CLI is not an agent that cannot reach a cloud.** The
measurements cover Amazon Web Services and Azure too, neither of which was under
discussion: Azure's client-credentials exchange is one POST with no signature,
AWS's is forty lines of HMAC. Whatever bounds what an agent can do in a cloud, it
is not the contents of `/usr/local/bin`. For Google Cloud it is the Cloud Reach,
and nothing else (ADR-0016).

### What is actually given up, and what would reverse this

Convenience, and a real amount of it. `gcloud storage ls` is one command; the
same thing over REST is a URL, a header and a parse — more of the model's output,
on every Task that touches a bucket, forever. A CLI is a compression format for
API knowledge, and declining to ship one moves that cost onto Turns.

That is the same currency the Cloud Shortcut is built to save, which makes this
ADR and ADR-0016 a matched pair: the Shortcut makes the *credential* free and
leaves the *API* to the model. **If the API half turns out to cost more in Turns
than 439 MiB was worth in bytes, this decision reverses** — and cheaply, because
the version it replaces is in this file's history with the mechanism already
worked out.

## Consequences

- Nothing in the packaging changes: one `Dockerfile`, one image, one tag per
  release, one verification run. The whole tag-matrix consequence list the
  earlier version carried is gone.
- The question "which vendor's CLI do we ship?" never has to be answered, and it
  would have been asked again for AWS and again for Azure. The answer is now
  structural rather than per-vendor.
- The agent's Google Cloud work is written against Google's REST APIs by the
  model, per Task. It will be more verbose than CLI usage, and sometimes wrong in
  ways a CLI would not have been.
- There is no CLI state to isolate per Session, which removes a decision the
  earlier version had to make about a configuration directory shared through
  `HOME`.

## Alternatives considered

**Ship `gcloud` in a second image tag, pinned like `gh`.** This ADR's own
previous decision. Rejected once measured: 439 MiB against a slim runtime, buying
convenience only, plus a doubled build-and-verify on every release and a tag
matrix that would grow again with the next vendor.

**Widen the one image.** Rejected harder, and for the reason it was rejected
before: every deployment that never touches a cloud pays for it, on a public
registry, permanently.

**Ship nothing and publish a `FROM ghcr.io/…/roma:X.Y.Z` recipe** so an operator
can layer a CLI on. Not rejected so much as made unnecessary — it is simply what
is now true, and it needs no recipe from roma. An operator who wants `gcloud`
badly enough can add it, and the Cloud Shortcut goes on working beside it.

**Install a CLI at boot when a Cloud Reach is configured.** Rejected. A container
whose contents depend on what a package index served that morning is not a pinned
artifact, and it puts a large download inside a boot path whose job is to refuse
quickly and say why.
