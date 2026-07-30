# Verification: what only a real GitHub App can settle

Date: 2026-07-30
Status: **not yet run.** Every question below is open, and this document exists so
that the list is written down honestly rather than discovered one failure at a
time.

ADR-0008 says of itself that "nothing here has been measured", and the ticket
that implemented it (#60) kept that admission rather than quietly dropping it.
The house standard is measurement — ADR-0002, ADR-0003, and the transcript
collision work all rest on captures — and the GitHub work does not meet it yet.

What has been measured is in the last section. What has not is everything else,
and the code that depends on it says so at the point where it depends on it.

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

**Expected:** both succeed, on `contents: write`.

### 2. Does `gh` authenticate with an Installation Token?

`GH_TOKEN=<installation token> gh auth status`, then `gh issue create`,
`gh pr create` and `gh pr comment`.

**Expected:** all four succeed on `issues: write` and `pull_requests: write`.
This is the one that decides whether the `gh` Shim is worth having at all — if
`gh` refuses an Installation Token, the whole issues-and-pull-requests half of
ADR-0008 needs a different mechanism.

### 3. Are the resulting artifacts attributed to the App?

Read back the issue, the pull request and the comment from question 2.

**Expected:** author is `<app-name>[bot]`, visibly not a person. Story 11 asks for
exactly this, and nothing in roma can enforce it — it is GitHub's behaviour or it
is not true.

### 4. How many times does `git` call a Shim during a successful clone, fetch and
push?

**Unknown, and it is the number that decides whether the caching matters.** If a
clone asks once, `InstallationTokens` is saving one round trip an hour and could
have been a great deal simpler. If it asks per object or per redirect, the cache
is load-bearing and the single-flight in it is too.

Run each of the three operations against a repository large enough to redirect,
with a Shim that counts.

### 5. Does listing installations behave as described — including the
more-than-one case?

`GET /app/installations` with an App JWT, on an App installed once and then on
one installed twice.

**Expected:** an array; `account.login` present on each. The two-installation case
is what `InstallationAmbiguous` refuses on, and the refusal names what that field
returned — so if the field is absent or shaped differently, the refusal names
`installation 12345` and is much less use.

### 6. Does `--append-system-prompt` actually change what the agent believes it
can do?

Two Sessions in an empty working directory, one with the announcement and one
without, both asked to look at a repository by name.

**Expected:** the one with it clones; the one without explains that it has no
access. If that is not the difference, the announcement is decoration and story 3
is unmet by the thing built for it.

### 7. Does the JWT arithmetic hold against GitHub's clock?

`appJwt` backdates `iat` by a minute and expires nine minutes later, both from
GitHub's documentation.

**Expected:** accepted. A rejection here presents as roma failing to mint with a
401 that says nothing about time.

## What *has* been measured

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
