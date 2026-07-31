# 13. roma's reset answers to `/clear`, `/reset` and `/new`

Date: 2026-07-31

## Status

Accepted, and implemented: `src/commands.ts` maps all three spellings to the one
`clear` Command, which is what the Core carries out and what an Adapter renders.

Corrects a *name* in ADR-0003 without disturbing anything it decided. ADR-0003
fixed roma's Commands at two and matched them whole; both stand. What changes is
which spellings of one of them roma answers to.

This is the second time an ADR-0003 sentence about Commands has been corrected in
two days. ADR-0012 took the first — "every slash command is passed through as
work", which described something that had never happened. Neither correction
touches a decision. Both touch a sentence written about Claude Code without
looking at Claude Code.

### Verification status

Read out of the pinned build's bundle (2.1.220, ADR-0007) with `grep`, in this
repo's container. **Weaker evidence than ADR-0012's**, and the difference is
worth naming: that ADR ran the binary and read the stream. This one read a
minified object literal. It is enough to establish that the strings exist and how
Claude Code groups them, and it is not enough to establish behaviour.

**Read — the descriptor.**

```
{type:"local", name:"clear",
 description:"Start a new session with empty context; previous session stays on disk",
 aliases:["reset","new"], supportsNonInteractive:!0}
```

So `clear` is the name and `new` is one of two aliases on it. roma answers to the
alias and not to the name.

**Read — `/stop` collides too.** `{type:"local", name:"stop",
supportsNonInteractive:!0, description:"Stop this background session; transcript
and worktree are kept"}`. roma's `/stop` shadows it. Recorded because it is the
same class of fact and somebody will find it later; nothing here changes because
of it, since the two mean close enough to the same thing that shadowing is the
outcome anybody would want.

**Not verified — what `/clear` costs today.** The claim below that it is billed
as prose is ADR-0012's mechanism applied to one more string, not a fresh
measurement. That ADR verified the mechanism directly (`attribution.ts` writes
the Caller Marker first, so the frame does not begin with a slash, so Claude Code
sees prose) and measured one instance of it at `num_turns: 1` and
`total_cost_usd: 0.0549`. `/clear` takes the same path for the same reason. The
figure is that measurement's, quoted for scale rather than re-measured.

## Context

`src/commands.ts` holds `'/new'` and `'/stop'`. Anything else falls to a Task.

Set that beside the descriptor above and the result is backwards:

| Somebody types | What roma does |
| --- | --- |
| `/new` | roma's reset — but `new` is Claude Code's *alias* |
| `/clear` | falls to a Task, is shown to the model as prose, is billed |
| `/reset` | the same |

The one string that works is the one a Claude Code user is least likely to reach
for. `/clear` is the name in the product, in its own help, and in every habit
anybody brings to roma — and it is the one that costs money to be told nothing.

There is a second-order shape to this that matters more than the money. Somebody
will find the `/clear` fault and reach for the obvious fix, which is to put it on
the Readout whitelist. That relays it, and ADR-0012 is explicit about what
relaying that particular string does:

> **`/clear`** — "Start a new session with empty context". The worst of them.
> roma derives a Session id from the Conversation Key and the Session Generation
> (ADR-0003), and `/clear` moves Claude Code to a different session without
> telling roma. The next `--resume` resolves to a session roma believes in and
> Claude Code has left. `/new` exists precisely to make this move, through the one
> piece of state that records it.

So roma's reset is not merely a reset. It is the safe implementation of `/clear`,
and it is currently parked under a name that leaves the dangerous one unclaimed
and the safe one hard to find.

## Decision

**Three strings mean roma's reset. `/clear` is what it is called.**

```
/clear    /reset    /new
```

Whole-message match, case-insensitive, exactly as now. `CONTEXT.md` and every
document that names the Command name it `/clear`. `src/commands.ts` maps all
three to the same `Command`.

The mechanism does not change by one line: the Session Generation moves, nothing
is torn down, and a Task already running finishes in the old Session and still
answers the person who asked (`core.ts:461`).

### Why all three rather than a rename

Because the argument is already in this repository, written three days ago about
two other strings. `src/readouts.ts`, on why `/cost` and `/stats` are on the list
next to `/usage`:

> The aliases are here because leaving them out reproduces exactly the fault
> ADR-0012 exists to fix, only for two more strings: somebody types `/cost` and is
> billed for a plausible sentence about what `/cost` would have said.

The same sentence with different nouns is this decision. It carries further here
than it did there, because the string left unclaimed is not one that wastes five
cents — it is the one whose obvious repair is the move ADR-0012 calls the worst
available.

A rename — `/clear` in, `/new` out — would fix the name and re-open the fault one
string to the left, on the only spelling that works today. That trades existing
users for tidiness.

### Why this is cheaper than the Readout whitelist

A Readout's list has to track Claude Code, because a Readout is relayed: ADR-0012
accepts a re-audit every time the ADR-0007 pin moves, and names that as a
standing cost.

Command spellings are roma's outright. Nothing is relayed, nothing is compared
against anything upstream, and a release that drops `new` from Claude Code's
aliases changes nothing here. The strings are chosen once because a person might
type them, and then they are roma's for good.

## Consequences

- `/clear` and `/reset` stop being billed for a plausible sentence about
  themselves.
- The dangerous `/clear` becomes unreachable through roma by construction rather
  than by nobody having tried: it is a Command, so `readCommand` answers before
  `readReadout` is consulted (`core.ts:287`). Putting it on the whitelist later
  would require removing it from `COMMANDS` first, which is a deliberate act and
  reads as one.
- The Command's name changes in the documentation while `/new` keeps working, so
  no message anybody sends today stops working.
- `/clear foo` still falls to a Task and is still billed as prose. Claude Code's
  `/clear` carries `argumentHint:"[name]"` and roma's reset takes no argument, so
  the whole-message rule turns it away. This is a smaller version of the same
  fault, left open deliberately: closing it means deciding what a name would mean
  to roma, and roma has nothing to name.
- roma now answers to three strings for one Command and one for the other, so
  "roma has two Commands" needs saying as a count of Commands rather than of
  spellings.

## Alternatives considered

**Rename to `/clear` and drop `/new`.** Rejected above: it fixes the name by
moving the fault onto the spelling that currently works.

**Leave it, and document that roma's reset is `/new`.** Rejected. Documentation
does not reach somebody typing into a chat window from habit, and the failure is
silent, confident and billed — the three properties that make ADR-0012's fault
worth an ADR rather than an issue.

**Add `/clear` to the Readout whitelist so Claude Code handles it.** Rejected,
and it is the trap rather than an option. It hands the Session to a command that
moves Claude Code off the session roma is tracking.

**Match any of Claude Code's aliases for any Command, generally.** Rejected. That
makes roma's Command surface a mirror of a moving one, which is the re-audit
burden ADR-0012 took on for Readouts because relaying left it no choice. Nothing
forces it here, and a list of three strings chosen deliberately is worth more than
a rule that inherits whatever the next release declares.
