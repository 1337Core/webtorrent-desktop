export const DANGEROUS_LAUNCH_SWITCHES = Object.freeze([
  'disable-web-security',
  'no-sandbox',
  'remote-debugging-pipe',
  'remote-debugging-port'
])

/**
 * Desktop automation drives the packaged app through Chrome DevTools, so the
 * separate automation build permits exactly the two remote-debugging
 * switches. Every other dangerous switch stays refused in both builds, and a
 * release build refuses all four.
 */
const AUTOMATION_LAUNCH_SWITCHES = Object.freeze([
  'remote-debugging-pipe',
  'remote-debugging-port'
])

type ParsedCommandLine = {
  hasSwitch: (name: string) => boolean
}

export function findDangerousLaunchSwitch(
  commandLine: ParsedCommandLine,
  options: Readonly<{ automationBuild?: boolean }> = {}
): string | null {
  const permitted = options.automationBuild ? AUTOMATION_LAUNCH_SWITCHES : []
  return (
    DANGEROUS_LAUNCH_SWITCHES.find(
      name => !permitted.includes(name) && commandLine.hasSwitch(name)
    ) ?? null
  )
}
