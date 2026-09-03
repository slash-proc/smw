# Distribution

Spec version 1. How a consuming web tool finds and fetches a project's
extractor.

## The constraint that shapes this: release assets are not CORS-fetchable

GitHub **release assets cannot be fetched by a browser from another origin.**
Measured, not assumed:

| URL | `access-control-allow-origin` | Usable from a page |
|---|---|---|
| `api.github.com/repos/O/R/releases/latest` | `*` | yes |
| `github.com/O/R/releases/download/TAG/FILE` | *absent* | **no** |
| `github.com/O/R/releases/latest/download/FILE` | *absent* | **no** |
| `api.github.com/repos/O/R/releases/assets/ID` (octet-stream) | *absent* after redirect | **no** |
| `raw.githubusercontent.com/O/R/REF/PATH` | `*` | yes |
| `cdn.jsdelivr.net/gh/O/R@REF/PATH` | `*` | yes |
| `O.github.io/R/PATH` (GitHub Pages) | `*` | yes |

Release downloads redirect to `release-assets.githubusercontent.com`, which
sends no CORS header at all. `curl` gets the bytes; a browser does not. The
release API is fine for *metadata* — it is only the asset bytes that are
blocked.

So "publish the module in GitHub releases and let the web tool pull it" does
not work as stated. It has to be said plainly because it fails only in a
browser, and only cross-origin: every local test passes.

## The model

**GitHub Pages is the machine-readable channel. Releases are the archival one.**

Each project publishes, from the same CI run:

- to its **Pages site** — `manifest.json` and the module, fetchable
  cross-origin by any consuming tool;
- to its **release**, tagged — the same bytes, plus `SHA256SUMS`, for humans,
  for non-browser consumers, and as the immutable record.

A consumer therefore does:

```
GET https://<owner>.github.io/<repo>/manifest.json
GET https://<owner>.github.io/<repo>/<module named by the manifest>
verify(moduleBytes)                     # never trust the manifest for this
```

The manifest carries the module's `sha256` and, when built from a tag, the
release URL — so the Pages copy can be checked against the release copy by
anyone who cares, and a consumer that mirrors the module can prove its mirror
matches.

Nothing about this is centralised: the URL is derived from the project's own
repo, and a project that does not want GitHub Pages can serve the same two
files from anywhere that sends `access-control-allow-origin: *`.

## Ordering

Pages is deployed **after** the job that verifies the module and attaches it to
the release, and only from a tag. A deployed page can therefore never advertise
a module that failed the gate, and never one that is not also in a release.

Pages is additionally deployed when the page's own sources change, since those
are independent of the module.

## Why the page carries its own module

The manual conversion page ships the module alongside itself rather than
fetching the newest release at runtime. Page and module then come from one
build of one commit and cannot drift; there is no window in which a redeployed
page is driving a module built from different source. It also means the page's
own fetch of `manifest.json` and the module is the same code path a third-party
consumer uses, just same-origin — so the page exercises the distribution format
even though it does not need the network to do it.
