# roma, as the thing ADR-0003 said it would run as: a container on a long-running
# GCE VM. ADR-0007 is the decision record for everything below.
#
# Two stages, because they want opposite things. The builder needs the whole
# toolchain — TypeScript, the test-only dependencies, the lot — and produces one
# directory. The runtime needs that directory, the two runtime dependencies, and
# Claude Code, and nothing the builder used is allowed to follow it in.

# The Claude Code this image carries, exact rather than floating.
#
# Every measurement in this repository is evidence about this build and no other
# (ADR-0003), so `@latest` would move it on every rebuild with nobody deciding
# to, and CI would stay green while it happened — seam 2 does not run there.
# Moving this number is a re-verification event, not a dependency bump:
# `src/packaging.test.ts` carries the second copy that turns editing it alone
# red, and `docs/adr/0007-a-container-image-pinned-to-one-claude-code.md` says
# what the re-verification is. Named exactly rather than globbed: `0006-*` used
# to match this file and matches a different decision now.
ARG CLAUDE_CODE_VERSION=2.1.220

# The GitHub CLI the image carries, and the checksum of the tarball it comes in.
#
# Pinned with the same ceremony as Claude Code above — `src/packaging.test.ts`
# carries the second copy, so editing this alone turns the run red — and
# deliberately *without* the drift notification that one gets. The asymmetry is
# the point: Claude Code is pinned because every measurement in this repository
# is evidence about one build of it, and `gh`'s version invalidates no
# measurement. It is pinned so that nobody moves it without deciding to, not
# because moving it costs a re-verification.
#
# A release tarball with a hardcoded sha256 rather than a third-party apt source,
# which would float the version across rebuilds with nobody deciding to — and
# rather than a checksum fetched from the same place as the tarball, which only
# detects corruption. One architecture is built here, so one checksum is the
# whole maintenance cost.
#
# That architecture is **amd64**, and this file does not enforce it — the
# workflows do, with `platforms: linux/amd64`. A bare `docker build` on an Apple
# Silicon machine therefore produces an arm64 image carrying this amd64 binary,
# which runs only because Docker Desktop emulates it and would fail on a real
# arm64 host. Not defended here with `FROM --platform=`, because that would force
# every local build through emulation for `npm ci` and `tsc` as well; defended in
# `scripts/verify-image.sh`, which refuses an image whose `gh` disagrees with the
# architecture it claims. Build locally with `--platform linux/amd64` to get the
# image that ships.
ARG GH_VERSION=2.96.0
ARG GH_SHA256=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60

# ---------------------------------------------------------------------------
# Builder: everything installed, `dist/` out.
# ---------------------------------------------------------------------------
FROM node:26-slim AS builder

WORKDIR /app

# The manifests alone first, so the install layer survives every change that is
# only to source.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime: `dist/`, the two dependencies it imports, and an agent's userland.
# ---------------------------------------------------------------------------
FROM node:26-slim AS runtime

# Deliberately small. roma's agent runs arbitrary shell commands, so this image
# is a workspace and not only a runtime — but guessing at which tools it will
# want produces an image nobody can explain, every line of it attack surface on a
# public registry. `git` because that is what the agent is for; `ca-certificates`
# because every outbound call it makes is TLS; `tini` because roma spawns
# `claude` processes and a Node.js process running as PID 1 reaps nothing, so
# without it a stopped Turn leaves a zombie behind for the life of the container.
# Widening this list is a separate decision with its own evidence.
#
# `curl` is here for the line below and for nothing else: `gh` arrives as a
# release tarball rather than a package, so something has to fetch it.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

# `gh`, and the evidence for widening the list above: issues and pull requests
# are a good part of what roma is for — this repository's own issue tracker *is*
# GitHub Issues — and `gh` is the only tool that can be handed a freshly minted
# Installation Token on every invocation (ADR-0008, as amended). The GitHub MCP
# server cannot: its token is an environment variable read once at launch, and an
# MCP server starts once per Session and stays.
#
# The binary goes somewhere that is **not on PATH**, and the Credential Shim is
# installed under the name `gh` instead. So the only `gh` an agent can reach is
# the one that mints per invocation. That is not a boundary against the agent —
# it has a shell and the real binary is right there — it is what makes the
# ordinary path the correct one.
ARG GH_VERSION
ARG GH_SHA256
RUN curl --fail --silent --show-error --location \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      --output /tmp/gh.tar.gz \
  && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum --check --strict - \
  && mkdir -p /usr/local/lib/roma \
  && tar --extract --gzip --file /tmp/gh.tar.gz --strip-components=2 --directory /usr/local/lib/roma \
       "gh_${GH_VERSION}_linux_amd64/bin/gh" \
  && rm /tmp/gh.tar.gz \
  && /usr/local/lib/roma/gh --version

WORKDIR /app

# `--omit=dev` leaves @google-cloud/pubsub and google-auth-library, which is
# every dependency `dist/` has. `tsx` is not among them: the image runs compiled
# JavaScript, so the reason the README used to give for keeping it at runtime has
# expired along with "deployment is out of scope".
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Installed globally rather than as a dependency, because `src/claude-session.ts`
# spawns the bare command `claude` and resolves it from PATH. An image without
# one cannot run roma at all.
ARG CLAUDE_CODE_VERSION
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

COPY --from=builder /app/dist ./dist

# The `gh` Credential Shim, under the name the agent will type. Three lines of
# shell rather than a symlink, because what has to run is `node` with the Shim's
# path — and the Shim is a module in `dist/`, not an executable.
RUN printf '#!/bin/sh\nexec node /app/dist/github/gh-shim.js "$@"\n' > /usr/local/bin/gh \
  && chmod 0755 /usr/local/bin/gh

