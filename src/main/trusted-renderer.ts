import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from 'electron'

export const TRUSTED_RENDERER_URL = 'app://bundle/index.html'

export function isTrustedApplicationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'app:' &&
      url.hostname === 'bundle' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.pathname === '/index.html' &&
      url.search === ''
    )
  } catch {
    return false
  }
}

function isLiveMainFrame(
  candidate: WebFrameMain | null,
  expected: WebFrameMain
): candidate is WebFrameMain {
  return Boolean(
    candidate &&
    candidate === expected &&
    !candidate.detached &&
    !candidate.isDestroyed()
  )
}

export function isTrustedRendererEvent(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null
): boolean {
  if (!window || window.isDestroyed() || event.sender.isDestroyed()) {
    return false
  }

  const mainFrame = window.webContents.mainFrame
  return (
    event.sender === window.webContents &&
    isLiveMainFrame(event.senderFrame, mainFrame) &&
    isTrustedApplicationUrl(event.senderFrame.url)
  )
}
