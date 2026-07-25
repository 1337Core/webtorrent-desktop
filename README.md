# WebTorrent Updated

An unofficial, updated fork of
[WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop) for
personal use on Apple Silicon Macs.

This project modernizes the original desktop client and is maintained
independently. It is not affiliated with or endorsed by the WebTorrent project,
and it is not an official WebTorrent release.

## Install and run

The supported development target is an Apple Silicon Mac. Use the exact
Node.js and npm versions pinned by the repository:

```sh
brew install node@24
git clone https://github.com/1337Core/webtorrent-desktop.git
cd webtorrent-desktop
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm ci --ignore-scripts
npm run artifacts
npm run dev
```

`npm run artifacts` installs and verifies the pinned Electron runtime and
native WebRTC binary without enabling dependency lifecycle scripts.

## Test and package

```sh
npm test
npm run e2e
npm run package:check
```

The packaged application is written to `out/`. It is an ad-hoc-signed local
build; there is no public installer, notarization, or automatic updater.

The migration decisions and acceptance gates are documented in
[plan.md](./plan.md).

## License

MIT. Based on the original work of
[WebTorrent contributors](https://github.com/webtorrent/webtorrent-desktop).
