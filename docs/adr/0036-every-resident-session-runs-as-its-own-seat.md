# 36. Every Resident Session runs as its own Seat

Date: 2026-11-09

## Status

Proposed. Would close GHSA-mqhq-64x8-xj73 (finding I4: one Session's agent reads another
Session's Working Directory, Enclosures and Transcript) and GHSA-4vw6-r2rj-xcqf (finding
I6: a credential request names any Session it likes, and the Minter believes it).
Amends ADR-0032, which rejected *a second uid for the agent*, and ADR-0011, ADR-0003 and
ADR-0008 where they say who writes into a Working Directory, and ADR-0006 for one move of
the Transcripts. Implemented on `fix/session-seats`; every item of the verification agenda
at the end has been measured on the built image. Stands beside ADR-0034 and ADR-0035: a Seat's `claude`
holds the proxy's stand-in, which the Launcher passes through with `ANTHROPIC_BASE_URL` and the egress proxy variables, and
reaches both proxies on loopback like any other uid.

## Context

roma serves every Conversation from one container, and since ADR-0032 every agent still
runs as `node`, uid 1000, as roma's child. Linux separates nothing between two processes
of one uid, so under prompt injection — and the agent reads untrusted content, so that is
the case that counts — one Session's agent can do anything to another's:

- **read** its Working Directory, its Enclosures (files a person handed to that
  Conversation, perhaps in a DM) and its Transcript, which is the whole conversation and,
  per GHSA-wqj9-8qq4-w466, may hold the Shared Window token;
- **write** them — and a line planted in another Session's Transcript is read back as that
  Session's own context on its next resume, which is a prompt injection that persists into
  somebody else's thread;
- read its `/proc/<pid>/environ` and signal it;
- and, because the Credential Shim's socket is one file every Session can open, ask the
  Minter for a credential *as* that Session, which corrupts the Audit Record's
  `cloudReach` and `documentReach` and the Operator Log's attribution.

File modes cannot help: Claude Code already writes Transcripts 0600, and every agent is
the owner. The boundary has to be the uid.

ADR-0032 considered a second uid for the agent and rejected it for what the two would have
to share. That cost is real, and this record pays it; what changed is that a *second* uid
was never the answer to I4 anyway — every agent sharing one uid that is not roma's leaves
them all able to read each other. It takes one uid per Resident Session.

## Decision

### A Seat is a uid a Resident Session holds while it is resident

The image carries a fixed number of **Seats**: sixteen users, `roma-seat-00` to
`roma-seat-15`, uids 20000–20015, each with a primary group of its own name and no other
group. A Seat is leased to a Session when the Session Pool spawns it and returned when its
process ends — Eviction, Reaping or a failure alike. The lease lives in roma's memory and
nowhere else: roma keeps no database, and a container that loses roma loses every agent
with it, so there is never a lease to recover.

Seats are **reused**, which is why sixteen are enough for any number of Sessions: what is
bounded is how many are resident at once, and that was bounded already. roma refuses to
start unless there are more Seats than `maxResident`; the one spare is the Startup
Self-Check's. Enforced by `fence:seats-outnumber-residents`.

A Seat is returned in three steps, in this order, and is not returned until all three
succeed:

1. **Kill everything running as it.** An agent can leave a background process behind; the
   next Session on that Seat could otherwise read it, signal it, or inherit what it holds
   open. The Launcher becomes the Seat and calls `kill(-1, SIGKILL)`, and checks that
   nothing of that uid remains. Then it removes whatever the Seat left in `/tmp`,
   `/var/tmp` and `/dev/shm` — a file there, or a hard link to one of the Session's own,
   would otherwise still be the uid's when the next Session holds it. Those three are made
   `1733` at boot, so a Seat can create in them but list nobody's names, its own included;
   the Launcher lists them as root.
2. **Park what it owned.** Every file and directory in the Session's Working Directory and
   Claude config directory that the Seat owns is given to **`roma-parked`** (uid 19999),
   and the two directories are made 0700. `roma-parked` is a uid nothing ever runs as, so a
   parked Session is readable by no Seat, and the next holder of the same uid finds
   nothing. Not root, because preparing a Session gives the Seat exactly what is
   `roma-parked`'s and nothing else — and a hard link to a file of root's, should one be
   in the tree, is then left root's rather than handed over.
