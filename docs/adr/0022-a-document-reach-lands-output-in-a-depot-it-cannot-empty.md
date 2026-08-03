# 22. A Document Reach lands a Conversation's output in a Depot it cannot empty

Date: 2026-08-03

## Status

Accepted, and implemented by the change that carries it — **with the verification below
still undone**, which is a departure from what this record asked for and is recorded in
the section that asked for it.

**Fulfils ADR-0020 §8 rather than amending it.** That section priced a third Reach and
said the friction was correct — "a member of [`CredentialWanted`] and a Shim or Shortcut
program to send it, a protocol change and an image change, neither of which a list in
`startRoma` can absorb." This is that third Reach, and the bill is the one §8 named.

**Leaves ADR-0015 untouched.** §5's "a Cloud Token is scoped to `cloud-platform`, and
that is not configurable" is unamended: this is a different credential with its own
constant, not a widening of that one. The reason it is a different credential rather than
two more scopes on the old one is §1 below.

**Extends ADR-0011's last consequence.** That record ended with *"Nothing here lets roma
send an image. `OutboundInstruction`'s `result` is still `text`, deliberately: no use for
the reverse direction has been named."* A use has now been named, and it is answered
**without** touching `OutboundInstruction`: what goes out does not go out through a
Channel.

### Verification status

**No Document Reach has ever existed, and nothing here has been measured.** Every claim
below about how Google behaves — the shared drive role table, `drive.file` covering the
Docs and Sheets APIs on app-created files, `capabilities.canAddChildren` on a folder,
`appProperties` being queryable on a shared drive, revisions of Docs and Sheets being
undeletable through the API — is read out of Google's documentation. ADR-0015 was in this
exact position and **was reversed twice by measurement inside the session that wrote it**.
Treat the table in §5 as the thing most likely to be wrong, because the whole of "the
agent cannot destroy anything" rests on it.

What *is* established is the roma half: `CredentialWanted` is a closed union
(`shim-protocol.ts`), `Reaches` is a record over it that TypeScript forces the composition
root to fill (`reach.ts`), the unavailable arm is structural (ADR-0020 §2), and
`readConfiguration` collects synchronous configuration problems into one refusal
(`env-config.ts`).

**Implementation starts by finding out**, exactly as ADR-0011 said of its own unverified
premise. The first thing to build is a throwaway that creates a Doc in a real shared drive
as a Contributor and then tries to trash it.

#### What was actually done, and what is therefore still owed

**It was built before the finding out, and `docs/document-reach-verification.md` does not
exist.** The measurement above needs a real service account, a real shared drive and a real
Contributor grant, and none of the three was available to the change that built this. So the
order this record asked for was inverted, deliberately and with the cost in view.

What was done instead is what ADR-0015 already does for the Cloud Reach: **every Drive-facing
fixture is written from Google's documentation, and every test file that carries one says so
at the top** — `src/documents/google-document-minter.test.ts` names the five behaviours it
takes on documentation's word, `announce.test.ts` says the role table it holds roma to
stating is the thing most likely to be wrong, and `env-config.test.ts` says its key file is
the same unverified shape. That is `src/cloud/google-cloud-minter.test.ts`'s existing
practice, and it is the honest form of what those tests are: assertions about **roma's** half
— that one scope constant reaches the assertion, that the boot proof asks the question it
claims to ask, that three answers produce three sentences an operator can act on — sitting on
top of an unmeasured account of Google's.

What is still owed is the run, unchanged from the paragraph above it: create a Doc and a
Sheet in the folder, read them back, try to trash one and record what Google says, try to
move one out and record what Google says, set and query the Conversation tag, and fetch the
folder's capabilities under a Contributor and under a Viewer. When it happens, the tests that
were written from documentation should cite it — and the ones it contradicts should be
changed, which is the outcome ADR-0015's history says to expect.

Two smaller departures, recorded here so the list is the whole list:

**One enumerated boot-seam assertion is at the module seam instead.** The spec lists *"a
deployment with one variable refuses, naming the other"* under the boot seam. It cannot be
there: `startRoma` takes built `Reaches` and never an `Environment`, so the both-or-neither
refusal fires in `readDocumentEnv` before a Reach exists at all. It is asserted in
`src/documents/env-config.test.ts`, and `startup.test.ts` says where it went. Every other
boot-seam bullet is where the spec put it.

