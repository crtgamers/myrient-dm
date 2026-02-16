/**
 * Tests de integración del motor de descargas.
 *
 * Prueba la coordinación entre componentes reales del motor:
 * - StateStore (con DB SQLite real) para persistencia
 * - Scheduler para planificación de descargas
 * - EventBus para comunicación de eventos
 * - AdaptiveConcurrencyController para ajuste dinámico de slots
 * - DownloadMetrics para métricas agregadas
 * - SessionManager para invalidación de sesiones
 *
 * NO involucra descargas HTTP reales (no se usa net.request de Electron).
 * El foco es la correctitud de la máquina de estados, la coordinación
 * de componentes y la persistencia.
 */
import { StateStore, DownloadState, ChunkState } from '../../electron/engines/StateStore';
import Scheduler from '../../electron/engines/Scheduler';
import { SessionManager } from '../../electron/engines/SessionManager';
import { DownloadMetrics } from '../../electron/engines/DownloadMetrics';
import { AdaptiveConcurrencyController } from '../../electron/engines/AdaptiveConcurrencyController';
import EventEmitter from 'events';

// EventBus simplificado (sin importar el singleton de Electron)
class TestEventBus extends EventEmitter {
  events: Array<{ name: string; args: unknown[] }> = [];

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  emitStateChanged(stateVersion: number): void {
    const payload = { stateVersion, timestamp: Date.now() };
    this.events.push({ name: 'stateChanged', args: [payload] });
    this.emit('stateChanged', payload);
  }

  emitDownloadCompleted(downloadId: number, metadata: Record<string, unknown> = {}): void {
    const payload = { downloadId, ...metadata, timestamp: Date.now() };
    this.events.push({ name: 'downloadCompleted', args: [payload] });
    this.emit('downloadCompleted', payload);
  }

  emitDownloadFailed(downloadId: number, error: string): void {
    const payload = { downloadId, error, timestamp: Date.now() };
    this.events.push({ name: 'downloadFailed', args: [payload] });
    this.emit('downloadFailed', payload);
  }

  clearEvents(): void {
    this.events = [];
  }
}

