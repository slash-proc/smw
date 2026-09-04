# Vendored conformance checker

Copies of the GWRG distribution spec's own checker, taken verbatim from
<https://github.com/slash-proc/gwrg-dist-spec> at commit
`1aa6507eac1f3470b5763e22b6170a990015a645`.

| | |
|---|---|
| `check.js` | the conformance checks, from the spec's `site/check.js` |
| `validate.js` | its dependency-free JSON Schema validator, from `site/validate.js` |
| `schema/` | `manifest.schema.json` and `versions.schema.json` |

They are vendored rather than fetched so `check.sh` and CI gate on the same
code the public checker at <https://slash-proc.github.io/gwrg-dist-spec/> runs,
without a network. Do not edit them here; re-copy from upstream instead, and
update the commit above.

`test-conformance.mjs` serves a generated `dist/` tree over http and runs
`check()` against it, which is the same path a browser takes.
