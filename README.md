<h1 align="center">
  <br>
  <a href="https://webtorrent.io">
    <img src="https://webtorrent.io/img/WebTorrent.png" alt="WebTorrent" width="200">
  </a>
  <br>
  WebTorrent Updated
  <br>
  <br>
</h1>

<h4 align="center">A maintained personal fork for Apple Silicon Macs.</h4>

## Fork status and differences

This repository is the **WebTorrent Updated** fork. It is a separate
application and is not an official WebTorrent release.

- The only supported target is the owner’s M-series Mac.
- It uses its own bundle ID and application-data directory, so it will not
  overwrite the original WebTorrent Desktop installation.
- The planned migration updates Electron, Node, WebTorrent, React, the build
  system, tests, dependencies, and renderer security model.
- Casting, telemetry, inherited update services, uTP, LSD, UPnP, and NAT-PMP
  are intentionally excluded from the first maintained build.
- There is no public installer, notarization, automatic updater, Windows/Linux
  build, or Intel Mac build.

The complete decisions and migration gates are in [plan.md](./plan.md).
Migration is in progress on this branch; until a milestone replaces a legacy
subsystem, its source still reflects the original WebTorrent Desktop
implementation.

## Current development workflow

Every project command requires the exact Node/npm pair pinned in `.nvmrc`,
`.node-version`, and `package.json`; commands fail before doing work if the
active toolchain differs.

On this Mac, the supported Homebrew toolchain is keg-only:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version # v24.18.0
npm --version  # 11.16.0
```

Then use the locked local workflow:

```sh
npm ci
npm test
npm run smoke:dev
npm run package:check
```

`package:check` produces and launches the ad-hoc-signed arm64 app under `out/`.
It does not publish, notarize, or install anything.

## Legacy upstream documentation

Everything below this heading is retained from the original project for
historical reference. Its commands, platform claims, dependencies, privacy
description, and packaging instructions describe the legacy code and are not
promises about WebTorrent Updated. They will be rewritten as the migration
replaces the corresponding systems.

## Screenshots

<p align="center">
  <img src="https://webtorrent.io/img/screenshot-player3.png" alt="screenshot" align="center">
  <img src="https://webtorrent.io/img/screenshot-main.png" width="612" height="749" alt="screenshot" align="center">
</p>

## How to Contribute

### Get the code

```
$ git clone https://github.com/webtorrent/webtorrent-desktop.git
$ cd webtorrent-desktop
$ npm install
```

### Run the app

```
$ npm start
```

### Watch the code

Restart the app automatically every time code changes. Useful during development.

```
$ npm run watch
```

### Run linters

```
$ npm test
```

### Run integration tests

```
$ npm run test-integration
```

The integration tests use Spectron and Tape. They click through the app, taking screenshots and
comparing each one to a reference. Why screenshots?

* Ad-hoc checking makes the tests a lot more work to write
* Even diffing the whole HTML is not as thorough as screenshot diffing. For example, it wouldn't
  catch an bug where hitting ESC from a video doesn't correctly restore window size.
* Chrome's own integration tests use screenshot diffing iirc
* Small UI changes will break a few tests, but the fix is as easy as deleting the offending
  screenshots and running the tests, which will recreate them with the new look.
* The resulting Github PR will then show, pixel by pixel, the exact UI changes that were made! See
  https://github.com/blog/817-behold-image-view-modes

For MacOS, you'll need a Retina screen for the integration tests to pass. Your screen should have
the same resolution as a 2018 MacBook Pro 13".

For Windows, you'll need Windows 10 with a 1366x768 screen.

When running integration tests, keep the mouse on the edge of the screen and don't touch the mouse
or keyboard while the tests are running.

### Package the app

Builds app binaries for Mac, Linux, and Windows.

```
$ npm run package
```

To build for one platform:

```
$ npm run package -- [platform] [options]
```

Where `[platform]` is `darwin`, `linux`, `win32`, or `all` (default).

The following optional arguments are available:

- `--sign` - Sign the application (Mac, Windows)
- `--package=[type]` - Package single output type.
   - `deb` - Debian package
   - `rpm` - RedHat package
   - `zip` - Linux zip file
   - `dmg` - Mac disk image
   - `exe` - Windows installer
   - `portable` - Windows portable app
   - `all` - All platforms (default)

Note: Even with the `--package` option, the auto-update files (.nupkg for Windows,
-darwin.zip for Mac) will always be produced.

#### Windows build notes

The Windows app can be packaged from **any** platform.

Note: Windows code signing only works from **Windows**, for now.

Note: To package the Windows app from non-Windows platforms,
[Wine](https://www.winehq.org/) and [Mono](https://www.mono-project.com/) need
to be installed. For example on Mac, first install
[XQuartz](http://www.xquartz.org/), then run:

```
$ brew install wine mono
```

(Requires the [Homebrew](http://brew.sh/) package manager.)

#### Mac build notes

The Mac app can only be packaged from **macOS**.

#### Linux build notes

The Linux app can be packaged from **any** platform.

If packaging from Mac, install system dependencies with Homebrew by running:

```
npm run install-system-deps
```
#### Recommended readings to start working in the app

Electron (Framework to make native apps for Windows, OSX and Linux in Javascript):
https://electronjs.org/docs/tutorial/quick-start

React.js (Framework to work with Frontend UI):
https://reactjs.org/docs/getting-started.html

Material UI (React components that implement Google's Material Design.):
https://material-ui.com/getting-started/installation

### Privacy

WebTorrent Desktop collects some basic usage stats to help us make the app better.
For example, we track how well the play button works. How often does it succeed?
Time out? Show a missing codec error?

The app never sends any personally identifying information, nor does it track which
torrents you add.

## License

MIT. Copyright (c) [WebTorrent, LLC](https://webtorrent.io).