**Two of the three refusals share one sentence, because Drive shares one status.** §6 asks
for three: a folder that is not there, one the account cannot see, and one it can see and
cannot write. Drive answers `notFound` for the first two — a file this identity cannot see
does not exist as far as the API is concerned — so the sentence names both fixes rather than
guessing which one an operator needs, and the third case has its own. Read from
documentation, unmeasured, and first on the list of things a real run could improve: if
`files.get` turns out to distinguish them, this becomes three sentences.

One decision was made against §7 on the way, and it is in §7's own section rather than here.

## Context

roma is one central agent a team reaches from a messaging channel, and a Conversation is
many people sharing one Session. The case this record was designed against is that shape
put to work: a product manager and an engineering team in one Chat space, working through
what a feature actually has to do, with roma in the thread. At some point somebody asks
for the conclusions to be written down.

Today there is nowhere for that to go. `OutboundInstruction`'s `result` is text, so the
answer is a chat message — searchable, quotable, and impossible to comment on, version,
link to from a ticket, or hand to somebody who was not in the space. The Working Directory
is worse: it is per-Session, nobody but the agent can see it, and ADR-0003 reclaims it
after seven idle days.

What the team wants is a **document**: a native Google Doc or Sheet, in a folder they
already use, that the PM can open, comment on, and keep.

Two things about roma shape everything below.

**roma holds keys and mints from them.** ADR-0008 and ADR-0015 settled that a long-lived
key never enters the space the agent can reach, and that what the agent gets is
hour-long. That rule is not reopened here.

**roma has no database.** The Session id derives from the Conversation Key and the Session
Generation, which is why. Anything this record needs to remember across Tasks has to live
somewhere that is not roma.

## Decision

### 1. A Document Reach is the third Reach, and `documents` is a word rather than a product

`CredentialWanted` gains `'documents'`. `Reaches` gains

```ts
readonly documents: Reach<'documents'>
```

— the full union, like `cloud` and unlike `code`, because §8 makes an unconfigured one the
ordinary case.

The word obeys `shim-protocol.ts`'s stated rule — *"it is a word rather than a product…
naming either provider here would put GitHub and Google in the Core"*. `'drive'`,
`'sheets'` and `'google'` are product names. `'workspace'` fails twice: it is Google's
product name **and** it is the first entry in CONTEXT.md's `_Avoid_` list for Working
Directory. `'documents'` says what is on the other end in the same register `code` and
`cloud` do: `code` is where the work lives, `cloud` is where the infrastructure lives, and
this is where the things **people read and edit by hand** live.

**It is not the Cloud Reach with more scopes**, and this is the load-bearing part of the
section. Three arguments, in order of how badly each fails if ignored:

**The announcement would become a lie.** `announceCloud` tells every Session
*"Everything you do in Google Cloud is done as ${account}, and the roles somebody granted
that account are the whole of what you can touch."* That sentence is false for Drive.
Drive's boundary is not an IAM role; it is who pressed Share, and a shared drive
membership, neither of which appears in the Cloud console. An agent told the roles are the
boundary will go and read IAM when it meets a 403, and IAM will have nothing to say. This
is ADR-0020 §2's own failure mode — a Reach reporting something that "would then be a lie"
— in a second colour.

**CONTEXT.md's Cloud Reach would become false.** It is defined as *"What the agent can
touch in Google Cloud at all"*. Drive is not Google Cloud. Same vendor, different product,
different permission model, different console, usually a different administrator.

**Most deployments want one or the other.** Fusing them means a team that wants a Depot
must also hand over a `cloud-platform` identity, and every deployment that already has a
Cloud Reach silently gains Drive access on upgrade. Neither is a thing anybody asked for.

The code lives in `src/documents/`, bound by `src/document-containment.test.ts` against
`RESOLVES_A_CREDENTIAL` — the same rule `src/cloud/` carries, for the same reason
(ADR-0015 §4): a library asked to *find* a Google credential resolves, on a Google host, to
roma's own identity.

### 2. The Depot is a place, and it is deliberately not the Reach

Two terms, because they are two things, and today they happen to coincide.

