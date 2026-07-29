#!/usr/bin/env bash
#
# The two things a built image can be asked without a credential and without
# spending anything. Both workflows run this, against the same script, so the
# release cannot drift into checking less than a pull request does.
#
# roma itself cannot be booted here and deliberately is not: starting it needs a
# Shared Window token and Google credentials in a public repository's secrets,
# and the startup self-check drives a paid Turn on every run. What is checked
# instead is everything short of that — see ADR-0006.
#
#   usage: scripts/verify-image.sh <image ref>

set -euo pipefail

image="${1:?usage: scripts/verify-image.sh <image ref>}"

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

# ---------------------------------------------------------------------------
# 2. An empty environment is refused, out loud, naming both durable paths.
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
# `ROMA_CLAUDE_CONFIG_DIR` are the two paths the image refuses to guess at, so
# this is also the check that it is still refusing. `src/packaging.test.ts` reads
# the Dockerfile for the absent defaults; only this can ask a built image whether
# the refusal actually fires.
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
  'ROMA_CLAUDE_CONFIG_DIR is not set.'
do
  if ! printf '%s\n' "${refusal}" | grep -qF -- "${expected}"; then
    echo "the refusal did not contain: ${expected}" >&2
    echo "${refusal}" >&2
    exit 1
  fi
done
echo "an empty environment is refused, naming ROMA_AUDIT_ROOT and ROMA_CLAUDE_CONFIG_DIR"
