import { Menu, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/contracts'

export type AppMenuActions = Readonly<{
  addSubtitles: () => void
  addTorrent: () => void
  createTorrent: () => void
  openPreferences: () => void
  quit: () => void
  toggleFullScreen: () => void
}>

export type AppMenuOptions = Readonly<{
  actions: AppMenuActions
  /** Development builds expose reload and developer tools; releases do not. */
  developer: boolean
}>

/**
 * The macOS application menu.
 *
 * It is a fixed template: no casting, poster, telemetry, announcement, or
 * update entries exist, and every item either runs a built-in role or calls
 * one owned action. Nothing here reaches the renderer directly.
 */
export function buildAppMenuTemplate({
  actions,
  developer
}: AppMenuOptions): MenuItemConstructorOptions[] {
  const viewItems: MenuItemConstructorOptions[] = [
    {
      accelerator: 'Ctrl+Command+F',
      click: actions.toggleFullScreen,
      label: 'Toggle Full Screen'
    }
  ]
  if (developer) {
    viewItems.push(
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' }
    )
  }

  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          accelerator: 'Command+,',
          click: actions.openPreferences,
          label: 'Preferences…'
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          accelerator: 'Command+Q',
          click: actions.quit,
          label: `Quit ${APP_NAME}`
        }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          accelerator: 'Command+O',
          click: actions.addTorrent,
          label: 'Add Torrent…'
        },
        {
          accelerator: 'Command+N',
          click: actions.createTorrent,
          label: 'Create Torrent…'
        },
        {
          click: actions.addSubtitles,
          label: 'Add Subtitles File…'
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { label: 'View', submenu: viewItems },
    {
      label: 'Window',
      role: 'windowMenu'
    }
  ]
}

export function installAppMenu(options: AppMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(options)))
}
