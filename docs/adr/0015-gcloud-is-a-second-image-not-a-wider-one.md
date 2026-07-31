# 15. `gcloud` is a second image, not a wider one

Date: 2026-07-31

## Status

Accepted, and **unbuilt**. Nothing below exists in the repository yet.

Written as a settled design before any code, which is the shape ADR-0008 used and
carries the same warning ADR-0008 had to apologise for afterwards: this is a
design somebody agreed to in one sitting, not a report on anything that has run.
The code that follows is expected to disagree with parts of it, and where it does,
the disagreement belongs here rather than in a quiet edit.

Does **not** amend ADR-0007. That decision pins one Claude Code and refuses a tag
that moves; `X.Y.Z-gcloud` is as exact and as immutable as `X.Y.Z`, and a second
shape of image is not a floating one. What ADR-0007 forbids is a tag whose
contents change underneath a deployment, and nothing here creates one.

### Verification status

**Nothing here has been measured, and one unmeasured claim carries the whole
decision.**

- **Not measured — what `gcloud` costs an image.** The premise is that it is
  large: a Python runtime and a component tree, against a runtime layer that is
  today `node:22-slim` plus five apt packages and one Go binary. That is general
  knowledge rather than a number from a build. **If a build shows the addition is
  small, this ADR's only reason is gone** and it should be reversed rather than
  kept because it is written down.
- **Not measured — what a second build costs the release.** The release workflow
  builds, loads and verifies one image today. Two is assumed to roughly double
  that step and to remain acceptable; nobody has timed it.

## Context

`Dockerfile`'s runtime stage says what it is:

> Deliberately small. roma's agent runs arbitrary shell commands, so this image
> is a workspace and not only a runtime — but guessing at which tools it will
> want produces an image nobody can explain, every line of it attack surface on a
> public registry. […] Widening this list is a separate decision with its own
> evidence.

`gh` is the one widening that has happened, and it came with the evidence the
sentence asks for: issues and pull requests are a good part of what roma is for,
this repository's own tracker is GitHub Issues, and `gh` is the only tool that can
be handed a freshly minted Installation Token on every invocation. It arrives as a
release tarball with a hardcoded sha256, pinned so that "nobody moves it without
deciding to".

Google Cloud is now the same request, with a worse ratio. Some deployments want
the agent to do Google Cloud work — this repository's own `infra/` is Terraform
against a Google Cloud project, and roma's ingress lives there. Many deployments
will never touch Google Cloud at all, and every one of them would carry the tool.

## Decision

**The image that exists today does not grow. A second image tag carries
`gcloud`, and the reason is size.**

- One `Dockerfile`, one build argument. The plain image is what it is today; the
  second build adds `gcloud` and nothing else.
- Two published image tags per release: `X.Y.Z` exactly as now, and
  `X.Y.Z-gcloud`. The **git** tag shape is unchanged — `release.yml` still
  triggers on `[0-9]+.[0-9]+.[0-9]+` and still asserts the tag against
  `package.json` before anything is built. What changes is that it publishes two
  image tags instead of one, and **verifies both before pushing either**.
- `gcloud` is pinned by version and checksum, with the second copy in
  `src/packaging.test.ts`, exactly as `gh` is — and deliberately **without** the
  weekly drift notification Claude Code gets, on `gh`'s own stated rule: it is
  pinned so that nobody moves it without deciding to, not because moving it costs
  a re-verification.
- The image declares what it carries: a label
  `io.github.jackey8616.roma.gcloud.version`, **absent** on the plain image.
  `scripts/verify-image.sh` reads the label and then asks the container, which is
  what it already does for Claude Code — ask the image what it claims, then check
  the claim, rather than be told by a parameter.
- `infra/` provisions nothing for this. See ADR-0016.

### The reason is size, and saying so is part of the decision

Not security. The other reading is available, obvious, and wrong, so it is
refused here in writing: **an image without `gcloud` is not an agent that cannot
reach Google Cloud.**

The agent has a shell. `curl` is already in the image — installed for `gh`'s
tarball and left there. There is no egress allowlist and no firewall, which the
README states plainly. A service account key is an HTTPS POST away from an access
token, and Google's REST APIs need no client library. Removing a convenient CLI
removes convenience.

What bounds what the agent can do in Google Cloud is the Cloud Reach, and nothing
else (ADR-0016). This is written down because the next person to read "`gcloud` is
optional" will otherwise take it for a boundary and reason onwards from there —
and the conclusions they reach will be wrong in the direction that costs money.

## Consequences

- Every release builds and verifies two images. Both must pass before either is
  pushed: a `-gcloud` image published while the plain one failed is half a
  release, and there is no way to take an image tag back off GHCR.
- `docker run` without a tag already fails (ADR-0007). Choosing a tag now also
  chooses a shape, and the tag string is the only place that choice is recorded —
  there is no runtime flag that turns `gcloud` on.
- `scripts/verify-image.sh` runs twice per release against different
  expectations, and the label is what tells it which image it has.
- `src/packaging.test.ts` gains a third pinned version to hold a second copy of.
- The README's environment table gains variables that mean nothing on one of the
  two images. That mismatch is not left to documentation: ADR-0016 refuses to
  start on it.
- Someone will eventually want a third tool this way — Terraform, `kubectl`, a
  cloud SDK for somebody else. This ADR sets the precedent that the answer is
  another image rather than a wider one, and two shapes is already the point at
  which the tag matrix is worth watching. A fourth is a decision to make
  deliberately, not by following this one.

## Alternatives considered

**Widen the one image.** Rejected on size, and the cost falls on exactly the
wrong people: every deployment that will never set a Cloud Key pays for the tool,
on a public registry, forever.

**A separate image name — `ghcr.io/…/roma-gcloud:X.Y.Z`.** Rejected. Version
parity becomes a convention rather than something the name enforces:
`roma:0.5.0` beside `roma-gcloud:0.4.0` is perfectly legal and says nothing about
whether the two came from the same commit. A tag suffix keeps them one package
with one version.

**Ship nothing; document a `FROM ghcr.io/…/roma:X.Y.Z` recipe and let each
operator layer `gcloud` on themselves.** Rejected, and it is the tempting one
because it costs nothing. It hands the pin to whoever writes the derived
Dockerfile, so `gcloud`'s version drifts with whoever rebuilds and when — which is
the exact failure the tarball-and-checksum ceremony exists to prevent for `gh`.
roma would also have nothing to verify: `scripts/verify-image.sh` can only ask
questions of an image roma built.

**Install `gcloud` at boot when a Cloud Key is configured.** Rejected. A
container whose contents depend on what a package index served that morning is
not a pinned artifact, and it puts a download inside a boot path whose whole job
is to refuse quickly and say why.
