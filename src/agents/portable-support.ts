import type { StoredSession } from "../domain/history.js";

export function requirePortableSession(
  sessions: readonly StoredSession[],
  sessionRef: string,
): StoredSession {
  const session = sessions.find((candidate) => candidate.sessionRef === sessionRef);
  if (session === undefined) throw new Error(`archive source session is unavailable: ${sessionRef}`);
  return session;
}