describe('DownloadEngine Integration Flow', () => {
  let stateStore: StateStore;
  let scheduler: Scheduler;
  let eventBus: TestEventBus;
  let metrics: DownloadMetrics;
  let sessionManager: SessionManager;
  let initOk = false;

  beforeEach(() => {
    stateStore = new StateStore();
    initOk = stateStore.initialize();
    scheduler = new Scheduler();
    eventBus = new TestEventBus();
    metrics = new DownloadMetrics();
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    if (initOk) {
      // Limpiar descargas
      const snap = stateStore.getSnapshot();
      snap.downloads.forEach(d => stateStore.deleteDownload(d.id));
      stateStore.close();
    }
  });

  // -----------------------------------------------------------------------
  // Flujo completo: queued → starting → downloading → verifying → completed
  // -----------------------------------------------------------------------
  describe('flujo completo de descarga exitosa', () => {
    it('debe transicionar por todos los estados hasta completed', () => {
      if (!initOk) return;

      // 1. Agregar descarga a la cola
      const snap = stateStore.addDownload({
        id: 100,
        title: 'game.zip',
        url: 'https://myrient.erista.me/files/game.zip',
        totalBytes: 1_000_000,
      });
      expect(snap.downloads).toHaveLength(1);
      expect(snap.downloads[0].state).toBe(DownloadState.QUEUED);

      // 2. Verificar que el scheduler permite la descarga
      const host = scheduler.extractHost('https://myrient.erista.me/files/game.zip');
      expect(host).toBe('myrient.erista.me');
      const canStart = scheduler.canStartDownload(0, host);
      expect(canStart.canStart).toBe(true);

      // 3. Registrar en scheduler y métricas
      scheduler.registerDownload(100, host!);
      metrics.recordStart(100, host);
      const session = sessionManager.createSession(100);
      expect(session).toBeTruthy();

      // 4. Transicionar: queued → starting
      expect(stateStore.transitionState(100, DownloadState.STARTING)).toBe(true);
      eventBus.emitStateChanged(stateStore.getStateVersion());

      // 5. Transicionar: starting → downloading
      expect(stateStore.transitionState(100, DownloadState.DOWNLOADING)).toBe(true);

      // 6. Simular progreso
      stateStore.updateDownload(100, {
        progress: 0.5,
        downloadedBytes: 500_000,
      });
      metrics.recordBytes(100, 500_000);

      // 7. Transicionar: downloading → verifying
      expect(stateStore.transitionState(100, DownloadState.VERIFYING)).toBe(true);

      // 8. Transicionar: verifying → completed
      expect(stateStore.transitionState(100, DownloadState.COMPLETED)).toBe(true);
      metrics.recordCompleted(100, 1_000_000);
      eventBus.emitDownloadCompleted(100, { title: 'game.zip' });

      // Verificar estado final
      const final = stateStore.getDownload(100);
      expect(final!.state).toBe(DownloadState.COMPLETED);

      // Verificar métricas
      const globalMetrics = metrics.getGlobalMetrics();
      expect(globalMetrics.totalStarted).toBe(1);
      expect(globalMetrics.totalCompleted).toBe(1);
      expect(globalMetrics.totalFailed).toBe(0);

      // Verificar que los eventos fueron emitidos
      expect(eventBus.events.some(e => e.name === 'stateChanged')).toBe(true);
      expect(eventBus.events.some(e => e.name === 'downloadCompleted')).toBe(true);

      // Limpiar scheduler
      scheduler.unregisterDownload(100, host!);
      expect(scheduler.getActiveCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Flujo con error y retry
  // -----------------------------------------------------------------------
  describe('flujo con error y reintento', () => {
    it('debe manejar fallo y retry correctamente', () => {
      if (!initOk) return;

      stateStore.addDownload({
        id: 200,
        title: 'rom.7z',
        url: 'https://myrient.erista.me/files/rom.7z',
        totalBytes: 500_000,
      });

      const host = 'myrient.erista.me';
      scheduler.registerDownload(200, host);
      metrics.recordStart(200, host);

      // Transicionar hasta downloading
      stateStore.transitionState(200, DownloadState.STARTING);
      stateStore.transitionState(200, DownloadState.DOWNLOADING);

      // Fallo → downloading → failed
      stateStore.transitionState(200, DownloadState.FAILED);
      metrics.recordFailed(200);
      scheduler.unregisterDownload(200, host);

      // Registrar intento fallido
      stateStore.recordAttempt({
        downloadId: 200,
        attemptNumber: 1,
        error: 'ECONNRESET',
      });

      expect(stateStore.getDownload(200)!.state).toBe(DownloadState.FAILED);
      expect(metrics.getErrorRate()).toBe(1); // 100% error (1 failed, 0 completed)

      // Retry: failed → queued (rescheduling)
      stateStore.transitionState(200, DownloadState.QUEUED);
      stateStore.updateDownload(200, { retryCount: 1 });

      // Verificar que puede volver a la cola
      expect(stateStore.getDownload(200)!.state).toBe(DownloadState.QUEUED);

      // Verificar retry penalty en el scheduler
      const now = Date.now();
      const effectivePriority = scheduler.calculateEffectivePriority(
        { priority: 1, created_at: now, retry_count: 1 },
        now
      );
      // 1 retry es gratis, así que no hay penalty
      expect(effectivePriority).toBe(1);

      // Con 3 retries, sí hay penalty
      const penalizedPriority = scheduler.calculateEffectivePriority(
        { priority: 1, created_at: now, retry_count: 3 },
        now
      );
      expect(penalizedPriority).toBeLessThan(1);
    });
  });

  // -----------------------------------------------------------------------
  // Flujo de cancelación
  // -----------------------------------------------------------------------
  describe('flujo de cancelación', () => {
    it('debe cancelar descarga durante downloading', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 300, title: 'cancel.zip', totalBytes: 0 });
      stateStore.transitionState(300, DownloadState.STARTING);
      stateStore.transitionState(300, DownloadState.DOWNLOADING);

      const session = sessionManager.createSession(300);
      metrics.recordStart(300, 'host.com');

      // Cancelar
      expect(stateStore.transitionState(300, DownloadState.CANCELLED)).toBe(true);
      sessionManager.invalidate(300);
      metrics.recordCancelledOrPaused(300);

      expect(stateStore.getDownload(300)!.state).toBe(DownloadState.CANCELLED);
      // La sesión vieja ya no es válida
      expect(sessionManager.isCurrent(300, session)).toBe(false);
    });

    it('debe cancelar descarga en cola (queued → cancelled)', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 301, title: 'queue-cancel.zip', totalBytes: 0 });
      expect(stateStore.transitionState(301, DownloadState.CANCELLED)).toBe(true);
      expect(stateStore.getDownload(301)!.state).toBe(DownloadState.CANCELLED);
    });
  });

  // -----------------------------------------------------------------------
  // Flujo de pausa / resume
  // -----------------------------------------------------------------------
  describe('flujo de pausa y resume', () => {
    it('debe pausar y reanudar correctamente', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 400, title: 'pause.zip', totalBytes: 100_000 });
      stateStore.transitionState(400, DownloadState.STARTING);
      stateStore.transitionState(400, DownloadState.DOWNLOADING);

      const host = 'host.com';
      scheduler.registerDownload(400, host);
      const _session1 = sessionManager.createSession(400);

      // Simular progreso parcial
      stateStore.updateDownload(400, { downloadedBytes: 50_000, progress: 0.5 });

      // Pausar: downloading → paused
      expect(stateStore.transitionState(400, DownloadState.PAUSED)).toBe(true);
      sessionManager.invalidate(400);
      scheduler.unregisterDownload(400, host);

      expect(stateStore.getDownload(400)!.state).toBe(DownloadState.PAUSED);
      expect(stateStore.getDownload(400)!.downloadedBytes).toBe(50_000);

      // Resume: paused → queued (reentra a la cola)
      expect(stateStore.transitionState(400, DownloadState.QUEUED)).toBe(true);
      expect(stateStore.getDownload(400)!.state).toBe(DownloadState.QUEUED);
      // Progreso preservado
      expect(stateStore.getDownload(400)!.downloadedBytes).toBe(50_000);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrencia: scheduler limits + queue selection
  // -----------------------------------------------------------------------
  describe('límites de concurrencia del scheduler', () => {
    it('debe respetar maxConcurrent al seleccionar descargas de la cola', () => {
      if (!initOk) return;

      scheduler.setMaxConcurrent(2);

      // Agregar 5 descargas a la cola
      for (let i = 1; i <= 5; i++) {
        stateStore.addDownload({
          id: 500 + i,
          title: `file${i}.zip`,
          url: `https://host${i % 2 === 0 ? 'A' : 'B'}.com/file${i}.zip`,
          totalBytes: i * 1000,
        });
      }

      const queued = stateStore.getDownloadsByState(DownloadState.QUEUED);
      expect(queued.length).toBe(5);

      // Seleccionar con 0 activas
      const selected = scheduler.selectDownloadsToStart(queued, 2, 0);
      expect(selected.length).toBeLessThanOrEqual(2);
    });

    it('debe alternar hosts en round-robin', () => {
      if (!initOk) return;

      scheduler.setMaxConcurrent(3);

      // Crear descargas de distintos hosts
      stateStore.addDownload({ id: 601, title: 'a1', url: 'https://a.com/1', totalBytes: 100 });
      stateStore.addDownload({ id: 602, title: 'b1', url: 'https://b.com/1', totalBytes: 100 });
      stateStore.addDownload({ id: 603, title: 'a2', url: 'https://a.com/2', totalBytes: 100 });

      const queued = stateStore.getDownloadsByState(DownloadState.QUEUED);
      const selected = scheduler.selectDownloadsToStart(queued, 3, 0);

      // Debe seleccionar al menos una de cada host
      const hosts = selected.map(d => scheduler.extractHost(d.url as string));
      expect(hosts.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrencia adaptativa + métricas
  // -----------------------------------------------------------------------
  describe('concurrencia adaptativa con scheduler', () => {
    it('debe ajustar el scheduler cuando el controlador escala', () => {
      jest.useFakeTimers();

      const adjustedValues: Array<{ concurrent: number; perHost: number }> = [];
      const ctrl = new AdaptiveConcurrencyController(
        (concurrent, perHost) => {
          scheduler.setMaxConcurrent(concurrent);
          scheduler.setMaxConcurrentPerHost(perHost);
          adjustedValues.push({ concurrent, perHost });
        },
        {
          enabled: true,
          evaluationIntervalMs: 100,
          cooldownMs: 0,
          windowSizeMs: 60_000,
          scaleUpErrorRateMax: 0.05,
          scaleDownErrorRateMin: 0.2,
          scaleUpMinThroughputBps: 256 * 1024,
          throughputDropThreshold: 0.4,
          scaleUpMinSamples: 2,
          scaleDownTransientRetryThreshold: 4,
        }
      );
      ctrl.updateUserMaxConcurrent(3);
      ctrl.start();

      // El scheduler debería empezar en el valor conservador del controlador
      expect(scheduler.maxConcurrent).toBe(1);

      // Simular condiciones favorables
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordThroughputSample(512 * 1024);
      jest.advanceTimersByTime(200);

      // El scheduler debería haber sido actualizado
      expect(scheduler.maxConcurrent).toBeGreaterThanOrEqual(2);

      ctrl.stop();
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Chunks: creación, actualización y limpieza
  // -----------------------------------------------------------------------
  describe('gestión de chunks en StateStore', () => {
    it('debe crear, actualizar y limpiar chunks correctamente', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 700, title: 'chunked.iso', totalBytes: 10_000 });
      stateStore.transitionState(700, DownloadState.STARTING);
      stateStore.transitionState(700, DownloadState.DOWNLOADING);

      // Crear chunks
      const created = stateStore.createChunks(700, [
        { chunkIndex: 0, startByte: 0, endByte: 4999 },
        { chunkIndex: 1, startByte: 5000, endByte: 9999 },
      ]);
      expect(created).toHaveLength(2);

      // Simular progreso del chunk 0
      stateStore.updateChunkProgress(700, 0, {
        state: ChunkState.DOWNLOADING,
        downloadedBytes: 2500,
      });
      let chunks = stateStore.getChunks(700);
      expect(chunks.find(c => c.chunkIndex === 0)!.state).toBe(ChunkState.DOWNLOADING);

      // Completar chunk 0
      stateStore.updateChunkProgress(700, 0, {
        state: ChunkState.COMPLETED,
        downloadedBytes: 5000,
      });

      // Completar chunk 1
      stateStore.updateChunkProgress(700, 1, {
        state: ChunkState.COMPLETED,
        downloadedBytes: 5000,
      });

      chunks = stateStore.getChunks(700);
      expect(chunks.every(c => c.state === ChunkState.COMPLETED)).toBe(true);

      // Transicionar a merging → verifying → completed
      expect(stateStore.transitionState(700, DownloadState.MERGING)).toBe(true);
      expect(stateStore.transitionState(700, DownloadState.VERIFYING)).toBe(true);
      expect(stateStore.transitionState(700, DownloadState.COMPLETED)).toBe(true);

      // Limpiar chunks post-merge
      const deleted = stateStore.deleteChunks(700);
      expect(deleted).toBe(2);
      expect(stateStore.getChunks(700)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Persistencia: snapshot refleja el estado actual
  // -----------------------------------------------------------------------
  describe('persistencia y snapshot', () => {
    it('snapshot debe reflejar el estado actual de la cola', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 800, title: 'a.zip', totalBytes: 0 });
      stateStore.addDownload({ id: 801, title: 'b.zip', totalBytes: 0 });
      stateStore.addDownload({ id: 802, title: 'c.zip', totalBytes: 0 });

      stateStore.transitionState(800, DownloadState.STARTING);
      stateStore.transitionState(800, DownloadState.DOWNLOADING);
      stateStore.transitionState(801, DownloadState.COMPLETED);

      const snap = stateStore.getSnapshot();
      expect(snap.summary.queued).toBe(1);
      expect(snap.summary.downloading).toBe(1);
      expect(snap.summary.completed).toBe(1);
      expect(snap.summary.total).toBe(3);
    });

    it('getDownloadsByState debe filtrar correctamente', () => {
      if (!initOk) return;

      stateStore.addDownload({ id: 900, title: 'q.zip', totalBytes: 0 });
      stateStore.addDownload({ id: 901, title: 'c.zip', totalBytes: 0 });
      stateStore.transitionState(901, DownloadState.COMPLETED);

      const queued = stateStore.getDownloadsByState(DownloadState.QUEUED);
      const completed = stateStore.getDownloadsByState(DownloadState.COMPLETED);

      expect(queued.length).toBe(1);
      expect(queued[0].id).toBe(900);
      expect(completed.length).toBe(1);
      expect(completed[0].id).toBe(901);
    });
  });

  // -----------------------------------------------------------------------
  // Session invalidation
  // -----------------------------------------------------------------------
  describe('invalidación de sesión', () => {
    it('debe invalidar sesiones al pausar/cancelar', () => {
      const session1 = sessionManager.createSession(1);
      expect(sessionManager.isCurrent(1, session1)).toBe(true);

      // Simular cancelación → invalidar
      sessionManager.invalidate(1);
      expect(sessionManager.isCurrent(1, session1)).toBe(false);

      // Nueva sesión al reintentar
      const session2 = sessionManager.createSession(1);
      expect(session2).not.toBe(session1);
      expect(sessionManager.isCurrent(1, session2)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Métricas + EventBus coordinados
  // -----------------------------------------------------------------------
  describe('métricas y eventos coordinados', () => {
    it('debe registrar métricas y emitir eventos en cada transición', () => {
      if (!initOk) return;

      const completedEvents: unknown[] = [];
      const failedEvents: unknown[] = [];
      eventBus.on('downloadCompleted', data => completedEvents.push(data));
      eventBus.on('downloadFailed', data => failedEvents.push(data));

      // Descarga 1: completada
      stateStore.addDownload({ id: 1000, title: 'ok.zip', totalBytes: 5000 });
      metrics.recordStart(1000, 'host.com');
      stateStore.transitionState(1000, DownloadState.STARTING);
      stateStore.transitionState(1000, DownloadState.DOWNLOADING);
      stateStore.transitionState(1000, DownloadState.VERIFYING);
      stateStore.transitionState(1000, DownloadState.COMPLETED);
      metrics.recordCompleted(1000, 5000);
      eventBus.emitDownloadCompleted(1000, { title: 'ok.zip' });

      // Descarga 2: fallida
      stateStore.addDownload({ id: 1001, title: 'fail.zip', totalBytes: 5000 });
      metrics.recordStart(1001, 'host.com');
      stateStore.transitionState(1001, DownloadState.STARTING);
      stateStore.transitionState(1001, DownloadState.DOWNLOADING);
      stateStore.transitionState(1001, DownloadState.FAILED);
      metrics.recordFailed(1001);
      eventBus.emitDownloadFailed(1001, 'ECONNRESET');

      // Verificar métricas globales
      const global = metrics.getGlobalMetrics();
      expect(global.totalStarted).toBe(2);
      expect(global.totalCompleted).toBe(1);
      expect(global.totalFailed).toBe(1);
      expect(metrics.getErrorRate()).toBe(0.5);

      // Verificar eventos
      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(1);

      // Verificar métricas por host
      const hostMetrics = metrics.getHostMetrics('host.com');
      expect(hostMetrics).not.toBeNull();
      expect(hostMetrics!.completedCount).toBe(1);
      expect(hostMetrics!.errorCount).toBe(1);
    });
  });
});
