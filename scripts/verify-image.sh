#!/usr/bin/env bash
#
# The things a built image can be asked without a credential and without
# spending anything. Both workflows run this, against the same script, so the
# release cannot drift into checking less than a pull request does.
#
# roma itself cannot be booted here and deliberately is not: starting it needs a
# Shared Window token and Google credentials in a public repository's secrets,
# and the startup self-check drives a paid Turn on every run. What is checked
# instead is everything short of that — see ADR-0007.
#
#   usage: scripts/verify-image.sh <image ref>

set -euo pipefail

image="${1:?usage: scripts/verify-image.sh <image ref>}"

# The capabilities README.md tells an Operator on --cap-drop=ALL to add back.
# §5, §6, §9, §10 and §11 run on exactly these, so a list one short fails here first.
minimum_caps=(--cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN --cap-add=FOWNER --cap-add=KILL --cap-add=DAC_OVERRIDE)

# The read-only root README.md runs roma on, with tmpfs at exactly the paths roma
# and the Launcher write (ADR-0038). The two anonymous volumes stand in for the
# Operator's durable audit and Claude config volumes. §5, §6, §9, §10, §11 and
# §12 run on it, so a path roma starts writing that is missing here fails first.
read_only_root=(--read-only
  --tmpfs /tmp:exec,mode=1777 --tmpfs /var/tmp:mode=1777
  --tmpfs /run/roma:uid=1000,gid=1000,mode=0711 --tmpfs /run/roma-launch:mode=0755
  --tmpfs /var/lib/roma/work:exec,uid=1000,gid=1000,mode=0711
  -v /var/lib/roma/audit -v /var/lib/roma/claude)

