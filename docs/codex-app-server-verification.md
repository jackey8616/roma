# Verification: a `codex app-server` handshake, and the schema the harness is written against

Date: 2026-10-29
Codex **0.165.0** (`codex-cli 0.165.0`, `darwin-arm64`, homebrew cask). Behaviour is
version-specific.

The prefactor for ADR-0026's verification agenda (#149). ADR-0026 was written from
Codex's documentation and from hermes-agent's integration; this records what the pinned
build did when asked: a free handshake, then one paid Turn.

## Q1 — The handshake needs no credential, and resolves the home it is handed

Confirmed, free. `codex app-server` started with `CODEX_HOME` pointed at an empty
scratch directory, and fed `initialize` then the `initialized` notification:

```json
{"id":1,"result":{"userAgent":"roma/0.165.0 (Mac OS 26.5.1; arm64) unknown (roma; 0.9.0)","codexHome":"<the scratch directory>","platformFamily":"unix","platformOs":"macos"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled", …},"emittedAtMs":…}
```

- **No `jsonrpc` field**, in either direction. The wire is JSON-RPC 2.0's shape without
  its version marker, one object per line — what hermes-agent sends, and what the
  build's own `JSONRPCRequest` schema permits.
- **`codexHome` comes back resolved.** That is the harness's first assertion: the
  process is using the home roma named and not one it inherited.
- **Notifications carry `emittedAtMs`** beside `method` and `params`, and arrive
  unprompted — one before any thread exists.

## Q2 — `CODEX_HOME` holds more than `auth.json` and `sessions/`

**Contradicts ADR-0026 *The home*, in a direction that strengthens it.** The same empty
directory, after nothing but the handshake, held:

```
goals_1.sqlite      logs_2.sqlite       memories_1.sqlite
queue_1.sqlite      state_5.sqlite      installation_id
skills/             tmp/
```

each SQLite file with its `-shm` and `-wal`. ADR-0026 called `auth.json` beside
`sessions/` the whole of it; on this build the process also writes its own state
databases there on every start. That is a second reason the mount cannot be read-only,
beside the refresh token, and it makes the mount's contents a build-versioned
format — the `_1`/`_2`/`_5` suffixes are schema versions. ADR-0026 *The home* is
amended to say so.

## What the schema says, read off the build

`codex app-server generate-ts` and `generate-json-schema` on 0.165.0. These readings
change what an agenda item will measure; the harness is written against them, and
ADR-0026 is amended for each but the last:

- **`thread/start` takes `model` and no `effort`.** `ThreadStartParams` has `model`,
  `cwd`, `approvalPolicy`, `sandbox`, `config` and instructions, and no effort field;
  `effort` is on `TurnStartParams`, "for this turn and subsequent turns".
  `ThreadStartResponse` reports `reasoningEffort` back. #152 measures it.
- **Token usage is not on `turn/completed`.** `Turn` carries status, error and timing.
  Usage arrives on `thread/tokenUsage/updated` as `{ total, last, modelContextWindow }`.
  A compaction is a `contextCompaction` item; the `thread/compacted` notification is
  still in the schema, and its type is marked *"Deprecated: Use `ContextCompaction` item type
  instead."* #154 measures it.
- **A `Thread` has an `id` and a `sessionId`, and they are different ids.** `sessionId`
  is "shared by threads that belong to the same session tree". The client reads `id`.
  #156 checks it is the one every method takes.
- **The posture has a stable per-thread setting.** `ThreadStartParams.sandbox` is
  `"read-only" | "workspace-write" | "danger-full-access"` and `TurnStartParams` has
  `sandboxPolicy`; only the named `permissions` profile is behind `experimentalApi`.
  #153 measures it.
- **`thread/resume` resumes by id, by path or by history**, and "if `thread_id`
  identifies a running thread, app-server rejoins that thread". #151 measures it.

## Q3 — One Turn completes against a seeded credential, on the pinned model

Confirmed, 2026-10-29, spending Codex's Shared Window. `npm run test:codex-live`
(`src/codex-app-server.codex.live.test.ts`), with `CODEX_HOME` a directory the operator
logged into directly (`CODEX_HOME=<dir> codex login`) — so the credential was never a
copy. `initialize`, `thread/start` on `gpt-5.6-sol`, one `turn/start` asking for `PING`,
to `turn/completed`. Run twice: once on an earlier draft of the client, and again on
the client and helpers beside this file, which is the run recorded here — 6.4 s for
the whole file, four assertions passing. The two agree on everything below.

What the second run printed, abridged to the fields read below (ids, `userAgent` and
the seeded path left out):

```json
{
  "build": "codex-cli 0.165.0",
  "initialized": { "codexHome": "<the seeded directory>" },
  "thread": { "model": "gpt-5.6-sol", "reasoningEffort": null },
  "turn": {
    "status": "completed",
    "text": "PING",
    "error": null,
    "tokenUsage": {
      "total": { "totalTokens": 13147, "inputTokens": 13142, "cachedInputTokens": 11264,
                 "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0 },
      "last":  { "totalTokens": 13147, "inputTokens": 13142, "cachedInputTokens": 11264,
                 "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0 }
    }
  }
}
```

- **The thread answered on the model it was asked for**, and the server said so on
  `ThreadStartResponse`. That is the shape #152's probe needs; what #152 still has to
  establish is that the model *answering* is the one named, not only the one reported.
- **`reasoningEffort` came back `null`.** Nothing was sent, and the server named no
  effort — so this Turn ran at a level roma cannot state, which is the outcome ADR-0026
  *The pins* exists to rule out. It confirms the schema reading above: the Pinned Effort
  has to be sent, and on this build it goes on `turn/start`.
- **The build sends all six usage fields**, `cacheWriteInputTokens` among them — the
  current client refuses a reading without it, and this one was accepted.
- **A one-word Turn reads about 13,100 input tokens** (13,120 and 13,142 in the two
  runs), 11,264 of them cached both times. That is the Runtime's own instructions and
  tool definitions, paid on every first Turn of a thread before anything roma or a
  Caller says. #154 is where it gets differenced across Turns.
- **One rollout file per thread**, at `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`
  — **about 94 kB** for one one-word Turn (94,403 and 94,573 bytes). Claude Code's Transcript is 7.7 kB a Session plus
  27.8 kB a Turn (`docs/transcript-growth-verification.md`), so the README's disk sizing
  does not carry over to this Runtime.
- **The home grew again.** Beside Q2's databases: `thread_history_1.sqlite`,
  `models_cache.json`, `cache/`, `plugins/`, `shell_snapshots/`, and
  **`thread-writer-locks/`** — a lock directory, which is where hermes-agent's "rollout
  locked by a killed app-server" resume failure lives. #151 and #155 should read it.