3. **Return the uid** to the free list.

A Seat whose return fails is **quarantined** — never leased again in this container's life
— and the Operator Log says which and why. A lost Seat costs capacity; a Seat returned
dirty costs another Session's data, and only the first is acceptable. The Launcher's half
— the three steps — is Enforced by `fence:seat-is-emptied-before-reuse`; roma's half, never
leasing a quarantined Seat, is Enforced by `fence:quarantined-seat-is-never-leased`. While
Seats are quarantined the Session Pool evicts down to the Seats it has left rather than
waiting on one that will not come back.

### The Launcher is the only thing that is root after boot

`/usr/local/libexec/roma-launch` is a small C program, `root:node`, mode 4750: setuid root
and executable only by group `node`. No Seat is in that group, so the kernel refuses it to
every agent before a line of it runs. It also checks that its real uid is `node`'s and
refuses otherwise. Enforced by `fence:launcher-refuses-anyone-but-roma` and
`fence:image-launcher-is-setuid-for-node-only`.

It has five modes and does nothing else:

| Mode | Does |
|---|---|
| `run <seat> <session> -- <argv>` | prepares the Session's directories for the Seat, forks the Runtime as the Seat, stays as its parent forwarding `SIGTERM`/`SIGINT`, and on exit empties the Seat |
| `enclose <seat> <session> <name>` | becomes the Seat, then writes stdin to the Session's `.enclosures/<name>` |
| `reclaim <session>` | deletes a parked Working Directory — roma, as `node`, no longer can |
| `sweep` | at boot: kills anything left on any Seat and parks every Session directory |
| `seats` | at boot: hands each Seat its own Credential Shim socket (below) |

Four rules keep the one root process from being turned against the host:

- **It takes no path from its caller.** It is told a Seat number and a Session id, both
  checked against a fixed shape — a Seat is `00`–`15`, a Session id a lowercase UUID — and
  derives every path from roots roma writes to a root-owned file while roma is still root.
  The Launcher refuses that file unless root owns it and nobody else can write it.
- **It never follows a link inside a Session's tree.** Parking and preparing walk the tree
  with `openat(O_NOFOLLOW)` and change owners with `AT_SYMLINK_NOFOLLOW`, and change only
  what the expected uid owns. An agent's symlink to `/etc/shadow` is a symlink, not a way
  to have root chown `/etc/shadow`. It refuses to run unless the kernel's
  `fs.protected_symlinks` and `fs.protected_hardlinks` are on.
- **What can race with an agent is done as the agent.** `enclose` runs while the Session is
  resident, so its agent could swap `.enclosures` for a symlink mid-write; the Launcher
  therefore becomes the Seat before it opens anything, and can then write only where the
  Seat could have written itself. Parking and preparing run as root only when no process of
  the Seat exists — that is what step 1 of returning a Seat guarantees.
- **The agent cannot climb back.** The Runtime is exec'd with `no_new_privs`, so the
  image's other setuid programs — `su`, `passwd`, `mount` — give it nothing, and with its
  supplementary groups cleared. The Launcher sets itself as a child subreaper, so whatever
  the agent forks and abandons is still the Launcher's to reap. `HOME`, `TMPDIR`,
  `CLAUDE_CONFIG_DIR` and the Shim socket in the Runtime's environment are the Launcher's,
  derived from the Seat and the Session, not roma's.

roma spawns it exactly where it spawned `claude` before, so the Runtime's stdio is still a
pipe to roma and nothing in the stream path changes. roma can signal it because a setuid
program keeps `node` as its real uid; an agent cannot, because its uid is a Seat's. The
setuid exec also makes it not dumpable, so roma cannot read its memory either — not that it
holds anything worth reading.

Why C and not Node: the kernel ignores the setuid bit on scripts, and a root helper written
in Node would have to sit in the middle of every stdio stream. A few hundred lines that
touch no stream and parse no message are the smallest root roma can have.

### What a Session owns, while it holds a Seat

Each owned by the Seat, mode 0700:

```
<work-root>/<session>/                Working Directory
<work-root>/<session>/.enclosures/
<work-root>/<session>/.home/          HOME
<work-root>/<session>/.tmp/           TMPDIR
<claude-config>/sessions/<session>/   CLAUDE_CONFIG_DIR, and so the Transcript
```