# ---------------------------------------------------------------------------
# 1. The Claude Code in the image is the one the image says it carries.
#
# The only check that catches the install layer silently breaking, or the pin
# drifting. Read from the label rather than from a literal here, because the
# literal lives in `src/packaging.test.ts` where the reason for it is written
# down; this asks the narrower question the free run cannot — whether what the
# Dockerfile declared is what actually got installed.
# ---------------------------------------------------------------------------
label='io.github.jackey8616.roma.claude-code.version'
declared="$(docker image inspect --format "{{ index .Config.Labels \"${label}\" }}" "${image}")"

# Before the container is started, so that a missing label is reported as a
# missing label. Go templates render an absent key as the string `<no value>`
# rather than as nothing, which is why emptiness alone is not the test.
if [ -z "${declared}" ] || [ "${declared}" = '<no value>' ]; then
  echo "the image carries no ${label} label" >&2
  exit 1
fi

installed="$(docker run --rm --entrypoint claude "${image}" --version | awk '{ print $1 }')"

if [ "${installed}" != "${declared}" ]; then
  echo "the image declares Claude Code ${declared} and contains ${installed}" >&2
  exit 1
fi
echo "claude --version is ${installed}, as declared"

# The same question for the second Runtime's pin (ADR-0026 *The pins*). The
# Dockerfile's own `codex --version` proves the binary runs, not which build it
# is; this is what proves the label and the binary agree.
codex_label='io.github.jackey8616.roma.codex.version'
codex_declared="$(docker image inspect --format "{{ index .Config.Labels \"${codex_label}\" }}" "${image}")"

if [ -z "${codex_declared}" ] || [ "${codex_declared}" = '<no value>' ]; then
  echo "the image carries no ${codex_label} label" >&2
  exit 1
fi

# `codex --version` prints `codex-cli 0.165.0`; the version is the second word.
codex_installed="$(docker run --rm --entrypoint codex "${image}" --version | awk '{ print $2 }')"

if [ "${codex_installed}" != "${codex_declared}" ]; then
  echo "the image declares Codex ${codex_declared} and contains ${codex_installed}" >&2
  exit 1
fi
echo "codex --version is ${codex_installed}, as declared"

# ---------------------------------------------------------------------------
# 2. `gh` is in the image, and the Credential Shim is what answers to the name.
#
# Two questions, and the second is the one worth asking here. The real binary
# lives off PATH at a fixed path; what `gh` resolves to is the Shim, which mints
# per invocation (ADR-0008). An image that installed `gh` normally would pass a
# version check perfectly and hand the agent a tool with no credential — or worse,
# one running on whatever token happened to be in the environment.
#
# `--version` on the Shim is deliberately not what is asked: it would try to
# reach roma's socket, which is not running in a bare `docker run`.
# ---------------------------------------------------------------------------
gh_version="$(docker run --rm --entrypoint /usr/local/lib/roma/gh "${image}" --version | head -n 1)"
echo "the real gh is ${gh_version}"

shim="$(docker run --rm --entrypoint sh "${image}" -c 'command -v gh && cat "$(command -v gh)"')"
if ! printf '%s\n' "${shim}" | grep -qF -- 'gh-shim.js'; then
  echo "the gh on PATH is not roma's Credential Shim:" >&2
  echo "${shim}" >&2
  exit 1
fi
echo "the gh on PATH is roma's Credential Shim"

# ---------------------------------------------------------------------------
# 3. The `gh` in the image is built for the architecture the image claims to be.
#
# The Dockerfile fetches one tarball and checks it against one hardcoded sha256,
# on the grounds that only one architecture is built (ADR-0008). Nothing in the
# Dockerfile enforces that: the workflows pin `platforms: linux/amd64`, and a bare
# `docker build` on a developer's machine pins nothing — so on Apple Silicon it
# produces an **arm64 image carrying the amd64 `gh`**, which then runs only
# because Docker Desktop emulates it. Measured, on exactly that machine: the
# version check above passed while `e_machine` said x86-64.
#
# That image would fail on a real arm64 host with "exec format error", and it is
# not the image that ships — which is the whole reason to build one locally. So
# the coherence is asserted rather than the platform: whichever architecture the
# image is, the binary in it has to match. `--version` succeeding is not that
# check, as this very build proved.
#
# `e_machine`, two bytes at offset 18 of the ELF header, is the only place the
# answer is not somebody's label.
# ---------------------------------------------------------------------------
declared_arch="$(docker image inspect --format '{{ .Architecture }}' "${image}")"
machine="$(docker run --rm --entrypoint sh "${image}" \
  -c 'od -An -tx1 -j18 -N2 /usr/local/lib/roma/gh' | tr -d ' \n')"

case "${machine}" in
  '3e00') gh_arch='amd64' ;;
  'b700') gh_arch='arm64' ;;
  *) gh_arch="unrecognised (e_machine=${machine})" ;;
esac

if [ "${declared_arch}" != "${gh_arch}" ]; then
  echo "the image says it is ${declared_arch} and its gh is ${gh_arch}" >&2
  echo "build it for one architecture: docker build --platform linux/amd64 ..." >&2
  exit 1
fi
echo "the image and its gh are both ${declared_arch}"

# ---------------------------------------------------------------------------
# 4. An empty environment is refused, out loud, naming what it cannot guess.
#
# This proves more than it looks. Node runs; `dist/` is complete; ESM resolution
# works; both runtime dependencies import, since they are top-level static
# imports and load before `main()`; and the CMD path is right.
#
# Asserted on the message and not only on the exit code, because `node` exits 1
# for a missing module too — an image with a broken `dist/` or a missing
# dependency passes an exit-code-only check perfectly.
#
# No `--env` and no volumes, which is the point: `ROMA_AUDIT_ROOT` and
# `ROMA_CLAUDE_CONFIG_DIR` are the two paths the image refuses to guess at, and
# the GitHub App is the credential it refuses to start without, so this is also
# the check that it is still refusing. `src/packaging.test.ts` reads the
# Dockerfile for the absent defaults; only this can ask a built image whether the
# refusal actually fires.
#
# `ROMA_SHIM_DIR` is deliberately **not** in the list below: it is defaulted in
# the image, so an empty environment must *not* complain about it. If it ever
# appears here, the default has been lost.
# ---------------------------------------------------------------------------
status=0
refusal="$(docker run --rm "${image}" 2>&1)" || status=$?

