/**
 * Tests de aceptación según AUDITORIA_TECNICA.md - Criterios de Éxito
 */
import path from 'path';
import fs from 'fs';
import { EventBus } from '../../electron/engines/EventBus';

// En Jest (ts-jest compila a CJS) __dirname está disponible
const rootDir = path.resolve(__dirname, '../..');
const electronDir = path.join(rootDir, 'electron');

const EVENT_NAMES = [
  'stateChanged',
  'downloadProgress',
  'downloadCompleted',
  'downloadFailed',
  'chunkCompleted',
  'chunkFailed',
  'needsConfirmation',
] as const;

describe('Aceptación: Criterios de la auditoría', () => {
  describe('C1. Memory Leak - EventBus sin listeners duplicados tras 100 ciclos', () => {
    it('tras 100 ciclos de registrar y remover listeners, cada evento tiene 0 listeners', () => {
      const bus = new EventBus();
      const handlers: Record<string, () => void> = {};
      const CYCLES = 100;

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (const name of EVENT_NAMES) {
          handlers[name] = () => {};
          bus.on(name, handlers[name]);
        }
        for (const name of EVENT_NAMES) {
          bus.removeListener(name, handlers[name]);
        }
      }

      for (const name of EVENT_NAMES) {
        expect(bus.listenerCount(name)).toBe(0);
      }
    });
  });

  describe('C2. Ops Síncronas - main sin fs.*Sync', () => {
    it('main.ts no contiene llamadas a fs.*Sync ni fsSync', () => {
      const mainPath = path.join(electronDir, 'main.ts');
      const content = fs.readFileSync(mainPath, 'utf8');
      const syncPattern = /fs\.\w+Sync\s*\(|fsSync\./;
      const match = content.match(syncPattern);
      expect(match).toBeNull();
    });
  });

  describe('C3. Timeout FTS - Búsquedas con límite de tiempo', () => {
    it('config define searchTimeoutMs y database usa withTimeout', () => {
      const configPath = path.join(electronDir, 'config.ts');
      const dbPath = path.join(electronDir, 'database.ts');
      const configContent = fs.readFileSync(configPath, 'utf8');
      const dbContent = fs.readFileSync(dbPath, 'utf8');

      expect(configContent).toMatch(/searchTimeoutMs/);
      expect(dbContent).toMatch(/withTimeout/);
      const timeoutMatch = configContent.match(/searchTimeoutMs:\s*(\d+)/);
      if (timeoutMatch) {
        const ms = parseInt(timeoutMatch[1], 10);
        expect(ms).toBeLessThanOrEqual(15000);
      }
    });
  });

  describe('I1. Progress Batch - Recovery en StateStore', () => {
    it('StateStore implementa _flushProgressBatch con batchBackup y reintento', () => {
      const stateStorePath = path.join(electronDir, 'engines', 'StateStore.ts');
      const content = fs.readFileSync(stateStorePath, 'utf8');

      expect(content).toMatch(/batchBackup|_flushProgressBatch/);
      expect(content).toMatch(/_retryFlushScheduled|progressBatch\.clear/);
    });
  });

  describe('I2. Worker Pool - Reutilización de workers', () => {
    it('WorkerPool implementa execute, getStats y reutilización de workers', () => {
      const workerPoolPath = path.join(electronDir, 'utils', 'workerPool.ts');
      const content = fs.readFileSync(workerPoolPath, 'utf8');
      // El pool dinámico usa _tryAssignWaiting para reutilizar workers
      expect(content).toMatch(/availableWorkers\.push|_releaseWorker|_tryAssignWaiting/);
      expect(content).toMatch(/execute\s*\(|getStats\s*\(/);
    });
  });

  describe('I3. Validaciones - Única fuente (validation)', () => {
    it('DownloadService importa validación desde utils/validation', () => {
      const content = fs.readFileSync(
        path.join(electronDir, 'services', 'DownloadService.ts'),
        'utf8'
      );
      expect(content).toMatch(/utils\/validation|validateAndPrepareDownloadParams/);
    });

    it('DownloadEngine importa validación desde utils/validation', () => {
      const content = fs.readFileSync(
        path.join(electronDir, 'engines', 'DownloadEngine.ts'),
        'utf8'
      );
      expect(content).toMatch(/utils\/validation/);
    });
  });

  describe('I4. Magic Numbers - Valores en config', () => {
    it('config.ts define timing, workers y database.maxSearchTermLength', () => {
      const configPath = path.join(electronDir, 'config.ts');
      const content = fs.readFileSync(configPath, 'utf8');

      expect(content).toMatch(/timing\s*:/);
      expect(content).toMatch(/workers\s*:/);
      expect(content).toMatch(/database\s*:/);
      expect(content).toMatch(/maxSearchTermLength|searchTimeoutMs/);
    });
  });
});
