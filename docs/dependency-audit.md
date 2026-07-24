# Dependency audit record

Snapshot: **2026-07-24**

This record explains the audit findings accepted at the Apple Silicon
toolchain baseline. It is not a blanket exception: every dependency update
must repeat the review, and a fixed compatible upstream release replaces an
exception as soon as it qualifies.

## Packaged production graph

`npm audit --omit=dev` reports four high-severity entries. All four are the
same transitive advisory propagated through this chain:

`webtorrent` → `torrent-discovery` → `bittorrent-tracker` → `ip@2.0.1`

The underlying finding is
[GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp),
an improper public/private-address classification in `ip.isPublic`.

Disposition: **accepted as present but not reachable in this application**.

- The only `ip` import in `bittorrent-tracker@11.2.3` is
  `lib/server/parse-udp.js`.
- That tracker-server parser calls `ip.toString`; it does not call the
  vulnerable `ip.isPublic` function.
- WebTorrent uses the tracker client. WebTorrent Updated never constructs or
  exposes `bittorrent-tracker`'s tracker server.
- npm's suggested “fix” is a downgrade to `webtorrent@0.7.3`; that would not be
  a security or compatibility improvement and is rejected.

The package remains under review because its server module is imported by
`bittorrent-tracker`'s root ESM entry even though no server instance is
created. A compatible upstream removal or dependency replacement will remove
this exception.

## Development-only graph

The full audit reports 26 entries: 3 low, 22 high, and 1 critical. Apart from
the production chain above, they are inherited by Electron Forge's CLI:

- `@electron/rebuild` → `@electron/node-gyp` / `make-fetch-happen` → `tar`;
- Forge's prompt stack → `external-editor` → `tmp`; and
- the Forge packages that npm marks transitively because they depend on those
  paths.

Disposition: **temporarily accepted as local build-tool debt**.

Forge 7.11.2 is the current qualified stable release and npm reports no
compatible fix for the affected paths. Forge 8 is still an alpha; switching the
packager to a major prerelease solely to reduce an audit count is rejected
without a separate qualification. An unsafe top-level `tar`, `tmp`, or
`@electron/rebuild` override is also rejected because it would violate declared
version ranges without proving Forge/rebuild compatibility.

Mitigations:

- these packages are development-only and are pruned from the `.app`;
- installs use the exact lockfile and an explicit install-script allowlist;
- Forge's inherited `@electron/node-gyp` Git source is locked to commit
  `06b29aafb7708acef8b3669835c8a7857ebc92d2`; it is not a branch or floating
  tag, but npm cannot verify its integrity like a registry tarball, so replacing
  that path remains part of the Forge upgrade gate;
- Electron's arm64 archive is pinned to its known SHA-256;
- no application feature accepts or extracts tar archives;
- packaging is local and receives no release, signing, or publishing secrets;
  and
- Forge/rebuild releases are reviewed until a stable compatible version
  removes the affected paths.

## Package evidence

The milestone package verifier proves:

- the executable and sole native addon are arm64;
- `node-datachannel` is the only packaged `.node` file and matches its
  qualified SHA-256;
- development and unused optional native packages are absent;
- ASAR integrity metadata and the complete Electron fuse policy match the
  plan; and
- the local ad-hoc signature verifies strictly.

The audit exception applies only to the exact versions and reachability
described here. New critical/high findings require an explicit disposition
before qualification.
