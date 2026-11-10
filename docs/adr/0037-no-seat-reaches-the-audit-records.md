# 37. No Seat reaches the Audit Records

Date: 2026-11-10

## Status

Accepted, and **implemented**. Closes GHSA-g6x2-mcq8-3hm3 (finding I5): the agent could
append forged Audit Records, rewrite the Caller and cost on existing ones and delete them,
and `/usage` and the Overflow cap read the result without a warning. Rests on ADR-0036,
which does most of the work, and amends the "append-only" ADR-0027 and the glossary give an
Audit Record, which until ADR-0036 described roma's own writes and bound nothing else.

## Context

The provider attributes none of the spend to a person (ADR-0002), so roma's Audit Records
are what the structured account of who spent what rests on: `/usage` totals them
(ADR-0027) and the Overflow cap stops metered spending against them. They are not the only
trace of who asked — ADR-0009 puts the Caller in the Transcript and on every reply — but
they are the only one roma adds up.

At `93ff5f6` roma wrote them as `node` into `<ROMA_AUDIT_ROOT>/YYYY-MM.jsonl`, directory
0755 and files 0644, and every agent ran as `node` too. The advisory's reproduction drove
the real pinned `claude` to append a valid record for another Caller and then rewrite the
month, with the directory at 0700 and the file at 0600: the agent was the owner, so modes
could not help.

ADR-0036 changed who the agent is. Every agent now runs as a Seat, a uid of its own, and
roma refuses to start without the root that makes that possible, so no agent is ever `node`.
Measured on the image built from it, a Seat cannot append, rewrite, delete, add a month or
rename the audit root or `/var/lib/roma` away. Two gaps were left:

- **A volume an earlier image made.** The image now creates the audit root 0700, but a
  named volume or a bind mount keeps the mode it was made with. One made before ADR-0036 is
  0755 with records 0644, and every Seat can read every Caller's name and cost in it.
- **A custom `ROMA_AUDIT_ROOT` under a directory a Seat can write.** A Seat that can rename
  any directory between the root and `/` can move the ledger out of the way and put one of
  its own at the path roma reads, without touching a file roma owns.

## Decision

**After the drop, before a Session exists, roma seals the audit root as the uid that owns
it, or refuses to start.**

1. **It must be roma's.** roma creates the root 0700 if it is missing, and refuses one
   `node` does not own, naming the `chown`. Enforced by
   `fence:audit-seal-refuses-foreign-owner`.
2. **It is made 0700.** A Seat cannot open a directory it has no bit on, so the records in
   it — whatever their own modes — are out of reach for reading and writing alike. roma
   logs whether it had to tighten it. Enforced by `fence:audit-seal-tightens-to-owner-only`.
3. **No Seat can rename it away.** roma walks every directory from the audit root up to
   `/`, along the path as configured and along the path its links resolve to, and refuses
   if a Seat could rename any of them: judged from the mode bits against each Seat's own uid
   and group, since `access()` answers only for roma. A child is safe only if it is a mount
   point, which `rename` refuses, or if its parent is sticky and neither is a Seat's.
   Enforced by `fence:audit-seal-refuses-seat-writable-ancestor` and
   `fence:audit-seal-follows-links`.
4. **It happens after the drop.** As root, roma would check the wrong owner. Enforced by
   `fence:main-seals-audit-after-drop`.

`scripts/verify-image.sh` §11 proves it against the built image: a volume left 0755 is sealed
by roma's real compiled `sealAudit`, a Seat spawned through the real Launcher fails to read,
append, rewrite, add a month, delete or rename the directory or anything above it, and the
month reads back exactly what roma wrote. The same probe run as roma against a ledger of
its own must reach all six, so the probe is known to work. A second run puts the root under
a directory every Seat can write, and roma must refuse.

## Consequences

- **Upgrading needs nothing** on the image's path or a volume mounted there: roma tightens
  the mode itself.
- **A custom `ROMA_AUDIT_ROOT` under a directory a Seat can write is refused.** Mount it, or
  put it under directories only root or `node` can write.
- **Not covered:** roma itself. It writes the records and can rewrite them; it is the
  component the rest of this design trusts, and a hash chain keyed in its memory would be
  rewritten by the same compromise.
- **Not covered:** a host that can write the volume. Shipping the records off the host to a
  store that refuses deletion is the operator's, and is the only answer to that.

## Considered and rejected

**A separate uid that alone writes the records** — an Audit Writer spawned as `roma-audit`
while roma is still root, fed over a pipe. Built and verified before ADR-0036 landed, when
the agent was still `node`. Once no agent is `node` it defends only against roma rewriting
its own records, which a compromised roma could instead forge through the writer, at the
cost of a second long-lived process, a boot-time `chown` of the volume as root — whose
symlink and hard-link hazards needed a review of their own — and modes Seats could read.

**`chattr +a`.** Append-only stops a rewrite and a delete, and leaves the forged append.

**Owner-only modes alone.** What this does, and enough now — but only because ADR-0036
made the owner someone other than the agent. Before it, the advisory measured them useless.
