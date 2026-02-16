import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fuerza que el build del preload salga en CJS. El preload de Electron se ejecuta
 * en un contexto que no soporta ESM; con "type": "module" en package.json,
 * vite-plugin-electron usa por defecto format "es", lo que puede producir preload.js
 * con "import" y el error "Cannot use import statement outside a module".
 */
function enforcePreloadCjs() {
  return {
    name: 'enforce-preload-cjs',
    config(config: {
      build?: {
        lib?: { formats?: string[] };
        rollupOptions?: { output?: Record<string, unknown> };
      };
    }) {
      config.build ??= {};
      config.build.lib ??= {};
      config.build.lib.formats = ['cjs'];
      config.build.rollupOptions ??= {};
      const out = config.build.rollupOptions.output;
      if (out && typeof out === 'object' && !Array.isArray(out)) {
        (config.build.rollupOptions.output as Record<string, unknown>).format = 'cjs';
      }
      return config;
    },
  };
}

// Configuración de Vite para la aplicación Electron + Vue
// Define los plugins, aliases y opciones de build para el bundling de la aplicación
// Frontend: src/ contiene los componentes Vue y composables
// Backend: electron/ contiene el proceso principal y scripts de preload

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        // Proceso principal de Electron que maneja la lógica de backend
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // Excluir dependencias nativas del bundling
              external: ['better-sqlite3', 'electron'],
            },
          },
        },
      },
      {
        // Script de preload que actúa como bridge seguro entre el proceso main y renderer.
        // Debe compilarse a CJS: el preload se ejecuta como script clásico, no como ESM.
        // Con "type": "module" en package.json, el plugin por defecto usa ESM; forzamos CJS aquí
        // y con el plugin enforcePreloadCjs para evitar fallos intermitentes al cargar el preload.
        entry: 'electron/preload.ts',
        vite: {
          build: {
            lib: {
              entry: 'electron/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.js',
            },
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].js',
                inlineDynamicImports: true,
              },
            },
          },
          plugins: [enforcePreloadCjs()],
        },
        onstart(options) {
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      // Alias '@' apunta al directorio src/ para imports más limpios
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    // Salida ESNext (últimas características, equivalente a ES2025; TypeScript/esbuild no tienen target "es2025" aún)
    target: 'esnext',
    // Minificar con esbuild para mejor rendimiento durante el build
    minify: 'esbuild',
  },
  server: {
    // Puerto del servidor de desarrollo de Vite
    port: 5173,
    // No permitir usar otro puerto si este está ocupado
    strictPort: true,
  },
});
