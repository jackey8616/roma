# 32. roma reads its keys as root and serves as node

Date: 2026-11-09

## Status

Accepted, and **implemented**. Closes GHSA-v52v-hcv8-cr23 (finding I1): the agent could
read the GitHub App private key, the Cloud and Document Reach keys, and everything roma was
started with — from the mounted files, from `/proc/<roma>/environ`, and from
`/proc/<roma>/mem`. Amends ADR-0008's *the private key never enters the container's
reachable space*, which #60 had recorded as false, and the same premise in ADR-0015 §3 and
ADR-0022.

## Context

roma spawns `claude -p --permission-mode bypassPermissions` for anyone who can message it,
and the agent reads untrusted content. Under prompt injection the agent is the attacker, so
what matters is what it can reach. roma and the agent ran in one container as one uid,
`node`, and Linux separates nothing between two processes of one uid: each key file was a
`cat` away, roma's environment held `ROMA_OVERFLOW_API_KEY` and the Shared Window token, and
roma's heap held the PEM `GitHubMinter` signs with.

The one-hour expiry ADR-0008 leans on bounds a leaked **token**. It does not bound a leaked
**signing key**, which mints fresh tokens on every repository the App is installed on until
somebody revokes it in the App settings.

## Decision

**roma starts as root, reads the key files, and becomes `node` before it does anything
else** — before a Channel is built, before the Startup Self-Check spawns its probe, before
any agent exists. The agent still runs as `node`, as roma's child; nothing about Working
Directories, the Claude config dir, the Shim socket or the Audit Log changes owner.

Two things then keep the agent out, and roma proves both after the drop or refuses to start:

1. **The key files are root's.** The operator mounts them 0400 and owned by root (any uid
   but 1000 works). roma read them while it was root; `node` cannot open them now.
   Enforced by `fence:drop-root-refuses-readable-key`.
2. **roma is not dumpable.** When a root process changes uid, the kernel marks it not
   dumpable, and a process that is not dumpable has its `/proc` entries owned by root and
   refuses ptrace — `environ`, `mem`, `maps`, `process_vm_readv` — to anything without
   `CAP_SYS_PTRACE`, its own uid included. roma reads the owner of its own
   `/proc/<pid>/environ` to confirm it; a host with `fs.suid_dumpable=1` would leave roma
   dumpable and is refused. Enforced by `fence:drop-root-requires-non-dumpable`.

One more door has to be shut because the uid is shared: **SIGUSR1**. Any process of roma's
uid may signal it, and SIGUSR1 opens a Node inspector on 127.0.0.1:9229 that evaluates code
inside roma whatever the kernel says about dumping. The image runs
`node --disable-sigusr1`, and roma refuses to start as root without it. Enforced by
`fence:drop-root-requires-sigusr1-disabled` and `fence:image-disables-sigusr1`.

The order is held by `fence:main-drops-root-after-reading-keys`, and the image keeping its
side — no `USER`, so roma has root to drop — by `fence:image-starts-as-root`.
`scripts/verify-image.sh` §5 proves the whole of it against the built image: the image's own
compiled `dropRoot`, `buildEnv` and `spawnClaudeProcess`, an agent spawned as roma's real
child, which must reach neither the key file, roma's environment, roma's memory nor the
inspector — and a control run started as `node`, which must reach them, so the probe is
known to work.

**Started as anything but root, roma runs as it always did** and logs
`{ "event": "privileges", "dropped": false }` with the reason. That is roma from source on a
developer's machine, or the image under `--user`. In both, the agent can reach everything
roma holds.

## Consequences

- An upgrade **must** change how the key files are mounted. A key mounted the way the README
  used to show — readable by uid 1000 — is now a refusal naming the file. `chown root` and
  `chmod 0400` on the host, or mount it from a secret store that does the same.
- `--cap-drop=ALL` needs `--cap-add=SETUID --cap-add=SETGID`, or roma cannot drop and
  refuses. After the drop roma holds no capabilities at all.
- roma is root for the length of `readConfiguration`: environment parsing and reading the
  files the deployment named. Nothing in that span touches a path the agent can write.
- **Not covered:** `GOOGLE_APPLICATION_CREDENTIALS`, roma's own Channel identity. It is read
  by Google's libraries after the drop, so it has to stay readable by `node` and therefore by
  the agent. On a Google host it is the metadata server instead, and there is no file.
- **Not covered:** the agent's own credential is in the agent's own environment (finding I2),
  and the agent can still signal roma — stop it, not read it. **Amended by ADR-0034:** I2 is
  closed; `claude` holds a stand-in, and the credential is in roma, behind this boundary.

## Considered and rejected

**A second uid for the agent.** The advisory's own suggestion, and a sound boundary. It
moves the cost onto everything the two share: Working Directories, the Claude config dir,
the Shim socket, the gitconfig, the self-check's probe directory and the weekly reclaim all
need a shared group and a umask the agent cannot be relied on to keep, and every existing
volume needs a `chown` it cannot do itself. Dropping root closes the same three paths with
none of that.

**A separate container for the agent.** The strongest isolation, and a change to how roma
spawns Claude Code. Still the direction for egress control and the credential-injecting
proxy ADR-0008 defers; not needed for this.

**Deleting the key file after boot.** The file is a read-only mount, and roma's memory would
still hold the key — which is the half of the finding that file permissions alone never
reach.
