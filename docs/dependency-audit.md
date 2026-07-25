# Dependency audit record

Snapshot: **2026-07-25**

This record explains the audit findings accepted at the Apple Silicon
toolchain and process-boundary baselines. It is not a blanket exception: every
dependency update must repeat the review, and a fixed compatible upstream
release replaces an exception as soon as it qualifies.

## Packaged production graph

`npm audit --omit=dev` reports four high-severity entries. All four are the
same transitive advisory propagated through this chain:

`webtorrent` → `torrent-discovery` → `bittorrent-tracker` → `ip@2.0.1`

The qualified graph contains 220 production packages. Adding exact
`electron-store@11.0.2`, `zod@4.4.3`, and `music-metadata@11.14.0` introduced
no additional production advisory; the four labels below remain the complete
production result.

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

The full audit reports 56 entries: 3 low, 15 moderate, 38 high, and no
critical findings. Subtracting the four production labels above leaves 52
development-only labels: 3 low, 15 moderate, and 34 high. They are inherited
through the qualified Electron Forge and WebdriverIO toolchains:

- `@electron/rebuild` → `@electron/node-gyp` / `make-fetch-happen` → `tar`;
- Forge's packaging and prompt stacks → `glob` / `minimatch` /
  `brace-expansion` and `external-editor` → `tmp`;
- WebdriverIO's runner/config stack → `glob` / `minimatch`;
- WebdriverIO's archive helper stack → `archiver` / `readdir-glob` /
  `zip-stream`; and
- its Mocha/EJS scaffolding paths → `serialize-javascript`, `jake`, and
  `filelist`.

Disposition: **temporarily accepted as local build-tool debt**.

Forge 7.11.2 and the exact WebdriverIO/Electron-service suite are the qualified
stable lines, and npm reports no compatible complete fix for these paths.
Several proposed remediations are incompatible major downgrades; Forge 8 is
still an alpha. Switching the packager or E2E stack solely to reduce an audit
count is rejected without a separate qualification. Unsafe top-level
`tar`/`tmp`/glob overrides are also rejected because they would violate
declared ranges without proving the build and test tools.

Mitigations:

- these packages are development-only and are pruned from the `.app`;
- CI executes them on generated repository fixtures without production
  credentials or untrusted archive/template inputs;
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
- the ASAR contains the ESM main entry and approved runtime dependencies but
  no legacy application source tree, remote bridge, Spectron, app-owned tests,
  or application-build source maps (published dependencies may retain their own
  test or source-map files);
- every direct runtime dependency has the exact reviewed name/version in both
  the packaged root manifest and its packaged dependency manifest;
- the packaged renderer contains no raw IPC, Node, WebTorrent, or durable-state
  capability marker;
- the final macOS plist declares no camera, microphone, Bluetooth, or audio
  capture permission, and the app has no dangerous entitlement;
- ASAR integrity metadata and the complete Electron fuse policy match the
  plan; and
- the local ad-hoc signature verifies strictly.

The audit exception applies only to the exact versions and reachability
described here. New critical/high findings require an explicit disposition
before qualification.
