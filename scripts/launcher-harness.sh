#!/bin/sh
# Runs inside the image, as root, with nothing else running: ADR-0036's Launcher
# asked what it does, one line per check, "PASS <name>" or "FAIL <name>".
# `scripts/verify-image.sh` section 10 runs it and requires every line to pass.
# Fake data only. roma's own part — writing the roots file while root, making
# /run/roma traversable, listening on the Seat sockets — is played here by hand.

set -u

L=/usr/local/libexec/roma-launch
WORK=/var/lib/roma/work
CONFIG=/var/lib/roma/claude
SHIM=/run/roma
REPORT=/root/report
AS_NODE='setpriv --reuid=node --regid=node --clear-groups'
LEGACY=11111111-1111-4111-8111-111111111111
FIRST=22222222-2222-4222-8222-222222222222
SECOND=33333333-3333-4333-8333-333333333333
ENCLOSED=44444444-4444-4444-8444-444444444444
failures=0

check() {
  if eval "$2" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}
owner() { stat -c '%u' "$1"; }
mode() { stat -c '%a' "$1"; }
launch() { $AS_NODE "$L" "$@"; }

printf 'work %s\nconfig %s\nshim %s\n' "${WORK}" "${CONFIG}" "${SHIM}" > /run/roma-launch/roots
chmod 0644 /run/roma-launch/roots
chmod 0711 "${SHIM}" "${WORK}" "${CONFIG}"

check refuses-root '"$L" sweep; [ $? -eq 77 ]'
check refuses-a-seat 'setpriv --reuid=20003 --regid=20003 --clear-groups "$L" sweep; [ $? -ne 0 ]'
check refuses-a-bad-seat 'launch run 16 "$FIRST" -- true; [ $? -eq 64 ]'
check refuses-a-bad-session 'launch run 03 ../../etc -- true; [ $? -eq 64 ]'
check refuses-an-uppercase-session 'launch reclaim AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA; [ $? -eq 64 ]'

chmod 0666 /run/roma-launch/roots
check refuses-writable-roots 'launch sweep; [ $? -eq 77 ]'
chmod 0644 /run/roma-launch/roots

$AS_NODE node -e '
const net = require("net")
for (let i = 0; i < 16; i++) net.createServer().listen(`/run/roma/seat-${String(i).padStart(2, "0")}.sock`)
setTimeout(() => {}, 1e9)' &
sockets=$!
sleep 1
check seats 'launch seats'
check seat-socket-is-the-seats '[ "$(stat -c "%U:%G %a" "$SHIM/seat-05.sock")" = "node:roma-seat-05 660" ]'

mkdir -p "${WORK}/${LEGACY}" && echo legacy > "${WORK}/${LEGACY}/notes.txt"
chown -R node:node "${WORK}/${LEGACY}"
check sweep 'launch sweep'
check sweep-parks-legacy '[ "$(owner "$WORK/$LEGACY")" = 19999 ] && [ "$(owner "$WORK/$LEGACY/notes.txt")" = 19999 ] && [ "$(mode "$WORK/$LEGACY")" = 700 ]'
check sweep-closes-tmp-listing '[ "$(mode /tmp)" = 1733 ]'

AGENT='
echo "uid $(id -u)"; echo "groups $(id -G)"; grep NoNewPrivs /proc/self/status
echo "home $HOME"; echo "tmp $TMPDIR"; echo "config $CLAUDE_CONFIG_DIR"; echo "socket $ROMA_MINTER_SOCKET"; echo "cwd $(pwd)"
echo FAKE-SECRET > secret.txt; chmod 0644 secret.txt
echo FAKE-TMP > "$TMPDIR/tmp.txt"; echo FAKE-SHARED > "/tmp/leak-$ROMA_SESSION_ID"; chmod 0644 "/tmp/leak-$ROMA_SESSION_ID"
mkdir -p "$CLAUDE_CONFIG_DIR/projects" && echo FAKE-TRANSCRIPT > "$CLAUDE_CONFIG_DIR/projects/t.jsonl"
ln -s /etc/passwd evil
if ln /etc/shadow hard 2>/dev/null; then echo "hardlink made"; fi
setsid sleep 300 >/dev/null 2>&1 < /dev/null &
echo "orphan $!"
'
out="$(launch run 03 "${FIRST}" -- sh -c "${AGENT}" 3>"${REPORT}")"
status=$?
check run-exits-as-the-runtime '[ "$status" -eq 0 ]'
check runs-as-the-seat 'echo "$out" | grep -qx "uid 20003"'
check runs-with-no-other-group 'echo "$out" | grep -qx "groups 20003"'
check runs-with-no-new-privs 'echo "$out" | grep -Eq "^NoNewPrivs:\s+1$"'
check runs-in-the-session 'echo "$out" | grep -qx "cwd $WORK/$FIRST"'
check home-is-the-sessions 'echo "$out" | grep -qx "home $WORK/$FIRST/.home"'
check tmpdir-is-the-sessions 'echo "$out" | grep -qx "tmp $WORK/$FIRST/.tmp"'
check config-is-the-sessions 'echo "$out" | grep -qx "config $CONFIG/sessions/$FIRST"'
check socket-is-the-seats 'echo "$out" | grep -qx "socket $SHIM/seat-03.sock"'
check no-hardlink-to-root-files '! echo "$out" | grep -q "hardlink made"'
orphan="$(echo "$out" | sed -n 's/^orphan //p')"
check orphan-is-killed '! kill -0 "$orphan"'
check seat-is-empty '! grep -Eqs "^Uid:\s+20003\s" /proc/[0-9]*/status'
check shared-tmp-is-purged '[ ! -e "/tmp/leak-$FIRST" ]'
check work-is-parked '[ "$(owner "$WORK/$FIRST")" = 19999 ] && [ "$(mode "$WORK/$FIRST")" = 700 ] && [ "$(owner "$WORK/$FIRST/secret.txt")" = 19999 ]'
check transcript-is-parked '[ "$(owner "$CONFIG/sessions/$FIRST")" = 19999 ] && [ "$(owner "$CONFIG/sessions/$FIRST/projects/t.jsonl")" = 19999 ]'
check symlink-target-untouched '[ "$(owner /etc/passwd)" = 0 ] && [ -L "$WORK/$FIRST/evil" ]'
check report-says-returned 'grep -qx "returned seat 03" "$REPORT"'

