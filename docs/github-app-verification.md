# Verification: what only a real GitHub App can settle

Date: 2026-07-30
Status: **run.** Six of the seven questions are answered against a real GitHub App
on a real organisation, including every one that anything was riding on. The
seventh needs a running roma rather than a script and is marked so.

Measured on: macOS, `git` **2.41.0**, `gh` **2.93.0**, Node **22.22.3**, roma at
`cd3ca2c` plus the fix this run produced. The Installation was one organisation
with 15 private repositories; the clone below was of a private one, so every
credential in this document did real work.

**The organisation and its repositories are deliberately not named here.** They
are somebody's private inventory and this repository is public. What is recorded
is what was measured, which is all the design needs.

ADR-0008 said of itself that "nothing here has been measured", and #60 kept that
admission rather than dropping it. This is that debt being paid, and the house
standard — ADR-0002, ADR-0003, the transcript collision work — is what asked for
it.

## Why no test does this

**No test drives a real GitHub App**, deliberately.

- CI has no private key and should not have one. A key in a public repository's
  secrets that can write to an organisation is a worse thing to own than the
  problem it would verify.
- Seam 2 is opt-in because it spends money; this spends none, so it could not
  reuse that switch, and adding a fourth seam would mean an opt-in nobody can
  decide the CI policy for.

The live assertion is in the product instead. Startup lists the App's
installations, refuses on any number but one, and fetches the Installation's
repositories before anything that could accept an Ingress Message exists — a
failure blocks the boot. That runs on every boot, which is more often than any
test needing a private key could run.

## The questions

Each of these needs one App, one afternoon, and somewhere to write the answer
down. None needs a long-running deployment.

### 1. Does a minted Installation Token clone and push?

The single load-bearing assumption. `git clone https://github.com/<owner>/<repo>.git`
with `x-access-token` as the username and the token as the password, then a
commit and a push.

**Clone: YES.** A private repository, over HTTPS, through the real Credential
Shim with the real `gitConfig()` — `git` asked, the Shim answered
`username=x-access-token` and a minted token, and the clone completed. That it
asked at all is the proof the repository was private: git only consults a helper
after a 401.

**Push: YES.** A branch and an empty commit, pushed over HTTPS on the same
credential, on `contents: write`. Both were deleted afterwards.

### 2. Does `gh` authenticate with an Installation Token?

`GH_TOKEN=<installation token> gh auth status`, then `gh issue create`,
`gh pr create` and `gh pr comment`.

**YES — and this was the biggest single risk in the slice.** `gh auth status`
through the real Shim reports:

```
github.com
  ✓ Logged in to github.com account <app-name>[bot] (GH_TOKEN)
  - Active account: true
  - Git operations protocol: https
```

So `gh` takes an Installation Token from `GH_TOKEN` without complaint, and
identifies itself as the App. The issues-and-pull-requests half of ADR-0008
stands, and the `gh` Shim is worth having. Had this failed, that half needed a
different mechanism entirely.

`gh issue create` also succeeds, on `issues: write`, and so does `gh api -X DELETE`
against a ref — which is how the verification branch was cleaned up, since
`git push --delete` insists on being inside a repository even when the remote is
spelled out in full.

One thing worth naming, because the output demonstrated it: `gh auth status`
prints the token it is using, partially masked. The token is itself a JWT whose
payload carries `iat` and `exp` 3600 seconds apart — **the one-hour lifetime,
observed rather than quoted**. That hour is the whole of what bounds a credential
which reaches a Transcript roma never deletes, and a diagnostic command printing
one is exactly the leak ADR-0008 expects and accepts.

### 3. Are the resulting artifacts attributed to the App?

Read back the issue, the pull request and the comment from question 2.

**YES.** The issue `gh` opened, read back with `--json author`:

```json
{ "author": { "is_bot": true, "login": "app/<app-name>" } }
```

`is_bot` is true and the login is namespaced under `app/`, so nobody has to guess
whether a human wrote it. Story 11 is met, by GitHub's behaviour rather than by
anything roma does.

Worth noting the shape, because it is not what this document guessed: `gh --json
author` reports `app/<app-name>`, while `gh auth status` says `<app-name>[bot]`.
Two spellings of one identity, and code that matched on either string alone would
be reading a presentation detail. `is_bot` is the field that means it.

### 4. How many times does `git` call a Shim during a successful clone, fetch and
push?

**Once per operation. One for a clone, one for a fetch, one for a push.** Counted
by the `ShimServer` itself, which logs every request. `gh` asked once per
invocation — three invocations, three requests, every one of them with no
repository path.

That is the low end of the range this question was worried about, and it is worth
being straight about what it means: **the caching is doing less than feared.**
`git` does not ask per object or per redirect, so a clone costs one credential
request, not hundreds. `InstallationTokens` is therefore saving one network round
trip per git operation rather than rescuing roma from a rate limit.

It is still worth having, and the reasons are the ones that survive the number:
`gh` asks once per *invocation* and an agent runs many; three Tasks run at once by
design, so the single-flight is about concurrent Sessions rather than about one
clone; and a token that expired mid-operation would be a failure nobody could
reproduce. But "the cache is load-bearing" would be an overstatement, and the
class's own comments should not make it.

Also confirmed here: every `git` request carried the repository path
(`<owner>/<repo>.git`), and the `gh` request carried none — `credential(-)` in the
log. Both are exactly what `credential.useHttpPath` and ADR-0008's amendment
predict.

