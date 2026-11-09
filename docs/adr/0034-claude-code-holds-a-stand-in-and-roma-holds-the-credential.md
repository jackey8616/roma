# 34. Claude Code holds a stand-in, and roma holds the credential

Date: 2026-11-09

## Status

Accepted, and **implemented**. Closes GHSA-wqj9-8qq4-w466 (finding I2): the agent could
recover the Shared Window token from Claude Code's own environment, and what it printed
landed unredacted in the Transcript. Amends ADR-0002's environment maps and makes true the
sentence in ADR-0008 that said nothing longer-lived than an hour may come near a Transcript.
Takes up the credential-injecting proxy ADR-0008 deferred — for the Messages API
credential, not for the forge's.

## Context

ADR-0002 put `CLAUDE_CODE_OAUTH_TOKEN` in the environment of every Shared Window `claude`
process, and `ANTHROPIC_API_KEY` in every Overflow one. The token is a `claude setup-token`
token, which the pinned CLI requests with a one-year lifetime.

Claude Code 2.1.220 already deletes both from the environment it gives the Bash tool, so a
plain `env` shows neither. But the Bash tool runs as `claude`'s own uid, `claude` is
dumpable, and `/proc/<claude>/environ` still holds the token. The advisory's reproduction —
the real pinned CLI in the image, against a fake Messages API — read it in one tool call and
found it in the tool result and in the JSONL Transcript. roma deletes nothing from a
Transcript (ADR-0006).

Moving the agent to another uid does not help: the Bash tool is `claude`'s child, so it
shares `claude`'s uid whatever uid that is. ADR-0032 made **roma** unreachable; this is about
the process the agent's tools run inside. The only fix is for the token not to be in that
process at all.

## Decision

**A Claude Code process is given a stand-in, never the credential.** roma runs a credential
proxy on loopback, inside roma (`CredentialProxy`). For each credential it hands out a
random stand-in shaped like one — `sk-ant-oat01-roma-stand-in-…` for the Shared Window,
`sk-ant-api03-roma-stand-in-…` for Overflow — and `buildEnv` puts that stand-in where the
credential used to go, with `ANTHROPIC_BASE_URL` pointed at the proxy. Every request
`claude` makes arrives at the proxy carrying the stand-in, and leaves for
`https://api.anthropic.com` with the real token (`Authorization: Bearer`) or key
(`x-api-key`) in its place.

- `buildEnv` takes a `Fronted` credential, which only `CredentialProxy.front` makes; handing
  it the credential itself does not compile. Enforced by
  `fence:buildenv-never-the-real-credential` and
  `fence:startup-no-credential-in-any-claude-env`.
- The proxy exchanges only its own stand-ins, each only in the header its kind travels in,
  and refuses everything else before it leaves. Enforced by
  `fence:credential-proxy-swaps-only-its-own-stand-in`.
- It forwards only to its one upstream. The upstream's protocol, host and port are fixed
  and the request target is never resolved as a URL. The target must also be a plain path
  of RFC 3986 characters. An absolute-form target, one starting with `//`, or one with a
  backslash — which a WHATWG URL parser reads as a slash, so `/\attacker.example/` names
  a host — would otherwise send the credential to whatever host it names. Enforced by
  `fence:credential-proxy-forwards-only-to-upstream`.
- When the API drops a streamed answer partway, the proxy ends the answer it is relaying.
  Otherwise `claude` waits on a stream that will never finish. Enforced by
  `fence:credential-proxy-ends-a-dropped-answer`.
- The proxy lives and dies with roma: started before the self-check, closed on shutdown and
  on a refused boot. Enforced by `fence:startup-proxy-closed-on-refusal`.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in every Claude Code environment. Measured
  against the image: with it unset, 2.1.220 makes four more calls straight to
  `api.anthropic.com`, around `ANTHROPIC_BASE_URL`, and 2.1.319 makes six. They would carry the stand-in and be
  refused on every Turn. With it set, there are none, and the Turn is unchanged. Enforced by
  `fence:buildenv-no-traffic-around-the-proxy`.

The same measurement is what the decision rests on: under the stand-in and
`ANTHROPIC_BASE_URL`, both 2.1.220 and 2.1.319 still send the OAuth bearer and the `oauth-2025-04-20` beta to
the base URL, `system/init` still reports `apiKeySource: "none"`, and the Startup Self-Check
passes unchanged.

`scripts/verify-image.sh` §6 proves the whole of it against the built image. It uses the
real pinned `claude`, roma's compiled `CredentialProxy`, `buildEnv` and `dropRoot`, and a
fake Messages API whose first answer is one Bash call. That probe hunts for the token in the
tool's own environment, in `claude`'s environment, memory and open files, and in roma's
environment and memory. The token must be found in none of them, nor in the Transcript or
anywhere under the Claude config dir, while the fake API is sent the real one. A control
run with the token in `claude`'s environment, as before this decision, must find it, so the
probe is known to work.

## Consequences

- What the agent can take away is the stand-in. It works through the proxy while roma runs
  and is worth nothing once roma stops, and a new one is made on every boot. A Transcript
  that records one records nothing anybody can use later.
- **This is not a boundary against spending.** The agent can call the proxy with the
  stand-in exactly as `claude` does, so it can still run Turns on the Shared Window, or on
  Overflow if its Session was given that, for as long as roma is up. What it can no longer
  do is take a year-long credential somewhere else.
- The proxy's protection rests on ADR-0032. The real credential lives in roma's memory and
  roma's environment, and the agent is kept out of both only because roma started as root
  and dropped. roma run from source, or under `--user`, leaves both reachable, as it already
  logs.
- Every Messages API call now makes one extra loopback hop. Responses are streamed through
  as they arrive.
- Nonessential traffic is off for every Session: whatever Claude Code sends for telemetry,
  error reporting or update checks is no longer sent. Nothing roma relies on was found among
  it. Seam 2 runs through the proxy, so a paid run is also a live check of all of this.
- **Not covered:** a token printed into a Transcript before this decision is still there.
  An operator upgrading should rotate the Shared Window token and the Overflow key.
- **Not covered:** the Codex Runtime (ADR-0026), whose credential handling is not built yet.
  It will need the same answer.

## Considered and rejected

**`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`.** The pinned CLI supports it, and it keeps the
token out of the environment. It does not keep the token out of `claude`'s memory, which the
agent's uid can read wherever Yama allows. On its own it moves the token from one readable
place to another.

**Making `claude` not dumpable**, for instance by installing it execute-only so the kernel
marks it on exec. It would close `/proc/<claude>/environ` and `mem` to the Bash tool. It
leaves the credential inside the process the attacker is driving, relies on Claude Code
never reading its own binary, and is undone by the next image change that forgets. Worth
reconsidering as a second layer; not a substitute for the token not being there.

**Redacting Transcripts.** It contradicts ADR-0006. It would also leave the token readable
by the agent, so it can still be sent somewhere else. The Transcript is where this was
noticed, not where the leak is.