if [ "${status}" -ne 1 ]; then
  echo "an empty environment exited ${status}, expected 1:" >&2
  echo "${refusal}" >&2
  exit 1
fi

for expected in \
  'roma refused to start — its configuration is incomplete.' \
  'ROMA_AUDIT_ROOT is not set.' \
  'ROMA_CLAUDE_CONFIG_DIR is not set.' \
  'ROMA_GITHUB_APP_ID is not set.' \
  'ROMA_GITHUB_PRIVATE_KEY_FILE is not set.'
do
  if ! printf '%s\n' "${refusal}" | grep -qF -- "${expected}"; then
    echo "the refusal did not contain: ${expected}" >&2
    echo "${refusal}" >&2
    exit 1
  fi
done
if printf '%s\n' "${refusal}" | grep -qF -- 'ROMA_SHIM_DIR'; then
  echo "the refusal named ROMA_SHIM_DIR, which the image is supposed to default" >&2
  echo "${refusal}" >&2
  exit 1
fi
echo "an empty environment is refused, naming the durable paths and the GitHub App"

# ---------------------------------------------------------------------------
# 5. The agent cannot reach roma's keys: not on disk, not in roma's environment,
#    not in roma's memory, and not through an inspector it signals open.
#
# GHSA-v52v-hcv8-cr23, ADR-0032. The agent runs as roma's uid, so the boundary
# is roma starting as root, reading the keys, and dropping to `node` — after
# which the key file is root's and the kernel has marked roma not dumpable. This
# is the only place that can be proved: it takes the image's real CMD flags, its
# real compiled `dropRoot`, `buildEnv` and `spawnRuntimeProcess`, a real kernel,
# and the agent spawned as roma's real child. `scripts/containment-harness.mjs`
# is roma's half; the probe it spawns is the agent's.
#
# Run twice, and the second run is what makes the first one mean anything. The
# control starts roma the way the image did before the fix — as `node`, with
# SIGUSR1 live — and must reach the key file, the environment and the inspector.
# Without it, a probe that silently stopped working would report containment it
# is not checking. Memory is asserted only in the contained run: whether the
# control reaches it depends on the host's Yama ptrace_scope, which CI's kernel
# decides and this script does not.
# ---------------------------------------------------------------------------
harness="$(dirname "$0")/containment-harness.mjs"
contained_flags=(--disable-sigusr1)

containment() {
  # $1: the `docker run` user, or empty for the image's own. $2...: node flags.
  local user="$1"; shift
  docker run --rm -i ${user:+--user "${user}"} "${minimum_caps[@]}" "${read_only_root[@]}" \
    -e ROMA_OVERFLOW_API_KEY=FAKE-CANARY-ROMA-ENV \
    --entrypoint node "${image}" "$@" --input-type=module - < "${harness}"
}

contained="$(containment '' "${contained_flags[@]}")"
control="$(containment node)"

expect_line() {
  # $1: run name, $2: output, $3: the line it must contain.
  if ! printf '%s\n' "$2" | grep -qx -- "$3"; then
    echo "the $1 run did not report: $3" >&2
    echo "$2" >&2
    exit 1
  fi
}

expect_line contained "${contained}" 'uid 1000'
for check in key-file roma-environ roma-memory roma-inspector; do
  expect_line contained "${contained}" "${check} BLOCKED"
done
for check in key-file roma-environ roma-inspector; do
  expect_line control "${control}" "${check} REACHED"
done
echo "the agent reaches none of roma's keys, which it does when roma is started as node"

