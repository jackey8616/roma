# Verification: what the pinned build does with `--effort` and `/effort`

Date: 2026-08-01
Status: **run.** Every claim ADR-0016 rests on was measured before the build
followed, deliberately. One of them changed the design: the echo reports what was
*stored*, not what the model will *use*.

Measured on: the pinned build (2.1.220, ADR-0007), against the binary in this
repo's own container. Every case below reports `num_turns: 0` and
`total_cost_usd: 0` — **nothing here cost anything to establish.** That is a fact
about `/effort` and `/config` rather than about the care taken, and it is what
makes ADR-0016's build-time check possible at all.

Extracted from ADR-0016's `Verification status` on 2026-08-02. The measurements
and their prose are unchanged; what moved is where they live. ADR-0016 keeps the
findings that bear on its decision and links here for the evidence, in the shape
ADR-0011 uses.

## Measured — `/effort` is a command on this build, with `/model`'s two-descriptor shape

```js
JD_ = {type:"local-jsx", name:"effort", description:"Set effort level for model usage", …}
U6s = {type:"local",     name:"effort", supportsNonInteractive:!0,
       isEnabled:()=>yn(), get isHidden(){return!yn()}, …}
```

`yn()` is `!isInteractive` (ADR-0014's amendment, `docs/model-menu-verification.md`),
so under `-p` the second one answers. Confirmed live: `/effort current` returns a
report and `/effort <level>` returns `Set effort level to <level> (this session
only)`.

## Measured — the levels

`EL = ["low","medium","high","xhigh","max"]`, one alias (`mBc = {med:"medium"}`),
and `hBc = {ultracode:"xhigh"}` — so `ultracode` is not a sixth level.

## Measured — `--effort` lands and `/effort current` echoes it

Spawned with roma's own argument shape plus `--effort`, one `{type:'user'}` frame
carrying `/effort current`:

| spawned with | reported back |
| --- | --- |
| `--effort low` … `--effort max` | the same level, each |
| `--effort ultracode` | `Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)` |
| `--effort bananas` | `Effort level: auto (currently high)`, plus a stderr `Warning: Unknown --effort value 'bananas' — ignoring it and using the default effort.` |
| no `--effort` | `Effort level: auto (currently high)` |

The last row settles the default: this build's own fallback is `high`. The
`bananas` row is the failure mode ADR-0016's whole design is arranged around — an
unrecognised `--effort` does not fail the spawn.

## Measured — `system/init` carries no effort field

Live, on a fresh init, the whole of it:

```
type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode,
slash_commands, apiKeySource, claude_code_version, output_style, agents, skills,
plugins, capabilities, analytics_disabled, product_feedback_disabled, uuid,
fast_mode_state, fast_mode_disabled_reason, startup_timing
```

`model` is there and effort is not, which is why `/model`'s solution does not
carry over intact.

## Measured — the precedence

| `settings.json` | `--effort` | `CLAUDE_CODE_EFFORT_LEVEL` | result |
| --- | --- | --- | --- |
| `low` | — | — | low |
| `low` | `high` | — | **high** |
| — | — | `low` | low |
| — | `high` | `low` | **low** |
| `low` | `high` | `xhigh` | **xhigh** |

So `CLAUDE_CODE_EFFORT_LEVEL` > `--effort` > `settings.effortLevel`. ADR-0016
carries the two consequences this has for roma.

## Measured — none of it needs a credential

With the environment stripped to exactly `buildEnv`'s `PASSTHROUGH` plus a fresh
config dir — no `ANTHROPIC_*`, no proxy, no OAuth token, no inherited `CLAUDE_*` —
every case above still answers, at `apiKeySource: "none"`, `num_turns: 0`,
`total_cost_usd: 0`. This is what makes ADR-0016's build-time check legal under
`src/packaging.test.ts`, which forbids CI from carrying
`CLAUDE_CODE_OAUTH_TOKEN`, `test:seam2` or `.live.test`. The check needs none of
the three.

## Measured — the echo reports what was *stored*, not what the model will *use*

This is the finding that changed the design. `claude-haiku-4-5` spawned with
`--effort xhigh` reports `xhigh`. It also reports `max`. Every level, on every
model, comes back identical:

```
sonnet-5-set-max    → Set effort level to max (this session only): …
haiku-4-5-set-max   → Set effort level to max (this session only): …
```

## Read — the gate the echo cannot see

The request builder:

```js
function YO_(e,t,r,n,o){ if(!OI(o)){ delete t.effort; return } … }
function OI(e){ … if(r.includes("claude-3-")||r==="claude-opus-4-0"
                    ||r==="claude-opus-4-1"||r==="claude-sonnet-4-0"
                    ||r==="claude-sonnet-4-5"||r==="claude-haiku-4-5") return !1
                if(M$(r,"effort")||r==="claude-mythos-5") return !0
                return dj(ny(e)) }
```

So on `claude-haiku-4-5` the effort is deleted from the request, and nothing
observable says so. Corroborated by the build's own user-facing text: `xhigh`
describes itself as `Deeper reasoning than high, just below maximum (Fable 5,
Opus 4.7+, Sonnet 5)` — haiku is not among them.

## What this does not settle

**Not measured, and not measurable — what actually goes on the wire.** The one
thing that would settle it is the request body, and roma never sees one. Every
claim about `OI` above is a *reading of a binary*, and it is written down as one.

**Not measured — the server-side ceiling.** `kQt()` reads `maxEffortLevel` from
the entitled-models response, and `YCe()` clamps a level down to it. No clamping
appeared in any of the fifteen model × level cases, so this account has no ceiling
in effect and there was nothing to observe.

**Not verified — `--permission-mode bypassPermissions`.** Omitted for the reason
ADR-0012 omits it: the flag is refused to root and this container runs as root,
where roma's does not.

ADR-0016 keeps all three, because each is a caveat on the decision rather than a
gap in the evidence.
