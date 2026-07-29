#!/usr/bin/env bash
#
# Has the Claude Code this repository pins fallen behind the latest published one?
#
# Notify-only, and that is the decision rather than a limitation. ADR-0006 holds
# that moving this pin is a re-verification event a human does on purpose: it
# spends Shared Window money and every measurement in `docs/` is evidence about
# the pinned version until somebody re-takes it. A bump pull request would look
# like routine maintenance while doing exactly that, and the check on it would go
# green, because seam 2 does not run in CI. So this reports a fact and asks a
# human to decide. It never edits the pin.
#
# It reports by writing a Markdown report. Filing that report as an issue is the
# workflow's job, not this script's — which is what lets everything below be a
# question about this repository, asked without GitHub, in
# `src/claude-code-drift.test.ts`.
#
#   usage: scripts/claude-code-drift.sh <report path>   (from the repository root)
#
#   exit 0  the pin is the latest published version. Nothing written, nothing said.
#   exit 2  they differ. The report is at <report path>, its title on stdout.
#   exit 1  the comparison could not be made.
#
# The failure this most plausibly dies of is its own silence. A 404, a network
# blip, an `ARG` line somebody reformatted: handled carelessly, any of them
# produce a check that passes forever while watching nothing — and a green tick
# on this workflow reads as "the pin is current". So every one of them exits
# non-zero, and only a successful comparison is allowed to be quiet.
#
# 2 rather than 1 for the drift case, because `set -e` turns any unexpectedly
# failing command into an exit 1. Drift is the one verdict that must not be
# reachable by accident.

set -euo pipefail

report="${1:?usage: scripts/claude-code-drift.sh <report path>   (from the repository root)}"

package='@anthropic-ai/claude-code'

# An exact version and nothing else. A range, a dist-tag or an empty value all
# resolve to something on the day somebody looks and to something else later,
# which is the whole failure the pin exists to stop — so any of them is a
# comparison this script cannot make, and it says so rather than guessing.
#
# Matched with `[[ =~ ]]` rather than `grep -E`, and that is the point of it
# rather than a preference: `grep` answers for any *line*, so a `npm warn …`
# ahead of the number is a value that passes the check and then flows into the
# title, the marker and the workflow's output as two lines. `[[ =~ ]]` anchors
# to the whole string, so the warning is what it is — an answer this script
# cannot read.
exact='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

# ---------------------------------------------------------------------------
# 1. The pin, read from the Dockerfile.
#
# Read rather than restated. `src/packaging.test.ts` already carries the second
# copy that turns editing the Dockerfile alone red, and that pair is the whole
# mechanism; a third copy here would be a drift check that itself drifts, which
# is worth less than nothing.
# ---------------------------------------------------------------------------
if [ ! -f Dockerfile ]; then
  echo 'no Dockerfile here — run this from the repository root' >&2
  exit 1
fi

# The first assignment only. The Dockerfile names this `ARG` twice, and the
# second one — the redeclaration that carries it into the runtime stage — has no
# value at all.
pinned="$(awk -F= '/^ARG CLAUDE_CODE_VERSION=/ { print $2; exit }' Dockerfile)"

if ! [[ "${pinned}" =~ ${exact} ]]; then
  echo "the Dockerfile's ARG CLAUDE_CODE_VERSION is not an exact version: '${pinned}'" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. The latest published version, from the registry.
# ---------------------------------------------------------------------------
if ! latest="$(npm view "${package}" version | tr -d '\r')"; then
  echo "could not ask the registry for the latest ${package}" >&2
  exit 1
fi

# npm exits 0 having printed nothing often enough to be worth its own branch, and
# the shape is checked as well as the emptiness: a warning or an error string
# compared against the pin would report drift on every run forever.
if ! [[ "${latest}" =~ ${exact} ]]; then
  echo "the registry did not answer with a version: '${latest}'" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. The comparison, which is the only outcome allowed to be quiet.
# ---------------------------------------------------------------------------
if [ "${pinned}" = "${latest}" ]; then
  echo "${package} is at ${latest}, which is what this repository pins" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. What re-verification would cost, generated rather than guessed at.
#
# `git grep` rather than `grep -r`, so the list is this repository's tracked
# files and not whatever `node_modules/`, `dist/` and local scratch happen to
# contain on the machine the check ran on.
#
# Zero matches is a failure and not an empty list: the Dockerfile the pin was
# just read out of is itself a match, so finding none means the search did not
# work.
# ---------------------------------------------------------------------------
status=0
evidence="$(git grep --files-with-matches --fixed-strings -e "${pinned}")" || status=$?

if [ "${status}" -ne 0 ] || [ -z "${evidence}" ]; then
  echo "could not list what mentions ${pinned}: git grep exited ${status}" >&2
  exit 1
fi

evidence_list="$(printf '%s\n' "${evidence}" | sed 's/.*/- `&`/')"

# ---------------------------------------------------------------------------
# 5. The report.
#
# Written to say what it costs in the same breath as what is available. A report
# that only said "2.1.221 is out" would invite exactly the reflex the pin exists
# to stop.
#
# The one thing deliberately not spelled out is the command that runs seam 2:
# `src/packaging.test.ts` fails if that script name appears anywhere in
# `.github/workflows/` or `scripts/`, and that guard is worth more than the
# convenience of pasting it. CLAUDE.md has it, and the reader is a human who is
# about to spend money on purpose.
# ---------------------------------------------------------------------------
cat > "${report}" <<EOF
\`${package}@${latest}\` is published. This repository pins ${pinned}, and the
image carries that one.

**Nothing is broken.** ${pinned} behaves exactly as it did yesterday and every
measurement in \`docs/\` is still true of it. This report exists so that moving
the pin is something somebody decides rather than something nobody notices —
and declining it is as ordinary an outcome as acting on it.

## What moving the pin costs

ADR-0006 holds that upgrading Claude Code here is a re-verification event, not a
dependency bump. Every measurement in this repository is evidence about ${pinned}
and nothing else, so moving the pin means re-running seam 2 — which drives a real
\`claude -p\` against the Shared Window, the personal subscription everybody's
Turns share (ADR-0002), and spends real money on every run. CI cannot do that,
and deliberately does not: nothing it runs is handed a Shared Window token.

## What carries evidence about ${pinned}

${evidence_list}

Generated by searching this repository's tracked files for ${pinned}, so it stays
true as the repository moves. It is the size of the re-verification rather than a
checklist — some of those files mention the version in passing, and some are
captures that would have to be retaken against ${latest}.

## If the pin does move

The number lives in two places on purpose: \`Dockerfile\`'s
\`ARG CLAUDE_CODE_VERSION\`, and a literal in \`src/packaging.test.ts\` that is
where the reason is written down. Editing one alone turns the free run red.

---

Filed by \`.github/workflows/claude-code-drift.yml\`, which reads the pin and
reports on it. It does not edit the pin and it opens no pull request. While this
report is open, later runs edit it in place rather than filing another; closing
it is how ${latest} gets declined, and nothing will re-file it for that version.

<!-- claude-code-drift latest=${latest} -->
EOF

printf 'Claude Code %s is published; this repository pins %s\n' "${latest}" "${pinned}"
exit 2