# ---------------------------------------------------------------------------
# 6. The agent cannot recover the Shared Window token: not from its own
#    environment, not from `claude`'s environment, memory or files, not from
#    roma, and not by printing it into the Transcript.
#
# GHSA-wqj9-8qq4-w466, ADR-0034. Claude Code strips the token from the Bash
# tool's environment, but the tool shares `claude`'s uid and reads
# `/proc/<claude>/environ` — so the token must never be in `claude` at all. roma
# holds it behind its credential proxy and hands `claude` a stand-in.
#
# Run against the image's real pinned `claude`, roma's real compiled
# `CredentialProxy`, `buildEnv` and `dropRoot`, and a fake Messages API, so it
# needs no credential and spends nothing. `api-auth REAL` is the half that says
# the contained run still works: the fake API was sent the real token.
#
# The control runs `claude` with the token in its environment, as roma did
# before the fix, and must reach it — otherwise a probe that silently stopped
# working would report containment it is not checking. Memory is asserted only
# in the contained run, for the Yama reason section 5 gives.
# ---------------------------------------------------------------------------
proxy_harness="$(dirname "$0")/credential-proxy-harness.mjs"

i2() {
  # $1: mode. The contained run starts as the image's own user, root, as roma does.
  local user=''
  [ "$1" = control ] && user=node
  docker run --rm -i ${user:+--user "${user}"} "${minimum_caps[@]}" "${read_only_root[@]}" --entrypoint node "${image}" \
    --disable-sigusr1 --input-type=module - "$1" < "${proxy_harness}"
}

i2_contained="$(i2 contained)"
i2_control="$(i2 control)"

expect_line contained "${i2_contained}" 'turns 2'
expect_line contained "${i2_contained}" 'api-auth REAL'
expect_line contained "${i2_contained}" 'transcript-written YES'
for route in tool-env claude-environ claude-memory claude-fds roma-environ roma-memory transcript config-dir; do
  expect_line contained "${i2_contained}" "${route} BLOCKED"
done
expect_line control "${i2_control}" 'turns 2'
for route in claude-environ transcript; do
  expect_line control "${i2_control}" "${route} REACHED"
done
echo "the agent recovers no Shared Window token, which it does when claude holds one"

# ---------------------------------------------------------------------------
# 7. The agent reaches only what its allowlist names, and only through roma's
#    egress gateway; roma's own traffic still gets out.
#
# GHSA-7hpq-f638-956r, ADR-0035. Proxy variables alone constrain nothing — the
# agent has a shell and `curl --noproxy '*'` — so the contained run puts the
# container on a Docker network created with `--internal`, whose only way out is
# the gateway, started here from this same image as compose.yaml starts it. The
# gateway refuses whoever lacks its token; roma's in-process proxy forwards the
# agent's CONNECTs to it, and only for hosts on the agent's allowlist.
#
# Run against the image's real pinned `claude` and a fake Messages API, so it
# spends nothing. It does need the internet: `listed REACHED` is a real
# `git ls-remote` to this repository, which is the half that says the contained
# run still works. `roma-through-gateway REACHED` is the same for roma's own
# `fetch`.
#
# The control runs on Docker's default network with no gateway, as roma did
# before the fix, and must get out directly — otherwise a probe that silently
# stopped working would report containment it is not checking.
# ---------------------------------------------------------------------------
egress_harness="$(dirname "$0")/egress-harness.mjs"
egress_tag="roma-verify-$$"
egress_dir="$(mktemp -d)"

egress_cleanup() {
  docker rm -f "${egress_tag}-gateway" >/dev/null 2>&1 || true
  docker network rm "${egress_tag}-inside" "${egress_tag}-outside" >/dev/null 2>&1 || true
  rm -rf "${egress_dir}"
}
trap egress_cleanup EXIT

od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "${egress_dir}/egress.token"
chmod 0644 "${egress_dir}/egress.token"

docker network create --internal "${egress_tag}-inside" >/dev/null
docker network create "${egress_tag}-outside" >/dev/null
# As compose.yaml runs it: root, with no capability, no-new-privileges and a
# read-only root (ADR-0038).
gateway_hardening=(--read-only --cap-drop=ALL --security-opt no-new-privileges)
docker run -d --name "${egress_tag}-gateway" --network "${egress_tag}-outside" "${gateway_hardening[@]}" \
  -v "${egress_dir}/egress.token:/run/secrets/egress.token:ro" \
  -e ROMA_EGRESS_TOKEN_FILE=/run/secrets/egress.token \
  --entrypoint node "${image}" /app/dist/egress/gateway.js >/dev/null