A **Document Reach** is what the credential can touch at all: every file shared with that
service account. A **Depot** is the one folder roma is told to work in. Today the service
account is a member of exactly one shared drive, so the two describe the same set — but
anybody in the organisation who shares a file with that account's email address widens the
first and not the second, without telling roma. Giving them one name would make the
glossary true only until that happens.

This is the distinction ADR-0015 already draws for the cloud when it refuses to give
`ReachProof` an inventory field: what a Reach *reaches* and what roma is *told about* are
not the same question.

Both are named by environment, and **both or neither**:

| variable | |
| --- | --- |
| `ROMA_DOCUMENT_KEY_FILE` | The service account key, by path. Following `ROMA_CLOUD_KEY_FILE`: multi-line secrets belong in mounts. |
| `ROMA_DOCUMENT_DEPOT` | The folder id. |

A key with no Depot is a credential with nowhere to write; a Depot with no key is a folder
nobody can reach. Both are read synchronously, so a deployment that sets one lands in
`readConfiguration`'s single refusal rather than in a second boot — which is the gap
ADR-0015 §8 records against itself and does not close.

### 3. The scope is `drive.file` and `drive.readonly`, and it is a constant

```
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.readonly
```

Not configurable, on ADR-0015 §5's argument: a scope a deployment could widen is a second
boundary, invisible from where the first one is administered.

`drive.file` is per-file — it reaches what the app created and nothing else. That is the
whole of the write side, and it is enough for **both** Doc and Sheet, because the Docs API
and the Sheets API each accept `drive.file` for files the app created. So "the team wants
both formats" costs no extra scope at all: neither `documents` nor `spreadsheets` is
requested.

What that buys is worth stating plainly, because it is the one risk in this design that is
otherwise unbounded. A broad `spreadsheets` or `documents` scope is **not folder-shaped**:
it reaches every file of that kind the account can see, so any employee who shares a
spreadsheet with the account's email address hands it to every Conversation, silently and
with no roma change. Under `drive.file` that widening **cannot touch the write side at
all**, because `drive.file` does not care what was shared — only what was created.

`drive.readonly` is the read side, and it does not have that property: it reaches
everything shared with the account. It is here for two things. Somebody may put reference
material in the Depot for roma to read; and — less obviously — **the boot proof needs it**
(§6).

**These two are coupled, and the coupling is the kind that gets discovered by breaking
it.** The Depot folder was not created by the app, so `drive.file` cannot read it.
Anybody who later decides the read side is unused and removes `drive.readonly` removes
§6's boot proof with it, and will find out at the next deployment rather than at the
edit.

### 4. The agent holds the Document Token; roma makes no Drive call on its behalf

A **Document Shortcut**, `roma-document-token`, on `PATH` in the agent's userland, printing
a token on stdout and `--json` giving expiry and account. The Cloud Shortcut's shape
exactly, for the Cloud Shortcut's reason: without it every Task that needs Drive pays the
model to write a JWT signer and a token exchange again, out of a window somebody else is
waiting on.

The alternative was roma holding the credential and offering the agent a whitelist of
verbs over the socket — read a range, append rows, and nothing else. That is a genuinely
stronger boundary and it was rejected, twice, for reasons worth recording because the
second one is the interesting one:

**It inverts the Shortcut's philosophy.** ADR-0015 §6 is explicit that the Cloud Shortcut
*"does not have to be complete, and is not — where it does not go far enough the agent
writes that call itself."* If roma holds the only credential, every verb roma did not
think of is a wall with nothing behind it: no formatting, no formulas, no second tab, no
fixing a typo it just made, each one an image change away.

**And what it would have protected turned out to be protected elsewhere.** The thing worth
preventing is destruction, and §5 prevents it at the Drive role — which is Google's to
enforce, visible to whoever set it up, and does not require roma to be in the request path
at all.

A stateless MCP server was considered as a third way and is in Alternatives.

### 5. What the agent may not do is Google's to refuse, and Contributor is the line

The service account is a **Contributor** on the shared drive holding the Depot. Read out of
Google's documentation, and unmeasured:

| | read | create | edit | move | trash | delete |
| --- | --- | --- | --- | --- | --- | --- |
| Viewer | ✓ | | | | | |
| **Contributor** | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Content manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The agent creates and edits; it cannot move a file out, trash one, or delete one. The
people in the team hold Content manager and can do all three. So "roma leaves work in the
Depot and a person takes it away" is not a convention anybody has to keep — it is the
permission model, one row apart.

