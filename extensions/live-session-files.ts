export interface LiveSessionInstance {
  sessionFile: string;
}

/**
 * The Tau registry is already the authority for live mirrored Pi sessions.
 * Deriving the indicator set from it avoids an N×tmux-pane lsof scan on every
 * sidebar load and keeps the displayed live state aligned with hub routing.
 */
export function liveSessionFiles(instances: LiveSessionInstance[]): Set<string> {
  return new Set(
    instances
      .map((instance) => instance.sessionFile)
      .filter((sessionFile) => sessionFile.length > 0),
  );
}