docker network connect --alias egress "${egress_tag}-inside" "${egress_tag}-gateway"

egress() {
  # $1: mode.
  local network=()
  [ "$1" = contained ] && network=(
    --network "${egress_tag}-inside"
    -v "${egress_dir}/egress.token:/run/secrets/egress.token:ro"
    -e ROMA_EGRESS_TOKEN_FILE=/run/secrets/egress.token
    -e EGRESS_GATEWAY=http://egress:3128
  )
  docker run --rm -i --user node ${network[@]+"${network[@]}"} \
    -e EGRESS_LISTED_REPO=https://github.com/jackey8616/roma \
    --entrypoint node "${image}" --input-type=module - "$1" < "${egress_harness}"
}

egress_contained="$(egress contained)"
egress_control="$(egress control)"

expect_line contained "${egress_contained}" 'turns 2'
for check in roma-direct direct unlisted exfiltrate gateway-without-token; do
  expect_line contained "${egress_contained}" "${check} BLOCKED"
done
for check in roma-through-gateway listed; do
  expect_line contained "${egress_contained}" "${check} REACHED"
done
expect_line contained "${egress_contained}" 'gateway-answer 407'
expect_line control "${egress_control}" 'turns 2'
for check in roma-direct direct unlisted exfiltrate listed; do
  expect_line control "${egress_control}" "${check} REACHED"
done
echo "the agent reaches only its allowlist, through the gateway, which it does not when roma has none"

# ---------------------------------------------------------------------------
# 8. compose.yaml hands roma every Channel and Reach it can be configured with,
#    and the key files behind them, and names a release.
#
# ADR-0035 makes compose.yaml the deployment that has the gateway, so a variable
# it drops is a deployment that cannot use the gateway and that feature at once:
# a Discord-only roma with no Channel, a Chat key path with no file behind it.
# Rendered with `docker compose config`, so the interpolation itself is checked,
# and with `--env-file /dev/null`, so a `.env` beside it is never read.
#
# Each key file is given as a host path and must arrive as a mount at the path
# roma is told; unset, roma must be told nothing. Without ROMA_VERSION it must
# refuse, since releases publish no `latest` (ADR-0006).
# ---------------------------------------------------------------------------
compose_file="$(dirname "$0")/../compose.yaml"
compose() {
  env -i PATH="${PATH}" HOME="${HOME}" DOCKER_HOST="${DOCKER_HOST:-}" \
    ROMA_GITHUB_APP_ID=1 "$@" \
    docker compose -f "${compose_file}" --env-file /dev/null config --format json
}

if compose >/dev/null 2>&1; then
  echo "compose.yaml renders with no ROMA_VERSION, so it pulls a tag no release publishes" >&2
  exit 1
fi

compose_check='
let text = ""
for await (const chunk of process.stdin) text += chunk
const roma = JSON.parse(text).services.roma
const [mode, ...expected] = process.argv.slice(1)
const mounts = new Map(roma.volumes.filter((v) => v.type === "bind").map((v) => [v.target, v.source]))
for (const pair of expected) {
  const [name, value] = pair.split("=")
  const given = roma.environment[name]
  if (given === undefined) console.log(`${name} not passed`)
  else if (mode === "files" && value !== "") {
    if (given === "" || mounts.get(given) !== value) console.log(`${name} not mounted from ${value}`)
  } else if (given !== value) console.log(`${name}=${given}, expected ${value}`)
}
console.log("checked")
'
compose_run() {
  docker run --rm -i --entrypoint node "${image}" --input-type=module -e "${compose_check}" "$@"
}
compose_expect() {
  # $1: run name, $2: output.
  if [ "$2" != checked ]; then
    echo "compose.yaml, $1:" >&2
    echo "$2" >&2
    exit 1
  fi
}