**It must be a shared drive, and that is forced twice over.** The role table above exists
only for shared drives; a folder in somebody's My Drive shared with the account has
different and mushier semantics for who may remove what. And a service account has no Drive
storage of its own, so a file it creates in a My Drive folder is a file it owns against a
zero quota.

**"Cannot delete" is not "cannot lose data", and the difference should be understood before
it is discovered.** Replacing a file's contents is an *edit*, which a Contributor may do.
What makes that survivable is version history, and what makes version history worth relying
on is that it cannot be destroyed through the API either: the Sheets API has no revisions
resource at all, and Drive's `revisions.delete` refuses on Docs and Sheets. So the safety
net cannot be cut by the thing it is protecting against. It is still a **whole-file restore
to a point in time** rather than a per-row undo, and it still requires somebody to notice.

### 6. The boot proof reaches the Depot, and it is the first proof roma has of a permission

Three things are proved before roma accepts a message, and any of them failing blocks the
boot:

1. the key mints a token — which is thrown away, ADR-0015 §8's proof exactly;
2. `GET /drive/v3/files/{depot}?fields=id,name,capabilities&supportsAllDrives=true`
   answers, so the Depot exists and the account can see it;
3. that answer's `capabilities.canAddChildren` is true, so the account can actually put
   something there.

The third is new to roma. Every boot proof it has proves a credential is *live*; ADR-0015
§8 says so of its own and records the gap: *"It proves the key is live. It does not prove
the Cloud Reach has the roles a Task will need, so permission-denied still surfaces inside
a Turn."* Here the check costs one HTTP call and a `fields=` parameter, and it closes the
common half of that gap — a Depot named by a typo, a shared drive the account was never
added to, and an account added as Viewer are three different mistakes that all now produce
one refusal at boot naming which.

**Blocking rather than degrading**, and the precedent is the Installation rather than a
principle. A GitHub App can be uninstalled from a web page at any moment, and
`githubReachFrom`'s proof blocks the boot when it has been — ADR-0008's *"required means
required"*. A Depot is the same shape: a grant a human can revoke in a UI, proved at boot.
What makes it acceptable here is §8's optionality, which confines the outage to deployments
that deliberately asked for a Depot; a deployment that set neither variable can never be
stopped by somebody tidying a shared drive.

**It is a snapshot and not a guarantee.** An account removed from the shared drive an hour
after boot is a 403 inside somebody's Turn. This narrows the window; it does not close it,
and the Turn-level failure path is still required.

### 7. Every file the agent creates carries the Conversation it came from

On create, `appProperties: { conversation: <Conversation Key> }` — Drive metadata visible
only to the app that wrote it, invisible in the Drive UI, and queryable:

```
q: appProperties has { key='conversation' and value='spaces/…' }
```

Two things this buys, and the second is why it is in the ADR rather than in a comment.

**Finding a thread's own output costs no state.** A Conversation that asks for its
requirements document a second time can be updated rather than duplicated, because the
agent can find the first one. roma stores nothing: the association lives on the file, in
Drive, and survives every restart. The Conversation Key is the right key because it is
stable and `/clear` does not move it — the Session Generation does.

**It is the only thing that keeps §8 reversible.** Per-Conversation narrowing is deferred,
not abandoned. The day it is picked up, a Depot full of untagged files is a Depot where
nothing can be attributed to the thread that produced it. Writing the tag now is one field
on a create call; adding it later does not reach backwards.

**It is a convention and not a mechanism.** The agent holds the token, so roma cannot make
it tag anything. The worst case is an untagged file, which loses the affordance and breaks
nothing — and that is the correct amount of enforcement for something whose value is
forward-looking.

**What was built tags the Session id, not the Conversation Key**, and this paragraph is the
amendment rather than a note about one. The Conversation Key never reaches a Session: the
Session Pool is keyed by Session id throughout, `BuildSessionEnv` takes one, and the only
identifier in a Session's environment is `ROMA_SESSION_ID`. Putting the key there means
threading it through `Core`, `SessionPool.send` and `#spawn` — a Core change, which the
Consequences below say this feature does not make.

