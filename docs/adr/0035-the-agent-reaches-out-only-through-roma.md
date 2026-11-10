# 35. The agent reaches out only through roma

Date: 2026-11-09

## Status

Accepted, and **implemented** — for a deployment that runs the gateway, as `compose.yaml`
does. Closes GHSA-7hpq-f638-956r (finding I3): the agent reached arbitrary hosts, and
ADR-0003 described an egress allowlist that was never built. Amends ADR-0003, ADR-0007 and
ADR-0008, each of which said roma has none.

## Context

ADR-0003 lists an egress allowlist — the Anthropic API, the git remote, package registries —
and says that under `bypassPermissions` it is the only protection still doing work. Nothing
built it. At `93ff5f6` the advisory's reproduction drove the real pinned `claude` in the image
to GET `example.com` and POST a canary to `httpbin.org`, and both answered 200.

Two facts shape the answer.

**roma and the agent share a network.** They run in one container, so one network namespace,
and since ADR-0032 under one uid. Nothing on the network can tell roma's connection from the
agent's. A single allowlist on the container would have to admit everything roma needs —
Google's APIs, Pub/Sub, Discord, GitHub's API, Anthropic — and so admit it for the agent too.

**Proxy variables constrain nothing.** The agent has a shell. `curl --noproxy '*'` ignores
them, and so does anything the agent writes itself.

ADR-0034 changed one thing in roma's favour: `claude` no longer talks to Anthropic. It talks
to roma's Credential Proxy on loopback, and roma talks to Anthropic. The agent's own list no
longer needs the Messages API.

## Decision

**The network gives roma one way out, and roma decides what of it the agent gets.**

1. **roma runs on a network with no route out.** In `compose.yaml` that is a Docker network
   created `internal: true`. The only thing on it that can reach the internet is the
   **Egress Gateway**, which is on a second network as well.
2. **The gateway lets through whoever carries its token, and nobody else.** It is a CONNECT
   proxy, run from roma's own image (`node /app/dist/egress/gateway.js`). A request without
   `Proxy-Authorization: Basic roma:<token>` is answered 407. It tunnels only to a host name
   on port 443: never an address, a single label or another port. Enforced by
   `fence:egress-gateway-refuses-without-its-token` and
   `fence:egress-connects-only-to-names-on-443`.
3. **Only roma holds the token.** `ROMA_EGRESS_TOKEN_FILE` is read as root, before roma drops
   to `node`, and roma refuses to start if the agent could read it — the same rule as every
   other key file. Enforced by `fence:main-drops-root-after-reading-keys`. `buildEnv` passes
   no proxy variable of roma's to a Session.
4. **All of roma's own traffic goes through the gateway.** `fetch` and `WebSocket` through a
   global undici dispatcher, gaxios and gRPC through `HTTPS_PROXY` and `grpc_proxy`, and the
   Credential Proxy through its own tunnelling agent. Loopback stays direct. Enforced by
   `fence:roma-reaches-out-only-through-the-gateway`, one case per client.
5. **The agent gets a proxy inside roma, with an allowlist.** It listens on loopback, accepts
   CONNECT to a listed host on 443, and forwards it to the gateway with roma's token. It
   never dials out itself. Enforced by `fence:egress-refuses-an-unlisted-host` and
   `fence:egress-agent-proxy-goes-only-through-the-gateway`. `buildEnv` points every proxy
   variable a tool reads at it, and keeps loopback out of it so `claude` still reaches the
   Credential Proxy. Enforced by `fence:buildenv-agent-traffic-through-egress-proxy`.
6. **The agent's allowlist is assembled from what is configured.** The npm registry always;
   GitHub's hosts, named in `src/github/egress.ts`, because the Code Reach always exists;
   `*.googleapis.com` with a Cloud Reach, and with a Document Reach the Drive, Docs and Sheets
   APIs its announcement names, because the agent calls those APIs itself with the token the
   Shortcut mints; and whatever `ROMA_EGRESS_ALLOW` adds. Enforced by
   `fence:document-reach-reaches-the-apis-it-announces`. Each Reach names its own hosts in its own directory, so
   the containment rules still hold. The list is written to the operator log at boot.