- **A Claude config directory per Session.** One shared `CLAUDE_CONFIG_DIR` puts every
  Transcript in one tree; this is the half of I4 that a Working Directory alone does not
  reach. ADR-0006 still holds — roma names the directory and reads, writes and deletes
  nothing in it; parking changes its owner, not its contents.
- **`HOME` and `TMPDIR` per Session.** Today both are inherited, so anything an agent writes
  to `/tmp` is 0644 and readable by every other.
- **roma's records stay roma's.** The files beside the Working Directories in the Work Root
  are `node`'s, as before, and 0600. roma's `touch` of a Session moves from the Working
  Directory's mtime, which only its owner may set, to a record roma owns, and so does the
  record that a Session was spawned, which used to be a file inside the Working Directory.
  Enforced by `fence:workroot-touch-is-a-record`.
- **Enclosures go through the Launcher, as bytes.** roma pipes an Enclosure's contents to
  `roma-launch enclose`, which writes it as the Seat. No staging tree: one would have to sit
  outside the Work Root — in the Work Root a directory *is* a Working Directory, and the
  weekly reclaim would sweep it — and root would have to read files `node` wrote, which is
  a symlink away from root reading anything. roma therefore makes a Session resident
  before it writes the Session's Enclosures, where it used to write them first; it still
  fetches every one before it makes anything resident, so a Task whose Enclosure cannot be
  fetched spawns nothing. Enforced by `fence:core-encloses-as-the-seat`. Resident is not
  enough: roma waits until `roma-launch run` reports `started`, because until then the
  Working Directory may not be the Seat's yet, and `run` refuses — and quarantines — a Seat
  that already has a process, which an early `enclose` is. Enforced by
  `fence:pool-encloses-after-the-seat-starts` and
  `fence:launcher-started-is-read-off-the-report`.
- **The reclaim** keeps its rule and its seven days; the deletion itself becomes
  `roma-launch reclaim`. Enforced by `fence:workroot-reclaims-through-the-launcher`.

### The socket says who is asking

The Credential Shim stops trusting `ROMA_SESSION_ID`. roma listens on one socket per Seat,
`/run/roma/seat-NN.sock`; at boot `roma-launch seats` gives each to group `roma-seat-NN`,
mode 0660, so only that Seat can connect. A connection on a Seat's socket is that Seat's,
and the lease says which Session holds it. A request naming any other Session is refused
and logged as one. `/run/roma` becomes 0711 so a Seat can reach its socket without listing
the others. Enforced by `fence:shim-identity-is-the-socket`.

This is chosen over `SO_PEERCRED` because Node exposes no peer credentials without native
code, and because it needs nothing new in roma's own privileges: roma keeps ADR-0032's
empty supplementary groups.

### No isolation, no roma

If roma cannot isolate — it was not started as root, the Launcher is missing or not
setuid, a Seat is missing from `/etc/passwd`, the capabilities below are absent, or the
boot `sweep` fails — it **refuses to start**, naming what is missing. ADR-0032 let roma
run on unprivileged, logging `dropped: false`; that is not carried over, because running
without this boundary is running with I4 open, and an operator who did not mean to would
not find out. Enforced by `fence:refuses-to-start-without-isolation` and
`fence:drop-root-refuses-when-not-root`. roma writes the Launcher's roots file before it
drops, since as `node` it could write no file root owns; Enforced by
`fence:main-writes-the-launcher-roots-before-the-drop`.

## Consequences

- **Breaking.** `--cap-drop=ALL` now needs `--cap-add=SETUID --cap-add=SETGID
  --cap-add=CHOWN --cap-add=FOWNER --cap-add=KILL --cap-add=DAC_OVERRIDE`. roma itself still
  holds none after the drop; they are for the Launcher, which as root opens and writes into
  roots that are `node`'s and `0711`. The image is proved on exactly this set; Enforced by
  `fence:image-proved-on-the-documented-caps`.
