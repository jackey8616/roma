# 41. A Cloud Reach widens only through a grant a person approved

Date: 2026-11-11

## Status

Accepted, and **implemented**. Extends ADR-0015 rather than reversing it: the Cloud
Reach is still one identity, chosen by whoever deploys roma, reached by every
Conversation. What is new is that its roles may be widened **for a while**, and only
by a person approving a request in Google Cloud. Leaves ADR-0009 untouched: nothing
here compares, parses or decides anything by a Caller.

`src/grants.ts` holds what roma checks and what it says; `src/cloud/pam.ts` is the
only code that knows the grants are Google's Privileged Access Manager (PAM);
`roma-cloud-grant` is the Cloud Grant Shortcut.

**Amended 2026-11-13 (#228)**, in §3 and §4, after a containment review of 0.12.0.
Both sections claimed more than the code gives. The boundary is the Cloud Reach's
identity in Google Cloud, which roma checks only in the scopes it was named and
only at boot. The stamp is a search aid, and proving a grant came from a Task
goes through `cloudGrants`. The decisions are unchanged; what changed is what
they are said to guarantee.

### Verification status

**Measured, in a scratch project (2026-11-11), by hand rather than through roma.**
A PAM entitlement on a project, scoped by an IAM Condition to one bucket, with a
service account as the eligible requester and a person as the approver:

| what | measured |
| --- | --- |
| a service account can be the requester | yes: `CreateGrant` by the service account, `requester` is its email |
| approval to `ACTIVE` | 1.3 s |
| `ACTIVE` to the role working | ≤ 2 s |
| reads inside the condition / outside it / a delete | 200 / 403 / 403 |
| the grant ending to `ENDED` | ≤ 10 s, after which reads are 403 |
| a binding left in the project's policy afterwards | none |
| what PAM wrote while it was active | a conditional binding titled `Created by: PAM`, with `request.time < timestamp(…)` joined by `&&` to the entitlement's own condition |
| what onboarding needed | the organization's PAM service agent granted `roles/privilegedaccessmanager.serviceAgent` on the project; without it, creating the entitlement answered `FAILED_PRECONDITION` |
| the audit trail | `CreateGrant` as the service account, `ApproveGrant` as the person, then `PAMActivateGrant` |

The same session measured the alternative this ADR rejects — a per-session service
account the user grants with their own credential — and found it working and worse:
the grant took 77 s to take effect, and the expired binding stayed in the resource's
policy, where only the user could remove it.

**Measured through roma's own code (2026-11-11)**, in the same scratch project, with a
service account key as the Cloud Reach and `ROMA_CLOUD_GRANT_SCOPES=projects/…`.
`cloudReachFrom`, `prove`, `ShimServer` and `roma-cloud-grant` ran against the real PAM,
with no Channel or model:

| what | measured |
| --- | --- |
| `entitlements:search` as the Cloud Reach, with no IAM role | 200 |
| an entitlement with no approval workflow in scope | boot refused, naming it |
| `createGrant` as roma sends it | accepted, `APPROVAL_AWAITED` |
| `privilegedAccess` on the answer | present, so the notice shows the grant's own roles, each with its own condition |
| **`grants.get` on its own grant, as the requester** | **403, `privilegedaccessmanager.grants.get` denied** |
| `grants:search` with `callerRelationship=HAD_CREATED` | 200, the grant is listed with its state |
| a person approving in the console, then `status` | `ACTIVE` |
| the Cloud Token roma mints, with two bindings on two buckets | read in the viewer bucket 200, delete there 403, list the creator bucket 403, create there 200 |

The 403 on `grants.get` is why `status` searches the grants the Cloud Reach requested
rather than getting one. Enforced by `fence:cloud-grant-status-searches-what-it-requested`.

**Not measured:**

- A Cloud Grant asked for by an agent in a Conversation, with its notice posted to Chat.
  The pieces between them are unit-tested; no deployment has run them together.
- That the console address roma links to opens the approval page for a folder or an
  organization. The project form is the one the console showed.
- How long a justification Google accepts. roma stops at 1,000 characters.

## Context

ADR-0015 decided the Cloud Reach is one identity whose roles are the whole of what
the agent may touch, and that every Conversation and everyone who can message roma
reaches all of it. A deployment then has two bad choices: roles narrow enough to be
safe, which leave the agent unable to do the work it is asked for, or roles wide
enough for the work, held all day by an identity anybody in the Channel can steer.

The question was put as: can roma take only the permissions a task needs, from
somebody entitled to give them, for as long as the task runs? Three shapes were
measured or read against Google's documentation:

1. **The user grants a per-session identity with their own OAuth token.** It needs
   `cloud-platform` (or, for Cloud Storage, `devstorage.full_control`, which
   includes changing IAM), so roma would hold the user's full credential for up to
   an hour. "The user's permissions are the ceiling" is false: anybody who can set
   an allow policy can grant roles they do not hold. The expired binding stays on
   the user's resource, where roma has no right to remove it, and the policy fills
   toward its 1,500-principal limit.
2. **One identity per Caller.** It needs roma to decide by a Caller, which ADR-0009
   forbids, and a Chat Caller is `users/123…`, not an address any IAM policy names.
3. **PAM, with the Cloud Reach as the requester and a person as the approver.**
   Measured above. roma never holds anybody's credential, a person approves in
   Google's own console, and PAM removes what it added.

## Decision

### 1. The Cloud Reach is still one identity, and a Cloud Grant widens it for a while

A **Cloud Grant** is a PAM grant roma requested as the Cloud Reach. While it is
active, the Cloud Reach has the entitlement's roles, under the entitlement's
conditions, for every Conversation — exactly the shape ADR-0015 gave the Reach,
held for a while instead of all day. A deployment that uses this gives the Cloud
Reach narrow standing roles and puts the rest behind entitlements.

roma creates no entitlement. Which roles may be asked for, under which conditions,
for how long, and who approves are the deployment's decisions, made in Google
Cloud where they can be audited and changed without touching roma.

### 2. roma finds what it may ask for at boot, in scopes it was named

`ROMA_CLOUD_GRANT_SCOPES` names projects, folders or organizations. At boot roma asks
PAM, as the Cloud Reach, which entitlements there it is a requester of, and that list
is the whole of what it will ask for until it restarts. A scope with none in it
refuses the boot, as a Cloud Reach key that cannot mint does (ADR-0015 §8), because
it is a deployment that believes it has something it has not. The variable without
`ROMA_CLOUD_KEY_FILE` refuses the boot too: there is no Cloud Reach to widen.
Enforced by `fence:cloud-grant-scopes-need-a-cloud-reach`.

roma refuses to ask for an entitlement it did not find, so a request for something
nobody set up is answered by roma in a sentence rather than by Google in a 403.
Enforced by `fence:cloud-grant-only-from-what-roma-found`.

### 3. A person approves, in Google Cloud, and roma never approves or denies

The approver is whoever the entitlement names, and there must be one. PAM grants an
entitlement with no approval workflow the moment it is asked.

**The boundary is the Cloud Reach's identity, not roma.** The agent holds a Cloud
Token for that identity (§4), and so can ask PAM for anything the identity is
eligible for, without going through roma. So the condition this whole decision
needs is a deployment's to keep, in Google Cloud: **every entitlement the Cloud
Reach may request, in any scope and at any time, has an approval step whose
approvers are people.** One that does not is a way to widen the Reach that nobody
approves.

roma checks part of that, and the part is narrow. At boot, `PamGrants.find`
refuses to start if an entitlement in `ROMA_CLOUD_GRANT_SCOPES` has no manual
approval step, or a step that names no approvers. Enforced by
`fence:cloud-grant-only-where-a-person-approves`. It does not see:

- an entitlement in a scope it was not named;
- an entitlement created or changed after boot (§2);
- anything at all when `ROMA_CLOUD_GRANT_SCOPES` is unset, because then roma asks
  PAM nothing. The announcement says roma asks for no grant, and not that the
  Reach cannot be widened. Enforced by
  `fence:cloud-grant-no-scopes-claims-no-ceiling`;
- whether the principals an approval step names are people. `needsAPerson` checks
  that a step names some, and PAM accepts a service account as an approver when
  automated approvals are on
  (https://docs.cloud.google.com/iam/docs/pam-configure-settings).

roma has no code that approves or denies a grant. Enforced by
`fence:roma-never-approves-a-cloud-grant`. That keeps roma's own code out of the
approval path; **it is not what stops the agent approving its own grant.** The
agent holds the Cloud Reach's token, and an entitlement could list the Cloud Reach
among its approvers. What stops that is Google's rule that a requester cannot
approve their own request
(https://docs.cloud.google.com/iam/docs/pam-approve-deny-grants).

### 4. roma stamps the Task on the justification, and that is not a boundary

The agent writes the justification and roma puts `roma Task <id>:` in front of it,
so a person reading Google's log can find the Task in roma's Audit Record, which
already names the Caller. A Session running no Task cannot ask through roma at all.
Enforced by `fence:cloud-grant-carries-its-task`.

**The stamp is a search aid, and it proves nothing.** It is string concatenation
(`stampedFor`), and PAM stores the justification as free text. The agent holds a
Cloud Token for the same identity: the Cloud Reach's own `cloud-platform` token,
not narrowed for the agent. With a Cloud Reach configured, the agent's egress
allowlist includes `*.googleapis.com`, and that includes PAM's API. So it can call
PAM itself and write `roma Task <id>:` in front of its own justification, with a
real Task id. A missing stamp can show that a request was made around roma; a
stamp that is there shows nothing.

**What does tie a grant to a Task is the grant's name in `cloudGrants`** (§7).
roma writes it into that Task's Audit Record only for a grant it requested itself,
from the name PAM returned, and a request made directly to PAM never reaches that
code. To trace a grant, look for its name in `cloudGrants`.

**A name missing from `cloudGrants` is not proof on its own.** The Task waits at
most 30 seconds for PAM to answer (§7). A grant PAM makes after that is not in the
Task's Audit Record, which was already written. It is still in the Operator Log:
roma writes a `cloud-grant` line with `operation: 'grant'`, carrying the Task id
and the grant's name, for every answer it gets, however late. A status check
writes a `cloud-grant` line too, so a trace filters on `operation`.

**A name in neither is not proof either.** roma logs the grant's name only once it
has read PAM's answer. If PAM made the grant and the answer was lost on the way
back, roma writes `cloud-grant-refused`, which has no grant name. So the two
records show which grants roma requested and saw answered. They cannot show that
roma did not request some other grant.

The Cloud Grant Shortcut, like the Cloud Shortcut (ADR-0015 §6), makes the
ordinary path the one that can be traced.

Leaving PAM's host out of the agent's allowlist was considered and not done. It
would not be a boundary, since the token works anywhere it can be carried. The
allowlist also matches by suffix and has no way to leave one host out of a
wildcard.

### 5. The agent is told what it may ask for, and to end the Turn while a person decides

The Cloud announcement lists every entitlement roma found, with its roles,
conditions and longest duration, and says how to ask. It tells the agent that it
can ask and cannot approve, that a grant widens the Reach for every Conversation,
and that a new grant is a person's decision: tell the Caller, end the Turn, and go
on when told. A Turn waiting on a person in a loop spends the Shared Window on
nothing. Enforced by `fence:cloud-grant-announced-as-a-request`.

### 6. roma tells the Conversation itself, and its button only opens a page

When roma has requested a Cloud Grant it posts, to the Conversation the Task came
from, what PAM answered: the entitlement, the resource, each role with its own
condition, the duration, the state and the grant. The justification is shown as the
agent's and not roma's. No model writes it and no Turn has to remember to send it.
Enforced by `fence:core-tells-the-cloud-grant`.

The justification is shown on one line, inside one code span, with its backticks
replaced by `ˋ`. Without that, text after a newline left the label and read as roma's
own words, and `<url|text>` or `<users/all>` became a link or a mention (#227). Every
line break folds to a space, the span cannot be closed early, and both Channels show
what is inside it as the characters it is. Enforced by
`fence:cloud-grant-justification-stays-literal`. A notice too long for one message is
cut between lines, never inside the span, which Discord's 2,000 characters otherwise
allowed. Enforced by `fence:discord-grant-justification-not-split`.

The roles are the ones PAM put on this grant, not the ones roma found at boot, since
an entitlement can be widened in between; only when Google names none does the notice
fall back to the entitlement as found, and it says so. Enforced by
`fence:cloud-grant-notice-shows-what-google-granted`. A condition stays with its role,
because in PAM it binds one role binding, and joined across roles an unconditioned
role would read as limited. Enforced by `fence:cloud-grant-condition-stays-with-its-role`.
The notice also tells the approver that every Conversation has the roles while the
grant lasts, since the approver reads the notice and not the announcement. Enforced by
`fence:cloud-grant-notice-says-every-conversation`.

On Google Chat it carries one button, which opens Google Cloud's approval page. It
is a link, never a card action, because an action comes back to roma as a press
and the only thing roma could do with a press is approve. Enforced by
`fence:gchat-grant-button-only-opens-a-link`. On Discord the address is in the text.

The approver approves with their own Google identity, on Google's page. Approving
inside Chat was considered and rejected: roma would need the approver's
`cloud-platform` token, which is shape 1's flaw, or an approving service account,
which moves the decision out of Google's audit trail and into roma.

### 7. The Audit Record names the grants a Task asked for

`cloudGrants` lists the grants roma requested for a Task, and is absent when there
were none. A grant PAM made is recorded and told even when the Seat that asked has
moved on to another Session by the time Google answers, because the grant exists in
Google either way. Enforced by `fence:cloud-grant-recorded-even-if-the-seat-moved`.

That is not enough on its own, because Google can answer after the Task's Turn has
ended — a `/stop`, or a slow PAM — and by then the Task has left the running set and
written its Audit Record. So roma marks a request begun before it asks Google and
finished whatever Google answers, and every Turn of a Task, however it ends, waits for
the requests its Task began before it gives up its slot in the Task Queue. The wait is
inside the slot, so the Conversation's next Task cannot run and answer first while it
lasts; waiting after the slot was released put replies out of order. Enforced by
`fence:cloud-grant-answered-after-the-task-ended` and
`fence:cloud-grant-wait-holds-the-queue`. A request the Task begins while its Turn
is already waiting is waited for too, under the same deadline. Enforced by
`fence:cloud-grant-wait-takes-late-requests`. Once the slot is given up the Session
runs no Task, so a request that arrives after it is refused before Google is asked
(§4), and there is no grant for anybody to miss. The wait is bounded at 30 seconds, since it
holds the Conversation's next Task, and a request still unanswered then is in the
Operator Log when it does answer, and in Google's. Enforced by
`fence:cloud-grant-wait-is-bounded`. Unlike `cloudReach` (ADR-0015 §10), roma does know what was asked for
here, because it made the request. It records the request, not the use: what the
roles were used for is in Google's log, under the Cloud Reach's name.

## Consequences

- A deployment that wants this sets up PAM: onboarding its service agent, entitlements
  naming the Cloud Reach as requester and people as approvers, and
  `ROMA_CLOUD_GRANT_SCOPES`. One that does not changes nothing.
- A Cloud Grant is coarse in time: Google grants no less than 30 minutes, and no more
  than the entitlement allows, at most 7 days.
- A Cloud Grant is shared: while it is active, every Conversation has its roles. That
  is ADR-0015's model, and the approver is told so on the notice that asks them.
- An entitlement added after boot is not seen until roma restarts, as a rotated key
  is not (ADR-0015 §3). The agent can still request it directly, so whether it has a
  person approving it is the deployment's to keep, not roma's (§3).
- A deployment that leaves `ROMA_CLOUD_GRANT_SCOPES` unset has turned off the Cloud
  Grant Shortcut, not PAM. If the Cloud Reach is eligible for an entitlement
  anywhere, the agent can ask for it, and roma checks none of them.
