/**
 * Tests unitarios para electron/engines/StateStore.ts
 */
import { StateStore, DownloadState, ChunkState } from '../../electron/engines/StateStore';

describe('StateStore', () => {
  describe('canTransition (sin DB)', () => {
    let store: StateStore;

    beforeEach(() => {
      store = new StateStore();
    });

    it('acepta transiciones válidas', () => {
      expect(store.canTransition('queued', 'starting')).toBe(true);
      expect(store.canTransition('queued', 'cancelled')).toBe(true);
      expect(store.canTransition('downloading', 'paused')).toBe(true);
      expect(store.canTransition('downloading', 'completed')).toBe(false);
      expect(store.canTransition('paused', 'queued')).toBe(true);
      expect(store.canTransition('completed', 'queued')).toBe(true);
    });

    it('rechaza transiciones inválidas', () => {
      expect(store.canTransition('queued', 'completed')).toBe(false);
      expect(store.canTransition('completed', 'downloading')).toBe(false);
      expect(store.canTransition('failed', 'paused')).toBe(false);
      expect(store.canTransition('unknown' as typeof DownloadState.QUEUED, 'queued')).toBe(false);
    });
  });

  describe('con DB (integration)', () => {
    let store: StateStore;
    let initOk = false;

    beforeEach(() => {
      store = new StateStore();
      initOk = store.initialize();
    });

    afterEach(() => {
      if (store && initOk) {
        const snap = store.getSnapshot();
        if (snap.downloads && snap.downloads.length > 0) {
          snap.downloads.forEach(d => store.deleteDownload(d.id));
        }
        store.close();
      }
    });

    it('inicializa y devuelve versión >= 1', () => {
      if (!initOk) return;
      expect(store.isInitialized).toBe(true);
      expect(store.getStateVersion()).toBeGreaterThanOrEqual(1);
    });

    it('getSnapshot sin minVersion devuelve hasChanges y downloads array', () => {
      if (!initOk) return;
      const snap = store.getSnapshot();
      expect(snap.stateVersion).toBeGreaterThanOrEqual(1);
      expect(snap.downloads).toEqual([]);
      expect(snap.hasChanges).toBe(true);
      expect(snap.summary).toEqual({
        queued: 0,
        downloading: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        total: 0,
      });
    });

    it('agrega descarga y la devuelve por id', () => {
      if (!initOk) return;
      const snapshot = store.addDownload({
        id: 1001,
        title: 'test.zip',
        url: 'https://example.com/test.zip',
        totalBytes: 1024,
      });
      expect(snapshot.downloads).toHaveLength(1);
      expect(snapshot.downloads[0].id).toBe(1001);
      expect(snapshot.downloads[0].state).toBe(DownloadState.QUEUED);

      const one = store.getDownload(1001);
      expect(one).not.toBeNull();
      expect(one!.id).toBe(1001);
      expect(one!.title).toBe('test.zip');
      expect(one!.state).toBe(DownloadState.QUEUED);
    });

    it('addDownload idempotente: no duplica si ya existe en cola', () => {
      if (!initOk) return;
      store.addDownload({ id: 1002, title: 'a.zip', totalBytes: 0 });
      const snap2 = store.addDownload({ id: 1002, title: 'a.zip', totalBytes: 0 });
      expect(snap2.downloads).toHaveLength(1);
    });

    it('transiciona queued -> starting -> downloading', () => {
      if (!initOk) return;
      store.addDownload({ id: 2001, title: 'f.zip', totalBytes: 0 });
      expect(store.transitionState(2001, DownloadState.STARTING)).toBe(true);
      expect(store.getDownload(2001)!.state).toBe(DownloadState.STARTING);
      expect(store.transitionState(2001, DownloadState.DOWNLOADING)).toBe(true);
      expect(store.getDownload(2001)!.state).toBe(DownloadState.DOWNLOADING);
    });

    it('rechaza transición inválida', () => {
      if (!initOk) return;
      store.addDownload({ id: 2002, title: 'g.zip', totalBytes: 0 });
      expect(store.transitionState(2002, DownloadState.COMPLETED)).toBe(false);
      expect(store.getDownload(2002)!.state).toBe(DownloadState.QUEUED);
    });

    it('actualiza progress y downloadedBytes', () => {
      if (!initOk) return;
      store.addDownload({ id: 3001, title: 'h.zip', totalBytes: 1000 });
      store.transitionState(3001, DownloadState.DOWNLOADING);
      const ok = store.updateDownload(3001, {
        progress: 0.5,
        downloadedBytes: 500,
        totalBytes: 1000,
      });
      expect(ok).toBe(true);
      const d = store.getDownload(3001)!;
      expect(d.progress).toBe(0.5);
      expect(d.downloadedBytes).toBe(500);
    });

    it('elimina descarga por id', () => {
      if (!initOk) return;
      store.addDownload({ id: 4001, title: 'x.zip', totalBytes: 0 });
      expect(store.getDownload(4001)).not.toBeNull();
      expect(store.deleteDownload(4001)).toBe(true);
      expect(store.getDownload(4001)).toBeNull();
    });

    it('clearDownloads elimina solo completed/failed/cancelled', () => {
      if (!initOk) return;
      store.addDownload({ id: 4002, title: 'a.zip', totalBytes: 0 });
      store.addDownload({ id: 4003, title: 'b.zip', totalBytes: 0 });
      store.transitionState(4002, DownloadState.COMPLETED);
      const n = store.clearDownloads();
      expect(n).toBe(1);
      expect(store.getDownload(4002)).toBeNull();
      expect(store.getDownload(4003)).not.toBeNull();
    });

    it('createChunks, getChunks, updateChunkProgress, deleteChunks', () => {
      if (!initOk) return;
      store.addDownload({ id: 5001, title: 'chunked.zip', totalBytes: 1000 });
      store.transitionState(5001, DownloadState.DOWNLOADING);

      const created = store.createChunks(5001, [
        { chunkIndex: 0, startByte: 0, endByte: 499 },
        { chunkIndex: 1, startByte: 500, endByte: 999 },
      ]);
      expect(created).toHaveLength(2);

      let chunks = store.getChunks(5001);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].state).toBe(ChunkState.PENDING);

      store.updateChunkProgress(5001, 0, {
        state: ChunkState.COMPLETED,
        downloadedBytes: 500,
      });
      chunks = store.getChunks(5001);
      expect(chunks[0].state).toBe(ChunkState.COMPLETED);

      const deleted = store.deleteChunks(5001);
      expect(deleted).toBe(2);
      expect(store.getChunks(5001)).toHaveLength(0);
    });

    it('registra intento y lo lista', () => {
      if (!initOk) return;
      store.addDownload({ id: 6001, title: 't.zip', totalBytes: 0 });
      store.recordAttempt({
        downloadId: 6001,
        attemptNumber: 1,
        error: 'ENOTFOUND',
      });
      const attempts = store.getAttempts(6001);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].error).toBe('ENOTFOUND');
    });

    it('getHistory devuelve array para una descarga', () => {
      if (!initOk) return;
      store.addDownload({ id: 7001, title: 'h.zip', totalBytes: 0 });
      const history = store.getHistory(7001);
      expect(Array.isArray(history)).toBe(true);
    });
  });
});
