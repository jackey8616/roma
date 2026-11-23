#!/usr/bin/env bash

set -euo pipefail

image="${1:?usage: scripts/verify-image.sh <image ref>}"

minimum_caps=(--cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN --cap-add=FOWNER --cap-add=KILL --cap-add=DAC_OVERRIDE)

read_only_root=(--read-only
  --tmpfs /tmp:exec,nosuid,nodev,mode=1777 --tmpfs /var/tmp:nosuid,nodev,mode=1777
  --tmpfs /run/roma:nosuid,nodev,uid=1000,gid=1000,mode=0711 --tmpfs /run/roma-launch:nosuid,nodev,mode=0755
  --tmpfs /var/lib/roma/work:exec,nosuid,nodev,uid=1000,gid=1000,mode=0711
  -v /var/lib/roma/audit -v /var/lib/roma/claude)

label='io.github.jackey8616.roma.claude-code.version'
declared="$(docker image inspect --format "{{ index .Config.Labels \"${label}\" }}" "${image}")"

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

codex_label='io.github.jackey8616.roma.codex.version'
codex_declared="$(docker image inspect --format "{{ index .Config.Labels \"${codex_label}\" }}" "${image}")"

if [ -z "${codex_declared}" ] || [ "${codex_declared}" = '<no value>' ]; then
  echo "the image carries no ${codex_label} label" >&2
  exit 1
fi

codex_installed="$(docker run --rm --entrypoint codex "${image}" --version | awk '{ print $2 }')"

if [ "${codex_installed}" != "${codex_declared}" ]; then
  echo "the image declares Codex ${codex_declared} and contains ${codex_installed}" >&2
  exit 1
fi
echo "codex --version is ${codex_installed}, as declared"

gh_version="$(docker run --rm --entrypoint /usr/local/lib/roma/gh "${image}" --version | head -n 1)"
echo "the real gh is ${gh_version}"

shim="$(docker run --rm --entrypoint sh "${image}" -c 'command -v gh && cat "$(command -v gh)"')"
if ! printf '%s\n' "${shim}" | grep -qF -- 'gh-shim.js'; then
  echo "the gh on PATH is not roma's Credential Shim:" >&2
  echo "${shim}" >&2
  exit 1
fi
echo "the gh on PATH is roma's Credential Shim"

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

harness="$(dirname "$0")/containment-harness.mjs"
contained_flags=(--disable-sigusr1)

containment() {
  local user="$1"; shift
  docker run --rm -i ${user:+--user "${user}"} "${minimum_caps[@]}" "${read_only_root[@]}" \
    -e ROMA_OVERFLOW_API_KEY=FAKE-CANARY-ROMA-ENV \
    --entrypoint node "${image}" "$@" --input-type=module - < "${harness}"
}

contained="$(containment '' "${contained_flags[@]}")"
control="$(containment node)"

expect_line() {
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

proxy_harness="$(dirname "$0")/credential-proxy-harness.mjs"
canary_tail="$(printf 'A%.0s' $(seq 1 83))"

i2() {
  local user='' variable="CLAUDE_CODE_OAUTH_$(printf TOKEN)" prefix=sk-ant-oat01
  [ "$1" = control ] && user=node
  [ "$2" = overflow ] && variable=ROMA_OVERFLOW_API_KEY prefix=sk-ant-api03
  docker run --rm -i ${user:+--user "${user}"} "${minimum_caps[@]}" "${read_only_root[@]}" \
    -e "${variable}=${prefix}-FAKECANARY${canary_tail}" --entrypoint node "${image}" \
    --disable-sigusr1 --input-type=module - "$1" "$2" < "${proxy_harness}"
}

for kind in shared-window overflow; do
  i2_contained="$(i2 contained "${kind}")"
  i2_control="$(i2 control "${kind}")"

  for line in 'turns 2' 'turn OK' 'probe COMPLETE' 'probe-uid 20000' 'claude-uid 20000' \
    'api-auth REAL' 'transcript-written YES'; do
    expect_line "contained ${kind}" "${i2_contained}" "${line}"
  done
  for route in tool-env claude-environ claude-memory claude-fds roma-environ roma-memory transcript config-dir; do
    expect_line "contained ${kind}" "${i2_contained}" "${route} BLOCKED"
  done
  for line in 'turns 2' 'probe COMPLETE' 'claude-environ REACHED' 'roma-environ REACHED' 'transcript REACHED'; do
    expect_line "control ${kind}" "${i2_control}" "${line}"
  done
done
echo "the agent recovers no Shared Window token or Overflow key, which it does when claude holds one"

egress_harness="$(dirname "$0")/egress-harness.mjs"
egress_tag="roma-verify-$$"

egress_cleanup() {
  docker rm -f "${egress_tag}-gateway" >/dev/null 2>&1 || true
  docker network rm "${egress_tag}-inside" "${egress_tag}-outside" >/dev/null 2>&1 || true
  docker volume rm "${egress_tag}-secrets" >/dev/null 2>&1 || true
}
trap egress_cleanup EXIT

docker volume create "${egress_tag}-secrets" >/dev/null
docker run --rm -v "${egress_tag}-secrets:/secrets" --entrypoint sh "${image}" -c \
  'umask 077; od -An -tx1 -N32 /dev/urandom | tr -d " \n" > /secrets/egress.token; chmod 0400 /secrets/egress.token'

docker network create --internal "${egress_tag}-inside" >/dev/null
docker network create "${egress_tag}-outside" >/dev/null
gateway_hardening=(--read-only --cap-drop=ALL --security-opt no-new-privileges)
docker run -d --name "${egress_tag}-gateway" --network "${egress_tag}-outside" "${gateway_hardening[@]}" \
  -v "${egress_tag}-secrets:/run/secrets:ro" \
  -e ROMA_EGRESS_TOKEN_FILE=/run/secrets/egress.token \
  --entrypoint node "${image}" /app/dist/egress/gateway.js >/dev/null
docker network connect --alias egress "${egress_tag}-inside" "${egress_tag}-gateway"
gateway_status="$(docker exec "${egress_tag}-gateway" sh -c 'grep -E "^(NoNewPrivs|Seccomp|CapEff):" /proc/1/status' | tr -s '\t ' ' ')"
for line in 'NoNewPrivs: 1' 'Seccomp: 2' 'CapEff: 0000000000000000'; do
  expect_line gateway "${gateway_status}" "${line}"
done

egress() {
  local run=(--user node)
  [ "$1" = contained ] && run=(
    "${minimum_caps[@]}" "${read_only_root[@]}"
    --network "${egress_tag}-inside"
    -v "${egress_tag}-secrets:/run/secrets:ro"
    -e ROMA_EGRESS_TOKEN_FILE=/run/secrets/egress.token
    -e EGRESS_GATEWAY=http://egress:3128
  )
  docker run --rm -i "${run[@]}" \
    -e EGRESS_LISTED_REPO=https://github.com/jackey8616/roma \
    --entrypoint node "${image}" --disable-sigusr1 --input-type=module - "$1" < "${egress_harness}"
}

egress_contained="$(egress contained)"
egress_control="$(egress control)"

for line in 'turns 2' 'probe COMPLETE' 'probe-uid 20000' 'token-readable NO'; do
  expect_line contained "${egress_contained}" "${line}"
done
for check in roma-direct direct unlisted exfiltrate gateway-without-token stolen-token; do
  expect_line contained "${egress_contained}" "${check} BLOCKED"
done
for check in roma-through-gateway listed; do
  expect_line contained "${egress_contained}" "${check} REACHED"
done
expect_line contained "${egress_contained}" 'gateway-answer 407'
expect_line control "${egress_control}" 'turns 2'
expect_line control "${egress_control}" 'probe COMPLETE'
for check in roma-direct direct unlisted exfiltrate listed; do
  expect_line control "${egress_control}" "${check} REACHED"
done
echo "the agent reaches only its allowlist, through the gateway, which it does not when roma has none"

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

audit_checks=(audit-read audit-append audit-rewrite audit-new-month audit-delete audit-swap)
audit_run() {
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

hardened="$(docker run --rm "${minimum_caps[@]}" "${read_only_root[@]}" --pids-limit=512 --entrypoint sh "${image}" -c '
  awk '\''$5 == "/" { split($6, o, ","); print "root-mount " o[1] }'\'' /proc/self/mountinfo
  grep -E "^CapBnd:" /proc/self/status | tr -s "\t " " "
  grep -E "^Seccomp:" /proc/self/status | tr -s "\t " " "
  echo "pids-max $(cat /sys/fs/cgroup/pids.max)"
  for d in /tmp /var/tmp /run/roma /run/roma-launch /var/lib/roma/work; do
    awk -v d="$d" '\''$5 == d { print "tmpfs " d " " $6 }'\'' /proc/self/mountinfo
  done
  touch /run/roma-launch/.probe && rm /run/roma-launch/.probe && echo "root-writable /run/roma-launch"
  find / -xdev -type f -perm /6000 -printf "privileged %m %u:%g %p\n"
  setpriv --reuid=node --regid=node --clear-groups sh -c "
    touch /home/node/.probe 2>&1 | grep -q \"Read-only file system\" && echo \"home EROFS\"
    for d in /tmp /var/tmp /var/lib/roma/work /run/roma /var/lib/roma/audit /var/lib/roma/claude; do
      touch \"\$d/.probe\" && rm \"\$d/.probe\" && echo \"writable \$d\"
    done
    for d in /tmp /var/lib/roma/work; do
      printf \"#!/bin/sh\\necho ran\\n\" > \"\$d/.exec\" && chmod 0755 \"\$d/.exec\" &&
        [ \"\$(\"\$d/.exec\")\" = ran ] && echo \"executable \$d\"; rm -f \"\$d/.exec\"
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
for d in /tmp /var/tmp /var/lib/roma/work /run/roma /var/lib/roma/audit /var/lib/roma/claude; do
  expect_line hardened "${hardened}" "writable ${d}"
done
for d in /tmp /var/lib/roma/work; do
  expect_line hardened "${hardened}" "executable ${d}"
done
expect_line hardened "${hardened}" 'root-writable /run/roma-launch'
expect_line hardened "${hardened}" 'Seccomp: 2'
expect_line hardened "${hardened}" 'pids-max 512'
for d in /tmp /var/tmp /run/roma /run/roma-launch /var/lib/roma/work; do
  if ! printf '%s\n' "${hardened}" | grep -E "^tmpfs ${d} " | grep -q 'nosuid' ||
    ! printf '%s\n' "${hardened}" | grep -E "^tmpfs ${d} " | grep -q 'nodev'; then
    echo "the documented run mounts ${d} without nosuid and nodev:" >&2
    echo "${hardened}" >&2
    exit 1
  fi
done
echo "the documented run has a read-only root, six capabilities, and no setuid file but the Launcher"
