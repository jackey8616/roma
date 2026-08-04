// Three settings, and the reason there are only three: each one is a place the code
// already disagreed with a Prettier default before Prettier arrived. Nothing here is a
// preference. `semi` and `singleQuote` are what `src/` has always read as.
//
// `printWidth` is the one that looks arbitrary and is not. Every option Prettier applies
// to TypeScript was swept against the unformatted tree, counting the lines each value
// would rewrite. 100 is a trough, not a round number somebody liked:
//
//     92 → 1936   96 → 990   98 → 719   [100 → 609]   102 → 677   106 → 877   110 → 1115
//
// The floor is 609 because the diff runs both ways: at 100 some lines are joined, having
// been hand-broken around 80–90 while fitting comfortably inside 100, and others are split
// for overrunning it. Widening starts splitting long lines and narrowing starts splitting
// short ones, so the two curves cross here and every step away costs more than it saves.
//
// Never add a setting here to fix one file's formatting. The rest of Prettier's options
// were swept the same way and the default won every one of them — `trailingComma: all`
// against es5 (1223) and none (2763), `arrowParens: always` against avoid (1265),
// `objectWrap: preserve` against collapse (787), `experimentalOperatorPosition: end`
// against start (1065), `experimentalTernaries: false` against true (852), and
// `quoteProps: as-needed` against consistent (623). A fourth line here is a claim that
// the sweep is stale, which is a measurement to redo rather than a value to guess at.
//
// `overrides` was measured too, on the theory that the tests and their long fixture
// literals might want a wider width than `src/`. They do not — production files bottom out
// at 100 and so do the tests — so one width covers both.

/** @type {import("prettier").Config} */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
}
