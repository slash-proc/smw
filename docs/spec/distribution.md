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

Distribution follows the **GWRG distribution spec**
(<https://github.com/slash-proc/gwrg-dist-spec>), which this project
implements. Two rules make it work:

- **Releases are the source of truth.** Every file a user installs is attached
  to a GitHub release. That is the archival record.
- **GitHub Pages is a mirror.** CI copies the released files into the Pages
  site, where a browser can read them. Delete the mirror and CI rebuilds it
  from the releases.

The layout is fixed:

```
https://slash-proc.github.io/smw/dist/versions.json
https://slash-proc.github.io/smw/dist/<tag>/manifest.json
https://slash-proc.github.io/smw/dist/<tag>/smw_restool.wasm
https://slash-proc.github.io/smw/dist/smw-<tag>-bundle.zip
```

`dist/versions.json` is the only path a tool hard-codes. A consumer does:

```
GET https://slash-proc.github.io/smw/dist/versions.json
GET <versions[0].manifest, resolved against that url>
GET <tools[0].binary.url, resolved against the manifest url>
verify(moduleBytes)                     # never trust the manifest for this
```

Pin to a tag by taking a different entry from `versions[]` instead of the
first. The site root stays free for the conversion page.

The mirror keeps the newest five versions and says so in `versions.json`'s
`retained`; `releasesUrl` points at the rest. Every version is also attached to
its release as an offline bundle (`spec/06-bundle.md`), which is the same
`dist/<tag>/` directory zipped.

The manifest carries the module's `sha256`, so the Pages copy can be checked
against the release copy by anyone who cares, and a consumer that mirrors the
module can prove its mirror matches.

Nothing about this is centralised: the URL is derived from the project's own
repo, and a project that does not want GitHub Pages can serve the same tree
from anywhere that sends `access-control-allow-origin: *`.

### The retired `dist` branch

Earlier releases published the module to a long-lived `dist` branch read
through `raw.githubusercontent.com`. Nothing writes or reads that branch any
more; the Pages `dist/` tree above replaces it entirely.

## Ordering

The Pages mirror is deployed **after** the job that verifies the module,
attaches it to the release, and re-runs the distribution conformance checker
against the generated tree. A deployed site can therefore never advertise a
file that failed the gate.

Pages deployments are restricted by the `github-pages` environment to the
default branch, so a tag cannot deploy. The tag build instead asks for a run on
`main` once its release exists, and that run regenerates `dist/` from the
releases list — which by then includes the new tag.

## Why the page reads from the published tree

The conversion page could load the module sitting beside it — it is deployed
with one — but a published build resolves through `dist/versions.json`
instead. That makes the page a genuine consumer: it performs the same fetch,
hash check and verification a third-party tool does, so a break in the
distribution path shows up in the page rather than only in someone else's
integration.

`build-page.sh` writes the chosen URLs into `site/config.json`. Locally, with
no `dist/` tree staged, it defaults to the copy beside the page, so development
needs no network.
