/**
 * Configuración de Jest para tests unitarios e integración.
 * El proyecto usa ESM; los tests se ejecutan con node --experimental-vm-modules.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/dist-electron/'],
  moduleFileExtensions: ['js', 'mjs', 'cjs', 'ts'],
  transform: {
    '\\.ts$': 'ts-jest',
  },
  // Mocks para ejecutar tests sin proceso Electron
  moduleNameMapper: {
    '^\\./logger\\.js$': '<rootDir>/__tests__/__mocks__/electronLogger.cjs',
    '^electron$': '<rootDir>/__tests__/__mocks__/electron.cjs',
    '^\\.\\./config\\.js$': '<rootDir>/__tests__/__mocks__/electronConfig.cjs',
    '^.*electron/config\\.js$': '<rootDir>/__tests__/__mocks__/electronConfig.cjs',
    '^.*electron/config\\.ts$': '<rootDir>/__tests__/__mocks__/electronConfig.cjs',
    '^\\./config\\.ts$': '<rootDir>/__tests__/__mocks__/electronConfig.cjs',
    // Integración IPC: mock de database y services (solo cuando se importan desde electron/)
    '^\\./database\\.js$': '<rootDir>/__tests__/__mocks__/database.cjs',
    '^\\./database\\.ts$': '<rootDir>/__tests__/__mocks__/database.cjs',
    '^\\./database$': '<rootDir>/__tests__/__mocks__/database.cjs',
    '^\\./services/index\\.js$': '<rootDir>/__tests__/__mocks__/services.cjs',
    '^\\./services/index\\.ts$': '<rootDir>/__tests__/__mocks__/services.cjs',
    '^\\./services$': '<rootDir>/__tests__/__mocks__/services.cjs',
    '^\\./logger\\.ts$': '<rootDir>/__tests__/__mocks__/electronLogger.cjs',
    // Mock de window para tests IPC (evita cargar ESM con import.meta en electron/window.ts)
    '^\\./window\\.ts$': '<rootDir>/__tests__/__mocks__/window.cjs',
    '^\\./window$': '<rootDir>/__tests__/__mocks__/window.cjs',
    // Resolver BufferPool al .ts para que Jest/ts-jest lo transforme (evitar cargar BufferPool.js ESM)
    '^\\./BufferPool$': '<rootDir>/electron/engines/BufferPool.ts',
    '^.*electron/engines/BufferPool$': '<rootDir>/electron/engines/BufferPool.ts',
  },
  // Timeout para tests que usan timers (circuitBreaker, etc.)
  testTimeout: 10000,
  verbose: true,
};
