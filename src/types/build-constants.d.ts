/**
 * True only in the separate automation build produced with
 * `WEBTORRENT_UPDATED_E2E=1`. The release build compiles this to `false`, and
 * package verification proves the shipped bundle carries the release value.
 */
declare const __WEBTORRENT_UPDATED_E2E_BUILD__: boolean