### 5. Does listing installations behave as described — including the
more-than-one case?

`GET /app/installations` with an App JWT, on an App installed once and then on
one installed twice.

**YES for the one-installation case.** `GET /app/installations` returned an array
of one, with `account.login` present, and `GET /installation/repositories` paged
back 15 repositories through an Installation Token. So the boot check works and
`InstallationAmbiguous` would have a real name to print.

**The more-than-one case is still unrun**, and it needs a second installation of
the same App rather than a second App. It is the smallest gap left here: what
rides on it is the wording of a refusal, not whether anything works.

### 6. Does `--append-system-prompt` actually change what the agent believes it
can do?

**Still open, and it is the one that needs a running roma** rather than a script:
two Sessions in an empty working directory, one with the announcement and one
without, both asked to look at a repository by name.

**Expected:** the one with it clones; the one without explains that it has no
access. If that is not the difference, the announcement is decoration and story 3
is unmet by the thing built for it — and the fix would be the text, not the
mechanism.

Everything the announcement *claims* is now true, which is what this run
established. What is unmeasured is whether saying so changes what the agent
attempts.

### 7. Does the JWT arithmetic hold against GitHub's clock?

`appJwt` backdates `iat` by a minute and expires nine minutes later, both from
GitHub's documentation.

**YES.** Every call in this run needed one and none was refused, so the
nine-minute span measured from a backdated `iat` is inside whatever GitHub
actually enforces.

Worth noting what this run would *not* have caught: #60's review found `exp - iat`
was originally exactly 600 seconds — the documented maximum — because the
backdating was added twice. That would probably have passed here too, which is
why it was fixed on the argument rather than on a measurement.

## What this run found that no question asked for

**A real bug, in the product, on the path ADR-0008 promises works.**

`gitCredentialHelper()`'s default resolves the Shim beside `shims.ts` with the
same extension — `.js` from `dist/`, `.ts` from a checkout — so that running roma
from source works, which ADR-0008 lists as a consequence it accepts and story 22
asks for. Node 22 runs a `.ts` file happily by stripping types. What it cannot do
is resolve the `../shim-client.js` the Shim imports, because that file is `.ts` on
disk. So from a checkout the helper died with `ERR_MODULE_NOT_FOUND`, `git` fell
through to asking for a username, and **every credential request in a from-source
roma failed**:

```
致命錯誤: could not read Username for 'https://github.com/...': terminal prompts disabled
```

`dist/` was never affected, so the image was fine and every test passed. The test
suite could not see it because the real-`git` test built its own helper command
instead of using the default — it supplied `--import tsx` by hand, which is
exactly the thing production was missing.

Fixed two ways. `gitCredentialHelper` now asks for a TypeScript loader when the
Shim is one, resolved to an **absolute** path — `--import` resolves a bare name
against the current working directory, and `git` runs the helper wherever git
happens to be, which is the agent's Working Directory and has no `node_modules`.
And `git-credential-shim.test.ts` now writes `gitConfig()` with nothing
substituted, so the default is what the real `git` is pointed at.

The lesson is the general one and worth keeping: a test that constructs the thing
production constructs, rather than using it, verifies the test.

## What was measured before any of this

One thing, and it is the protocol everything else hangs off. On `git` 2.43.0,
against real GitHub, before any credential was supplied:

```
--- operation: get ---
protocol=https
host=github.com
path=jackey8616/a-repo-that-does-not-exist-9f3a.git
wwwauth[]=Basic realm="GitHub"
--- operation: erase ---
protocol=https
host=github.com
path=jackey8616/a-repo-that-does-not-exist-9f3a.git
username=x-access-token
password=
wwwauth[]=Basic realm="GitHub"
```

So: with `credential.useHttpPath` set, a real clone names the repository; and a
helper is called twice on an authentication failure, the second time with `erase`
and with the rejected credential handed back. Both are recorded in ADR-0008's
amendment, and both are now asserted continuously rather than remembered —
`src/github/git-credential-shim.test.ts` drives a real `git` against the real
Shim in the default run, with no network and no credential.

## The one that is not a question

`workflows: write` under `bypassPermissions`, with no egress allowlist, is a real
escalation path: the agent can rewrite what counts as passing, and CI is usually
where a repository's secrets are. ADR-0008 takes that deliberately. It is
restated here, and in the ticket, so that whoever runs the verification above
reads it once more before granting anything.

## The gap this slice could not close

**Story 26 — "the App's private key to remain unreachable from inside the
container the agent runs in" — is not met, and no arrangement of this code meets
it.**

ADR-0008 states it as the one line with no trade-off behind it: "the private key
never enters the container's reachable space." As built, it does. roma reads the
PEM from a path mounted into its own container; the agent's Claude Code process
is a child of roma's and runs under the same uid; a shell therefore reaches both
the file and `/proc/<roma>/environ`. `buildEnv` keeps the *path* out of a
Session's environment, which makes finding it slightly less obvious and is not
the same thing as a boundary.

What roma actually has is the same shape as a Credential Shim: the ordinary path
is correct, and the agent can step off it. The protection doing real work is the
**one-hour expiry** — that is what bounds a token which escapes into a Transcript
roma never deletes, and it holds regardless of the key.

Closing it needs roma and the agent in different containers, which is a change to
how roma spawns Claude Code and not a change to any of this. It is the same
conversation as the credential-injecting proxy and the egress allowlist, both of
which ADR-0008 defers for the same reason. Recorded here rather than left as a
sentence in an ADR that the code quietly contradicts.
