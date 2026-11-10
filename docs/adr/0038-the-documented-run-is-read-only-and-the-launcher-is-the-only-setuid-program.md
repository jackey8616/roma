# 38. The documented run is read-only, and the Launcher is the only setuid program

Date: 2026-11-10

## Status

Accepted, and **implemented**. Closes GHSA-g6cx-6wcm-4hqw (finding I7, low, defence in
depth): the documented `docker run` asked for no runtime hardening beyond the read-only key
mounts, so the root filesystem was writable, the bounding set was Docker's default and
eight setuid-root and three setgid programs were in the image. Amends ADR-0007, whose image
decision said nothing about how it is run, and builds on the capability list ADR-0036
already made the image prove.

## Context

The advisory measured the image at `93ff5f6`, when roma and every agent ran as `node` under
`USER node`. It recommended `--cap-drop=ALL`, `--read-only` with tmpfs where roma writes,
and `--security-opt no-new-privileges`, and showed `claude --version` and the configuration
refusal surviving them.

The image has changed under it. ADR-0032 starts roma as root so that it can read its keys
before it drops to `node`, and ADR-0036 runs every agent as a Seat through a setuid-root
Launcher. Three consequences for the recommendation:

- **`--cap-drop=ALL` already had a documented form.** ADR-0036 named the six capabilities
  the drop and the Launcher need, and `scripts/verify-image.sh` already ran five harnesses
  on exactly those. The README offered it as an option rather than showing it.
- **Container-wide `no-new-privileges` cannot be used.** It makes the kernel ignore the
  setuid bit at exec, so roma could no longer spawn any agent through the Launcher. What
  the flag protects against is already closed one level down: the Launcher execs every
  Runtime with `no_new_privs`, so no agent can gain anything from `su`, `passwd` or
  `mount` (ADR-0036). roma itself, as `node`, could still exec them.
- **`--read-only` needs more writable paths than at `93ff5f6`.** The Launcher writes its
  roots file under `/run/roma-launch` and treats `/tmp` and `/var/tmp` as shared space it
  purges, and agents run builds in the work root, so the work root and `/tmp` must allow
  exec. Docker's `--tmpfs` defaults to `noexec`.

## Decision

**The README's `docker run` and compose.yaml run roma hardened, and the image is proved on
exactly that run.** `--cap-drop=ALL` with ADR-0036's six back, `--read-only`, and tmpfs at
`/tmp` (exec), `/var/tmp`, `/run/roma` (node, 0711), `/run/roma-launch` (root, 0755) and
`/var/lib/roma/work` (node, 0711, exec). The audit and Claude config roots stay on the
Operator's durable volumes; tmpfs is never put over them. Every harness in
`scripts/verify-image.sh` that boots the image — the containment, credential, isolation,
Launcher and audit runs — now runs on this root, so a path roma starts writing that the
README does not mount fails there first. Enforced by `fence:documented-run-is-read-only`.

**Every setuid and setgid bit in the base image is stripped, and the Launcher is copied in
after.** None of those programs is used by roma, the Launcher or any harness. This is what
stands in for `no-new-privileges` on roma's own uid. Enforced by
`fence:image-strips-setuid-but-the-launcher`.

**The egress gateway also gets `no-new-privileges`.** It runs as root because its token file
is root's, and stays root — with no capability, so root there is a uid and nothing more. It
needs no capability and has no setuid program to run, so in compose.yaml it runs with
`cap_drop: [ALL]`, a read-only root and `no-new-privileges`.

`verify-image.sh` §12 asks the built image, on the README's flags: the root mount is `ro`;
the bounding set is exactly the six capabilities; the Launcher is the only setuid or setgid
file; `node` writing the image's home fails with `EROFS`; and every path roma writes still
takes a write.

**Amended:** that left a run with seccomp turned off, with `/tmp` unable to execute a build,
or with no limit on processes indistinguishable from the documented one. The README and
compose.yaml now cap each container at 512 processes and spell out `nosuid,nodev` on every
tmpfs, and §12 also asks: Docker's default seccomp filter is on; `pids.max` is 512; every
tmpfs is `nosuid` and `nodev`; `/var/tmp` takes a write as `node` and `/run/roma-launch` as
root; and a script in `/tmp` and in the work root runs. §7 asks the running gateway for
`NoNewPrivs: 1`, a filter, and no effective capability. Enforced by
`fence:documented-run-caps-processes` and `fence:documented-run-is-read-only`. 512 is a
starting point that fifteen resident Sessions and their builds fit in, not a measured
ceiling; memory is left to the Operator, who knows the host.

## Consequences

- **An Operator who copies the old `docker run`** keeps a writable root and Docker's default
  capabilities. Nothing refuses that run; it is the README and compose.yaml that changed.
- **The work root is memory-backed in the example.** It was disposable by design (ADR-0007),
  but a large clone now costs RAM. The README says to mount a volume there instead when that
  matters.
- **What this does not do.** A read-only root does not make the writable volumes immutable,
  does not separate an agent from roma's uid (ADR-0036 does that), and does not restrict
  egress (ADR-0035). It is defence in depth, as the advisory rated it.
- **The proof stops short of a configured boot**, as ADR-0007's always has: the harnesses run
  roma's real compiled drop, spawn path, Launcher and audit seal on this root, but not a
  real Channel or a paid Turn. A path written only in a live session would show up as a
  failed session, not in CI.

## Considered and rejected

- **`--security-opt no-new-privileges` for roma.** Voids the Launcher, and with it ADR-0036.
  The agent already runs with `no_new_privs`; stripping the image's other setuid programs
  covers roma's uid.
- **A writable `/home/node`.** Nothing writes it: roma passes the Launcher's own `HOME` to each
  Runtime, and §12 shows the read-only home costs none of the harnesses anything.