check exit-code-is-the-runtimes 'launch run 03 "$SECOND" -- sh -c "exit 7"; [ $? -eq 7 ]'
$AS_NODE "$L" run 04 "${SECOND}" -- sleep 30 &
held=$!
sleep 1
$AS_NODE sh -c "kill -TERM ${held}"
wait "${held}"
termed=$?
check roma-signal-reaches-the-runtime '[ "$termed" -eq 143 ]'

REUSE='
cat '"${WORK}/${FIRST}"'/secret.txt && echo "read work"
ls '"${WORK}/${FIRST}"' && echo "listed work"
cat '"${CONFIG}/sessions/${FIRST}"'/projects/t.jsonl && echo "read transcript"
echo planted >> '"${CONFIG}/sessions/${FIRST}"'/projects/t.jsonl && echo "wrote transcript"
true
'
reuse="$(launch run 03 "${SECOND}" -- sh -c "${REUSE}" 2>/dev/null)"
check reused-seat-reads-no-work '! echo "$reuse" | grep -q "read work"'
check reused-seat-lists-no-work '! echo "$reuse" | grep -q "listed work"'
check reused-seat-reads-no-transcript '! echo "$reuse" | grep -q "read transcript"'
check reused-seat-writes-no-transcript '! echo "$reuse" | grep -q "wrote transcript"'

chmod 0700 "${CONFIG}/sessions"
resumed="$(launch run 05 "${FIRST}" -- sh -c 'cat secret.txt; cat "$CLAUDE_CONFIG_DIR/projects/t.jsonl"')"
check sessions-is-made-passable '[ "$(mode "$CONFIG/sessions")" = 711 ] && [ "$(owner "$CONFIG/sessions")" = "$(id -u node)" ]'
check resumed-session-reads-its-own 'echo "$resumed" | grep -qx FAKE-SECRET && echo "$resumed" | grep -qx FAKE-TRANSCRIPT'
check resume-leaves-symlink-target '[ "$(owner /etc/passwd)" = 0 ]'

launch run 06 "${ENCLOSED}" -- sleep 4 &
resident=$!
sleep 1
check enclose-writes-as-the-seat 'printf FAKE-ENCLOSURE | launch enclose 06 "$ENCLOSED" 55555555-5555-4555-8555-555555555555.txt && [ "$(owner "$WORK/$ENCLOSED/.enclosures/55555555-5555-4555-8555-555555555555.txt")" = 20006 ]'
check enclose-refuses-another-seats 'printf x | launch enclose 07 "$ENCLOSED" 66666666-6666-4666-8666-666666666666.txt; [ $? -ne 0 ]'
check enclose-refuses-a-path-name 'printf x | launch enclose 06 "$ENCLOSED" ../../etc/x; [ $? -eq 64 ]'
wait "${resident}"

launch run 06 "${ENCLOSED}" -- sh -c 'rm -rf .enclosures; ln -s /etc .enclosures; sleep 4' &
resident=$!
sleep 1
printf x | launch enclose 06 "${ENCLOSED}" 77777777-7777-4777-8777-777777777777.txt >/dev/null 2>&1
check enclose-follows-no-symlink '[ ! -e /etc/77777777-7777-4777-8777-777777777777.txt ]'
wait "${resident}"

launch run 07 "${SECOND}" -- sleep 4 &
resident=$!
sleep 1
check reclaim-refuses-a-resident 'launch reclaim "$SECOND"; [ $? -eq 77 ] && [ -d "$WORK/$SECOND" ]'
wait "${resident}"
check reclaim 'launch reclaim "$SECOND" && [ ! -e "$WORK/$SECOND" ]'
check reclaim-keeps-the-transcript '[ -d "$CONFIG/sessions/$SECOND" ]'

kill "${sockets}" 2>/dev/null
echo "failures ${failures}"
[ "${failures}" -eq 0 ]