compose_vars=(
  ROMA_PUBSUB_PROJECT_ID=project ROMA_PUBSUB_SUBSCRIPTION=subscription
  ROMA_DISCORD_BOT_TOKEN=bot ROMA_DISCORD_GATEWAY_URL=wss://gateway.example
  ROMA_DISCORD_API_BASE=https://api.example ROMA_DOCUMENT_DEPOT=depot
)
compose_files=(
  GOOGLE_APPLICATION_CREDENTIALS=/srv/roma/google.json
  ROMA_CLOUD_KEY_FILE=/srv/roma/cloud.json
  ROMA_DOCUMENT_KEY_FILE=/srv/roma/document.json
)
compose_unset=()
for pair in "${compose_vars[@]}" "${compose_files[@]}"; do compose_unset+=("${pair%%=*}="); done

compose_expect 'every variable set' \
  "$(compose ROMA_VERSION=0.1.0 "${compose_vars[@]}" "${compose_files[@]}" | compose_run values "${compose_vars[@]}")"
compose_expect 'every key file set' \
  "$(compose ROMA_VERSION=0.1.0 "${compose_files[@]}" | compose_run files "${compose_files[@]}")"
compose_expect 'nothing optional set' \
  "$(compose ROMA_VERSION=0.1.0 | compose_run values "${compose_unset[@]}")"
echo "compose.yaml passes every Channel and Reach, mounts their keys, and names a release"

# ---------------------------------------------------------------------------
# 9. One Session's agent reaches nothing of another Session's.
#
# GHSA-mqhq-64x8-xj73 and GHSA-4vw6-r2rj-xcqf, ADR-0036. Session B plants a
# Working Directory file, an Enclosure written by roma's real `writeEnclosures`,
# a stand-in Transcript (0600, as Claude Code writes one) and a file in its
# TMPDIR, then waits. Session A, spawned through the same compiled spawn path,
# tries to read and write all of it, read B's environment, signal B, and ask the
# Credential Shim for a credential as B. Every one must be BLOCKED.
#
# B runs the same probe against its own data first, as the control: every check
# must be REACHED there, or a probe that silently stopped working would report
# isolation it is not checking. `scripts/isolation-harness.mjs` is roma's half.
# ---------------------------------------------------------------------------
isolation_checks=(
  work-dir-read enclosure-read transcript-read tmp-read
  work-dir-write transcript-write environ-read signal shim-claim
)
isolation="$(docker run --rm -i --network none "${minimum_caps[@]}" "${read_only_root[@]}" \
  --entrypoint node "${image}" --disable-sigusr1 --input-type=module - \
  < "$(dirname "$0")/isolation-harness.mjs")"

for check in "${isolation_checks[@]}"; do
  expect_line control "${isolation}" "control ${check} REACHED"
  expect_line isolated "${isolation}" "a ${check} BLOCKED"
done
echo "one Session's agent reaches nothing of another's, which its own agent does"

# ---------------------------------------------------------------------------
# 10. The Launcher does what ADR-0036 says, and nothing an agent can turn.
#
# `scripts/launcher-harness.sh` runs in the image as root, plays roma's part by
# hand, and asks the real setuid binary: who it refuses, what a Runtime runs as,
# that a Seat is emptied — orphans killed, shared /tmp purged, files parked —
# before it is reused, that a symlink in a Session's tree reaches nothing of
# root's, and that Enclosures and the reclaim stay inside the Session. Every
# line must be PASS.
# ---------------------------------------------------------------------------
launcher="$(docker run --rm -i --network none "${minimum_caps[@]}" "${read_only_root[@]}" --entrypoint sh "${image}" -s \
  < "$(dirname "$0")/launcher-harness.sh" 2>&1)" || {
  echo "the Launcher harness failed:" >&2
  echo "${launcher}" >&2
  exit 1
}
expect_line launcher "${launcher}" 'failures 0'
if printf '%s\n' "${launcher}" | grep -q '^FAIL '; then
  echo "${launcher}" >&2
  exit 1
fi
echo "the Launcher refuses everyone but roma and empties a Seat before it is reused"