Both of the things above survive the substitution, one of them intact. **Attribution
backwards is untouched**: a Session id is a pure function of the Conversation Key and the
Session Generation, so every id a Conversation has ever had is computable from the key with
nothing asked of Drive, and #124 can still attribute an old file to the thread that produced
it. **Finding a thread's own earlier output is narrowed**: `/clear` moves the Session id,
so an agent looking for what this thread wrote finds this generation's files and not the
ones before them. That is the loss, it is smaller than the one this section exists to
prevent, and it is bought back by a Core change on the day somebody wants it.

### 8. One Depot for the whole deployment, and everything in it is everybody's

The Cloud Reach's shape, deliberately: *"every Conversation reaches all of it, and so does
everyone who can message roma."*

So one team's requirements document sits beside another's, readable by the other's agent
and by anybody who can message roma. That is a real cost and it is **accepted rather than
overlooked**. Per-Conversation narrowing was designed and set aside in the session that
wrote this record, and is filed as #124; §7 is what keeps the door open.

Two things settled it. **A bearer token cannot be narrowed after it is handed over** — §4
gives the agent a token, so a Depot named per Conversation would be a request rather than a
boundary, and ADR-0015 §6's *"the agent has a shell and can ignore it"* applies word for
word. And **it could not be made a hard boundary in any case**: every Session runs as the
same uid in one container, so one Session's process can read another's environment. What
per-Conversation narrowing would genuinely stop is somebody in thread B asking for thread
A's work and the agent having no reason to refuse. That is worth building; it is not worth
building as though it were containment.

A Reach with no key is **unavailable** rather than absent, and the Shortcut is installed
either way and answers that this deployment has no Document Reach (ADR-0015 §9): a command
that is missing reads as a broken `PATH` and costs a Turn to investigate. Every boot writes
`{event:'reach', credential:'documents', account:null}` whether or not there is one, on
ADR-0020 §5's argument that which deployment an operator is looking at should be readable
rather than inferred from a line that is not there.

### 9. An Audit Record says whether a Task obtained a Document Token

`documentReach?: boolean`. Optional, and absent means no.

The optionality is not a formality and the reasoning is `cloudReach`'s: `readRecord` drops
a line it cannot read, a dropped line leaves its month's total, and that total is what the
Overflow cap is enforced against — so a required field would silently reset the month
across the deployment that added it.

A yes or a no, not a count and not a destination, for ADR-0015 §10's reasons unchanged: one
token does unlimited work for an hour, and the request carries no destination for roma to
record.

**What it is for is sharper here than for the cloud.** Everything the agent does in Drive is
done as one service account, so Drive's own audit log can say what happened and never who
asked. The Audit Record is the only place the Caller exists at all (ADR-0002). Neither log
answers "who put this here" alone; together, and joined on the Task's own time window, they
narrow it. That is the whole of what roma can honestly offer, and given §8 puts every
Conversation's work in one folder, it will be asked for.

The window is wider than the Task: a Document Token outlives the Task that minted it by up
to an hour. Recording the moment of the mint would narrow it, and is not done — it would be
a third kind of field in an area where ADR-0015 §10 has argued only about counts and
destinations, and the accuracy bought does not yet have a question waiting for it.

### 10. The announcement states that the Depot is shared, and instructs nothing

The Document Reach's announcement carries the Depot's id, what the agent may do there
(create Docs and Sheets, edit its own, read what is there), what it may not (move, trash,
delete — and that this is Google's answer rather than roma's), the `appProperties`
convention from §7, and one sentence of fact: **everything in the Depot is visible to every
Conversation and to everyone who can message roma.**

That sentence is there because of an asymmetry the agent has no way to guess. Every place
roma has ever given it is private — the Working Directory is one per Session, seen by
nobody else, reclaimed after a week. An agent that has learned that roma's places are
private will treat the Depot as another one. `announce.ts`'s own first line is *"A
capability nobody knows about is a capability nobody has"*; the inverse costs a leak
rather than a wasted Turn.

**Stated as a fact, with no instruction attached.** Not "so do not put anything sensitive
there": roma cannot know what a deployment considers sensitive, and a guessed policy is
worse than none because it reads as a control. `announce.ts` already keeps this line —
*"a permission error is an answer about the roles and not about roma"* — stating what is
true and leaving the inference where it belongs.

## Consequences

- `CredentialWanted` gains a member, so every exhaustive switch over it stops compiling
  until it is handled, and `Reaches` gains a slot the composition root must fill. That is
  ADR-0020 §8's "correct amount of friction", collected.