7. **roma refuses a network that lets it out.** With a gateway configured, roma opens a
   connection straight to `api.anthropic.com:443` before it routes anything. If that
   succeeds, the allowlist would hold nothing, and roma refuses to start. Enforced by
   `fence:startup-refuses-an-open-network`.
8. **Without a gateway, nothing changes.** `ROMA_EGRESS_GATEWAY` unset starts roma as before,
   with `{"event":"egress","gateway":null}` in the log to say so.

`scripts/verify-image.sh` §7 proves the whole of it against the built image. It runs the
real pinned `claude` and a fake Messages API on an `--internal` network beside a real
gateway, and a Bash call that tries what the advisory did. Direct HTTPS, an unlisted host
through the proxy, a POST of a canary, and the gateway without its token must all fail, and
the gateway must answer 407. `git ls-remote` against this repository, and roma's own
`fetch`, must succeed. A control run on Docker's default network with no gateway must get
out, so the probe is known to work. §8 renders `compose.yaml` and checks that it names a
release rather than `latest`, passes every Channel's and Reach's variables, and mounts each
key file at the path roma is told.

## Consequences

- **What stays open is what the allowlist names.** The agent can still reach the hosts on
  its list, and on a shared host that includes anything an attacker hosts there: a repository
  the attacker owns on `github.com`, a package on the npm registry, a bucket in another
  project on `*.googleapis.com`. A prompt-injected agent with an attacker's token can still
  push there. Narrowing that needs TLS interception and path rules, which this does not do.
  The allowlist bounds where data can go; it is not a guarantee that none leaves.
- **The agent can still spend through roma.** It can call the Credential Proxy, as ADR-0034
  already records, and so reach the Messages API under the Shared Window.
- **DNS is not on the agent's list.** The agent proxy hands host names to the gateway, which
  resolves them. Whether a Docker `--internal` network forwards external DNS queries depends
  on the Docker version and was not relied on; a deployment that cares should check it.
- **The metadata server is out of reach.** On a Google host it is an address on the host
  network, which an internal network cannot reach. That closes the path `infra/README.md`
  warned about, where the agent stood in roma's own identity with one `fetch`. It also means
  roma behind a gateway needs `GOOGLE_APPLICATION_CREDENTIALS` as a key file.
- Two runtime dependencies are added: `undici` (6.x, the line Node 22 bundles, for the
  dispatcher) and `https-proxy-agent`, already in the tree through gaxios.
- **Not covered:** a deployment that runs the image with `docker run` and no gateway. roma
  says so in its log, and the README says what that means.

## Considered and rejected

**Proxy variables alone.** The advisory's own warning, and correct: nothing obliges a shell
to read them.

**One allowlist for the whole container.** It would have to include roma's destinations, and
Discord, Pub/Sub and Google's token endpoint are each a way out for an agent with an
attacker's credential.

**The agent in its own container or network namespace.** The strongest separation, and the
direction ADR-0032 already names. It moves Working Directories, the Claude config dir and the
Shim socket across a container boundary. The token gives the same split without that.

**Claude Code's own sandbox.** It covers the Bash tool and not `claude` itself, and in Docker
it needs user namespaces that the default seccomp profile and `--cap-drop=ALL` refuse.

**A third-party proxy for the gateway.** Squid or tinyproxy would do the job, with their own
configuration language, image and patch cadence. The gateway is the same CONNECT proxy roma
already runs for the agent, from the same image, tested by the same fences.

**An allowlist in the gateway too.** It would have to repeat roma's destinations and every
`ROMA_EGRESS_ALLOW` entry, and drift from them. The gateway's job is to refuse everything
that is not roma; what roma lets the agent do is decided once, in roma.
