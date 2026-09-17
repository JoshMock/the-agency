/**
 * Extracts string-typed package entries from a raw settings object.
 * Non-string entries (e.g. object-shaped nono packages) are silently dropped.
 */
export function parseStringPackages (settings: { packages?: unknown[] }): string[] {
  return (settings.packages ?? []).filter((p): p is string => typeof p === 'string')
}
