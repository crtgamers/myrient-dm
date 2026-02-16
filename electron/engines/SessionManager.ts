/**
 * Sesiones por descarga para invalidar operaciones al pausar o cancelar.
 *
 * createSession(downloadId) genera un sessionId único; isCurrent(downloadId, sessionId)
 * indica si la sesión sigue siendo la activa. Al pausar/cancelar se invalida la sesión
 * y los callbacks en curso pueden comprobar isCurrent antes de actualizar estado.
 *
 * @module engines/SessionManager
 */

export class SessionManager {
  private sessions = new Map<number, string>();

  createSession(downloadId: number): string {
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    this.sessions.set(downloadId, sessionId);
    return sessionId;
  }

  invalidate(downloadId: number): void {
    this.sessions.delete(downloadId);
  }

  getSessionId(downloadId: number): string | null {
    return this.sessions.get(downloadId) ?? null;
  }

  isCurrent(downloadId: number, sessionId: string | null): boolean {
    if (!sessionId) return true;
    return this.getSessionId(downloadId) === sessionId;
  }
}

const sessionManager = new SessionManager();
export default sessionManager;
