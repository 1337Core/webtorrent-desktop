import path from 'node:path'

const CONTENT_TYPES = new Map<string, string>([
  ['.m4a', 'audio/mp4'],
  ['.m4b', 'audio/mp4'],
  ['.m4p', 'audio/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.oga', 'audio/ogg'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm']
])

/**
 * An owned allowlist for media responses. A torrent-supplied MIME string is
 * never reflected into a response header.
 */
export function mediaContentType(filePath: string): string {
  return (
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    'application/octet-stream'
  )
}
