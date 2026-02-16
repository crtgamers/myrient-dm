/**
 * Tests de integración para handlers IPC (validación y forma de respuesta).
 * El mock de electron crea/captura handlers en globalThis.__ipcHandlersMap.
 */
import { registerHandlers, removeHandlers } from '../../electron/ipcHandlers';

declare global {
  var __ipcHandlersMap: Record<string, (..._args: unknown[]) => unknown>;
}

const getHandler = (channel: string) => globalThis.__ipcHandlersMap[channel];

describe('IPC handlers (integración)', () => {
  beforeAll(() => {
    globalThis.__ipcHandlersMap = {};
    registerHandlers(null);
  });

  afterAll(() => {
    removeHandlers();
  });

  describe('validación en handlers', () => {
    it('read-config-file rechaza filename con path traversal', async () => {
      const handler = getHandler('read-config-file');
      expect(handler).toBeDefined();
      const result = (await handler!(null, '../../etc/passwd.json')) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('read-config-file rechaza filename sin .json', async () => {
      const handler = getHandler('read-config-file');
      const result = (await handler!(null, 'favorites')) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('get-children rechaza parentId inválido', async () => {
      const handler = getHandler('get-children');
      expect(handler).toBeDefined();
      const result = (await handler!(null, -1, {})) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('get-ancestors rechaza nodeId inválido', async () => {
      const handler = getHandler('get-ancestors');
      const result = (await handler!(null, 'not-a-number')) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('get-node-info rechaza nodeId inválido', async () => {
      const handler = getHandler('get-node-info');
      const result = (await handler!(null, 0)) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('write-config-file rechaza filename inválido', async () => {
      const handler = getHandler('write-config-file');
      const result = (await handler!(null, 'foo/bar.json', {})) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('write-config-file rechaza data null', async () => {
      const handler = getHandler('write-config-file');
      const result = (await handler!(null, 'favorites.json', null)) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('Datos no proporcionados');
    });
  });

  describe('handlers que usan database mock', () => {
    it('get-db-update-date devuelve resultado', async () => {
      const handler = getHandler('get-db-update-date');
      expect(handler).toBeDefined();
      const result = await handler!(null);
      expect(result).toBeDefined();
      expect(typeof result === 'object' || result === null).toBe(true);
    });

    it('get-children con parentId válido devuelve forma esperada', async () => {
      const handler = getHandler('get-children');
      const result = (await handler!(null, 1, {})) as {
        success: boolean;
        data?: unknown[];
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });
});