# ---------------------------------------------------------------------------
# 11. No Seat can read, change or swap the Audit Records.
#
# GHSA-g6x2-mcq8-3hm3, ADR-0037. Every agent is a Seat and the records are
# roma's, so roma seals the audit root 0700 after the drop and refuses a path a
# Seat could rename away. The harness starts from a volume an earlier image left
# 0755, seals it with roma's real compiled `sealAudit`, and has a Seat, spawned
# through the real Launcher, try to read, append, rewrite, add a month, delete and
# rename the directory or any above it. The month must read back exactly what
# roma wrote. The same probe run as roma, against a ledger of its own, must reach
# every one, or the probe is checking nothing. A second run puts the records
# under a directory every Seat can write: roma must refuse to start.
# ---------------------------------------------------------------------------
audit_checks=(audit-read audit-append audit-rewrite audit-new-month audit-delete audit-swap)
audit_run() {
  # /srv is a tmpfs so that `exposed` can make /srv/shared a plain directory, not a mount.
  docker run --rm -i --network none "${minimum_caps[@]}" "${read_only_root[@]}" --tmpfs /srv \
    --entrypoint node "${image}" --disable-sigusr1 --input-type=module - "$@" \
    < "$(dirname "$0")/audit-harness.mjs"
}
audit_sealed="$(audit_run old-volume)"
audit_exposed="$(audit_run exposed)"

expect_line sealed "${audit_sealed}" 'audit tightened true'
expect_line sealed "${audit_sealed}" 'seat uid 20000'
for check in "${audit_checks[@]}"; do
  expect_line control "${audit_sealed}" "control ${check} REACHED"
  expect_line sealed "${audit_sealed}" "seat ${check} BLOCKED"
done
expect_line sealed "${audit_sealed}" 'ledger intact'
expect_line exposed "${audit_exposed}" 'audit refused'
echo "no Seat reaches the Audit Records, which roma itself does"

# ---------------------------------------------------------------------------
# 12. The documented run is hardened, and the image has nothing left to climb.
#
# GHSA-g6cx-6wcm-4hqw, ADR-0038. On the README's flags the root filesystem is
# read-only, the bounding set is exactly the six capabilities the Launcher needs,
# and the Launcher is the only setuid or setgid file in the image. As node, the
# image's home is refused with EROFS rather than by a permission, which is what
# says the read-only root is doing it, and every path roma writes still takes a
# write. Container-wide no-new-privileges is deliberately absent: the Launcher is
# setuid and would be voided; it sets no_new_privs on every Runtime instead,
# which §10's runs-with-no-new-privs proves.
# ---------------------------------------------------------------------------
hardened="$(docker run --rm "${minimum_caps[@]}" "${read_only_root[@]}" --entrypoint sh "${image}" -c '
  awk '\''$5 == "/" { split($6, o, ","); print "root-mount " o[1] }'\'' /proc/self/mountinfo
  grep -E "^CapBnd:" /proc/self/status | tr -s "\t " " "
  find / -xdev -type f -perm /6000 -printf "privileged %m %u:%g %p\n"
  setpriv --reuid=node --regid=node --clear-groups sh -c "
    touch /home/node/.probe 2>&1 | grep -q \"Read-only file system\" && echo \"home EROFS\"
    for d in /tmp /var/lib/roma/work /run/roma /var/lib/roma/audit /var/lib/roma/claude; do
      touch \"\$d/.probe\" && rm \"\$d/.probe\" && echo \"writable \$d\"
    done"
' 2>&1)"

expect_line hardened "${hardened}" 'root-mount ro'
expect_line hardened "${hardened}" 'CapBnd: 00000000000000eb'
expect_line hardened "${hardened}" 'privileged 4750 root:node /usr/local/libexec/roma-launch'
if [ "$(printf '%s\n' "${hardened}" | grep -c '^privileged ')" -ne 1 ]; then
  echo "the image carries setuid or setgid files besides the Launcher:" >&2
  echo "${hardened}" >&2
  exit 1
fi
expect_line hardened "${hardened}" 'home EROFS'
for d in /tmp /var/lib/roma/work /run/roma /var/lib/roma/audit /var/lib/roma/claude; do
  expect_line hardened "${hardened}" "writable ${d}"
done
echo "the documented run has a read-only root, six capabilities, and no setuid file but the Launcher"