- **Breaking.** The first boot on an existing `ROMA_CLAUDE_CONFIG_DIR` moves each Session's
  `projects/<encoded-cwd>/` into `sessions/<session>/`. roma does this itself, as `node`,
  before the `sweep`: the files are still `node`'s then, and the Launcher stays out of it. A move, not a copy, so ADR-0006's
  *no second copy* holds. A Transcript that cannot be attributed to a Session stays where
  it is, and is named in the Operator Log. This amends ADR-0006 for that one move: it is
  the only code in roma that reaches inside a Claude config directory, and it renames and
  does nothing else. Enforced by `fence:transcripts-move-into-their-sessions` and
  `fence:transcripts-are-moved-never-copied-or-deleted`. `sessions/` itself is `0711`, so
  every Seat can pass through it to its own and list none; the move makes it so, and the
  Launcher puts it back if it finds it otherwise. Enforced by
  `fence:transcripts-move-leaves-sessions-passable` and
  `fence:seat-is-emptied-before-reuse`.
- **roma from source on a developer's machine does not start**, because there is no
  Launcher and no root — and there is no opt-out. roma is run as the image; `npm start`
  stops being a way to run it, and the README's row for it goes when the refusal ships.
  Development of roma's parts is the free test run and the image, not a live roma on a
  laptop.
- Sixteen Seats caps `maxResident` at fifteen. Raising it is a Dockerfile change, not a
  code change.
- **Not covered:** a tool that ignores `TMPDIR` and writes a predictable name into `/tmp`
  with a permissive mode can be read by another Session resident at the same time, by
  anyone who guesses the name. Listing is closed and the file is gone once the Seat is
  returned; only a mount namespace per Session would close the rest.
- Cross-Session `/proc/<pid>/environ` and signals close as a side effect. The agent's
  *own* environment still holds its credential (GHSA-wqj9-8qq4-w466); this does not touch
  that.
- Agent-to-agent communication, if it is ever wanted, has a trustworthy identity to build
  on — the Seat's socket — and must go through roma rather than through the filesystem.
  Not decided here.

## Considered and rejected

**Tightening modes while Sessions share a uid.** Every agent is the owner. Closes nothing.

**One shared agent uid, different from roma's.** Closes part of I1 and none of I4.

**A uid per Session derived from its id**, from a range of millions. No reuse, so no
parking — but every uid needs a passwd entry or Node's `os.userInfo()` and git fail, the
entries would be written into `/etc/passwd` at run time, and the files of Sessions that
are not resident would stay owned by a uid nobody holds. Seats with parking leave less
behind.

**A long-lived root helper in Node** instead of a setuid binary. No compiler in the image,
but the agent's stdio would pass through a root process, and its kill path with it.

**bubblewrap or another per-agent namespace.** Docker's default seccomp profile refuses
unprivileged user namespaces; making it work means `CAP_SYS_ADMIN`, which is the opposite
of the direction ADR-0032 took.

**A container per Session.** The strongest boundary, and the right home for egress control
(GHSA-7hpq-f638-956r). It gives roma the Docker socket, which is root on the host, and
changes how every Runtime is spawned. Not for this.

## Developer machines

Decided with this record: **no opt-out.** An environment variable that turns isolation off
is a switch an operator can find and flip, and a deployment that ran with it would be I4
open while reading as fixed. roma is not run from source; it is run as the image.

## Verification agenda

Before this is Accepted, on the pinned Claude Code (ADR-0007):

1. A real spawn of two Sessions, A and B: A reads and writes B's Working Directory,
   Enclosure, Transcript and `.tmp`, and claims B on the Credential Shim. **Measured**:
   every one reached before this record, every one blocked after it, while B reaches all
   of its own — `scripts/verify-image.sh` section 9, `fence:sessions-cannot-reach-each-other`.
2. Claude Code under a Seat uid with a per-Session `CLAUDE_CONFIG_DIR` and `HOME`: starts,
   resumes, writes its Transcript where expected, and does not ask to onboard.
   **Measured** on 2.1.319 in the image, through the real Launcher and `ClaudeSession`: a
   Turn on one Seat, then `--resume` on another, which recalled the first; nothing on
   stderr, no onboarding, both Seats returned.
3. A Seat reused: B returns its Seat with a background process and a file in `/tmp`; C
   leases the same Seat and finds neither. **Measured**, section 10.
4. A Session resumed after parking keeps its Transcript. **Measured**, section 10.
5. `scripts/verify-image.sh` gains a section with a control run, which must reach
   everything, so the probe is known to work. **Done**: section 9's control is Session B
   probing itself.
