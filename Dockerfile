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

# ---------------------------------------------------------------------------
# Builder: everything installed, `dist/` out.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

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
FROM node:22-slim AS runtime

# Deliberately small. roma's agent runs arbitrary shell commands, so this image
# is a workspace and not only a runtime — but guessing at which tools it will
# want produces an image nobody can explain, every line of it attack surface on a
# public registry. `git` because that is what the agent is for; `ca-certificates`
# because every outbound call it makes is TLS; `tini` because roma spawns
# `claude` processes and a Node.js process running as PID 1 reaps nothing, so
# without it a stopped Turn leaves a zombie behind for the life of the container.
# Widening this list is a separate decision with its own evidence.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

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
ENV HOME=/home/node \
    ROMA_WORK_ROOT=/var/lib/roma/work

# `audit` and `claude` are made and owned here even though nothing points at
# either. Setting the variable and making the directory are different acts: an
# empty named volume mounted over a path the image never created is materialised
# `root:root`, and roma runs as `node` — so the operator who mounts one would
# clear the refusal above and then lose the first Audit Record, or the first
# Transcript, to EACCES, which is the same data gone by a longer route. A bind
# mount brings the host's own ownership and needs to be writable by uid 1000;
# the README says so.
RUN mkdir -p /var/lib/roma/work /var/lib/roma/claude /var/lib/roma/audit \
  && chown -R node:node /var/lib/roma

# Not root. The agent's blast radius is already "anything a member of a connected
# channel asks for" (ADR-0003); it does not also need to be root inside the
# container it is confined to.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/channels/google-chat/main.js"]

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
