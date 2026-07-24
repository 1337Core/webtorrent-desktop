export const DANGEROUS_LAUNCH_SWITCHES = Object.freeze([
  'disable-web-security',
  'no-sandbox',
  'remote-debugging-pipe',
  'remote-debugging-port'
])

type ParsedCommandLine = {
  hasSwitch: (name: string) => boolean
}

export function findDangerousLaunchSwitch(
  commandLine: ParsedCommandLine
): string | null {
  return (
    DANGEROUS_LAUNCH_SWITCHES.find(name => commandLine.hasSwitch(name)) ?? null
  )
}