# The Cloud Shortcut, and the same three lines for the same reason — what has to
# run is `node` with a module in `dist/`.
#
# Installed on every image, including the ones whose deployment has no Cloud
# Reach, and that is the decision rather than an oversight (ADR-0015 §9). Omitted
# it would be `command not found`, which a model reads as a broken PATH or a
# broken image and spends a Turn investigating; installed, it answers in one
# sentence that this deployment has none.
#
# `roma-` prefixed, unlike the Shim above. That one occupies a vendor tool's name
# so the correct path is taken without anybody choosing it; this stands in front
# of nothing — there is no cloud CLI in this image, deliberately, and 439 MiB of
# one buys no capability roma does not already have (ADR-0015 §1).
RUN printf '#!/bin/sh\nexec node /app/dist/cloud/cloud-token.js "$@"\n' > /usr/local/bin/roma-cloud-token \
  && chmod 0755 /usr/local/bin/roma-cloud-token

# The Document Shortcut, on the same three lines and every word of the reasoning
# above (ADR-0022 §4). Installed on every image, including the ones whose
# deployment has no Document Reach, where it answers in one sentence that there
# is none — a command that is missing reads as a broken PATH and costs the Turn
# the Shortcut exists to save.
#
# There is no Drive CLI here either, and this one stands in front of nothing: the
# long way round is the agent writing Google's own API call, which `curl` and
# Node can already do. What that buys is the thing a whitelist of verbs would
# have taken away — every verb roma did not think of would otherwise be an image
# change with nothing behind it.
RUN printf '#!/bin/sh\nexec node /app/dist/documents/document-token.js "$@"\n' > /usr/local/bin/roma-document-token \
  && chmod 0755 /usr/local/bin/roma-document-token

# The asymmetry here is the decision, not an oversight.
#
# ROMA_WORK_ROOT is defaulted because losing it is by design: a Session's
# working directory is reclaimed after a week untouched, so the image can name a
# path with nothing riding on it.
#
# ROMA_AUDIT_ROOT and ROMA_CLAUDE_CONFIG_DIR are deliberately absent, and there
# is no default that would be right for either. `readRomaEnv` refuses to start
# without them precisely so the data cannot land somewhere a reclaim deletes;
# defaulting either here would re-open that hole from a new direction, with the
# data in the container's writable layer, gone with the container. ADR-0002 is
# explicit that per-user attribution does not exist at the provider, so the Audit
# Records are the only place it ever exists — and ADR-0005 makes the Transcript
# the only account there is of what an agent did, which ADR-0006 then decided
# roma deletes nothing from. A default is roma doing the deleting anyway, on a
# schedule nobody chose.
# The Claude config dir decides a second thing besides where the Transcript goes:
# `CLAUDE_SECURESTORAGE_CONFIG_DIR` is pointed at it too, which is what keeps a
# host keychain login out of a Claude Code process. Both reasons want it named
# rather than guessed.
# `docker run` with no volumes is therefore refused, naming both — which makes
# the operator answer two questions this image genuinely cannot.
#
# HOME is set explicitly rather than left to the daemon's passwd lookup, because
# `buildEnv` passes it through to every Claude Code process and a Claude Code
# process without one has nowhere to put the things it keeps outside
# CLAUDE_CONFIG_DIR.
#
# ROMA_SHIM_DIR follows the work root rather than the audit root, on the same
# rule: default what is lost by design, refuse what cannot be lost. What lives
# there is a Unix domain socket and a gitconfig, both recreated every boot, and
# neither is anybody's data. It is deliberately **not** under ROMA_WORK_ROOT —
# that tree is reclaimed after seven idle days, and a reclaimed socket would
# present as every credential request in roma failing at once with no
# explanation. It is a variable at all, rather than a constant in the code,
# because running roma from source on a developer's machine is a stated
# consequence of ADR-0008 and `/run` is not writable there.
ENV HOME=/home/node \
    ROMA_WORK_ROOT=/var/lib/roma/work \
    ROMA_SHIM_DIR=/run/roma

# `audit` and `claude` are made and owned here even though nothing points at
# either. Setting the variable and making the directory are different acts: an
# empty named volume mounted over a path the image never created is materialised
# `root:root`, and roma runs as `node` — so the operator who mounts one would
# clear the refusal above and then lose the first Audit Record, or the first
# Transcript, to EACCES, which is the same data gone by a longer route. A bind
# mount brings the host's own ownership and needs to be writable by uid 1000;
# the README says so.
#
# `/run/roma` is made here for a different reason again: roma creates it at boot
# if it is missing, and it cannot, because `/run` belongs to root and roma is
# `node`.
RUN mkdir -p /var/lib/roma/work /var/lib/roma/claude /var/lib/roma/audit /run/roma \
  && chown -R node:node /var/lib/roma /run/roma \
  && chmod 0700 /run/roma

# Not root. The agent's blast radius is already "anything a member of a connected
# channel asks for" (ADR-0003); it does not also need to be root inside the
# container it is confined to.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/channels/main.js"]

# Last, so that a new version or revision reprints one layer rather than
# rebuilding the install layers above it. Readable with `docker inspect`, without
# running the image — which matters most for the Claude Code version, since the
# alternative way to ask is to start a container.
# `0.0.0-dev` rather than a plausible-looking number, so an image built from a
# pull request cannot be mistaken for a release by reading its labels. The
# release workflow passes the tag, which it has already checked against
# `package.json`.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="roma" \
      org.opencontainers.image.description="One central Claude Code agent a team reaches from any messaging channel" \
      org.opencontainers.image.source="https://github.com/jackey8616/roma" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      io.github.jackey8616.roma.claude-code.version="${CLAUDE_CODE_VERSION}"