- The image gains a program. `packaging.test.ts` and `Dockerfile` both grow a third
  userland entry, and a deployment running from source has no Document Shortcut at all —
  the same asymmetry `ROMA_GH_BIN` already carries.
- **The Depot grows monotonically and nothing roma has can reclaim it.** The account cannot
  trash or move, by §5, and that is the property that makes the design safe; the same
  property means every artefact ever produced stays until a person moves it. This is #41's
  shape on somebody else's storage, and it is filed as #125 rather than solved.
- `drive.readonly` means anything shared with the account's email address is readable by
  every Conversation's agent, and nothing tells roma when that happens. The write side is
  immune (§3); the read side is not.
- An operator's boot log gains a line on every boot, including every boot of every
  deployment that has no Document Reach.
- Rotating the key needs a restart, as the Cloud Reach's does — it is read at boot and
  held.
- **Nothing in the Core changes.** `OutboundInstruction` is untouched, no Channel learns a
  new capability, and no Adapter is involved: what leaves does not leave through a Channel.
  ADR-0011's open question about the reverse direction is still open for *Channels*; this
  answers it for Drive and for nothing else.
- The agent is expected to put the file's link in its Result, because that is the only way
  the person who asked finds it. Nothing enforces that and roma cannot see whether it
  happened.

## Alternatives considered

**Widen the Cloud Token's scope and add a folder variable.** About an hour's work against a
week's. Rejected in §1 on three counts, of which the announcement becoming false is the one
that would have cost real Turns.

**roma holds the credential and offers a whitelist of verbs.** The stronger boundary, and
the one recommended until §5 turned up. Rejected in §4: it inverts ADR-0015 §6's stated
philosophy — every verb roma did not think of becomes an image change — and the destruction
it was protecting against is refused by the Drive role anyway, without roma being in the
request path.

**A stateless MCP server, written by roma.** Genuinely attractive, and it voids the one
objection this repository has recorded against MCP — `gh-shim.ts`'s *"an MCP server starts
once per Session and stays"* is exactly what stateless does not do, and `ShimServer` is
already a stateless request/response socket server. It would have made the verb whitelist
cheap, made per-Conversation checks possible, and let an Audit Record name a destination.
Set aside rather than refuted, and for a reason this repository takes seriously: **nothing
about it has been measured.** Which protocol revision the pinned Claude Code speaks, whether
its client accepts a Unix socket or forces a localhost port with no filesystem permissions
on it, what passing MCP configuration costs against ADR-0017, and how much context a tool
list spends per Session — four unknowns, on a build whose pin is a re-verification event
(ADR-0007). ADR-0015's own history is what makes this a deferral rather than a rejection:
it was reversed twice by measurement, both times within an hour of somebody taking one.

**A third-party Google Drive MCP server.** Rejected on the half of `gh-shim.ts`'s objection
that stateless does not touch: *"its token is an environment variable read once at launch."*
Running inside the agent's space it is a static key a shell can read and copy into a
Transcript roma never deletes — which is verbatim the alternative ADR-0015 already
considered and rejected. Running in roma's space it is workable, but it would need pinning
by version and hash like `gh` and Claude Code, its verb list would be its own rather than
roma's, and filtering that list is proxy logic — so most of the saving evaporates. There is
also a specific trap: such servers commonly resolve Application Default Credentials, which
on a Google host is roma's own identity, and no containment rule of roma's binds a package
it did not write.

**Per-Conversation Depots.** Set aside in §8, and the mechanism is the reason rather than
the appetite: a bearer token cannot be narrowed after it is issued, and same-uid Sessions
can read each other's environment, so it could only ever be a soft boundary. Worth having
as one; not worth shipping as though it were containment. §7 is what keeps it buildable.

**Upload files rather than create native ones.** Rejected on what the PM in the motivating
case actually does with the result: comment on it, restore an earlier version of it, and
paste a link to it. A `.md` in Drive supports none of the three, and the create call is the
same call either way.

**Sweep an outbox directory in the Working Directory.** The mirror of an Enclosure, and it
would need no new agent-facing anything. Rejected once the case was described: what is being
written is composed from the Conversation, not produced on disk, so an outbox would be a
directory the agent writes to for roma's benefit and no other reason.
