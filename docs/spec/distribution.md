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

Distribution is **tied to release tags**, but the bytes a browser reads come
from a `dist` branch rather than from the release attachments, because those
cannot be fetched.

On every `v*` tag, one CI run publishes the same three files to three places:

- the **`dist` branch**, under `<tag>/` and `latest/` — this is the
  machine-readable channel. `raw.githubusercontent.com` and `cdn.jsdelivr.net`
  both serve it with `access-control-allow-origin: *`, and every version stays
  addressable at its tag forever.
- the **GitHub release** — the same bytes plus `SHA256SUMS`, for humans, for
  `curl`, and as the immutable record.
- the **Pages site** — the conversion UI, which reads its extractor from the
  `dist` branch like any other consumer.

A consumer does:

```
GET https://raw.githubusercontent.com/<owner>/<repo>/dist/latest/manifest.json
GET <module url from that manifest, resolved against it>
verify(moduleBytes)                     # never trust the manifest for this
```

Pin to a tag instead of `latest/` by swapping the path segment. jsDelivr serves
the identical paths if a CDN is preferred, at the cost of cache latency.

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

## Why the page reads from the dist branch

The conversion page could load the module sitting beside it — it is deployed
with one — but a published build reads from `dist/latest/` instead. That makes
the page a genuine consumer: it performs the same cross-origin fetch, hash
check and verification a third-party tool does, so a break in the distribution
path shows up in the page rather than only in someone else's integration.

`build-page.sh` writes the chosen URL into `site/config.json`. Locally it
defaults to the copy beside the page, so development needs no network.
