/**
 * Extracción de la base de datos SQLite desde archivo .7z comprimido.
 *
 * Extraído de database.ts para reducir el "God Object" y separar la lógica de
 * extracción (I/O + proceso externo) de la lógica de consultas SQL.
 *
 * @module dbExtractor
 */

import { spawn } from 'child_process';
import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const log = logger.child('DbExtractor');

/** Verifica si un archivo existe de forma asíncrona (no bloquea el main thread). */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Devuelve la ruta a 7z/7za si existe en el sistema; null si no se encuentra.
 * Comprueba ubicaciones estándar según plataforma.
 */
export async function find7zPath(): Promise<string | null> {
  const possiblePaths =
    process.platform === 'darwin'
      ? ['/usr/local/bin/7z', '/opt/homebrew/bin/7z', path.join(process.resourcesPath ?? '', '7z')]
      : [
          'C:\\Program Files\\7-Zip\\7z.exe',
          'C:\\Program Files (x86)\\7-Zip\\7z.exe',
          path.join(process.resourcesPath ?? '', '7z.exe'),
        ];

  for (const p of possiblePaths) {
    if (await fileExists(p)) return p;
  }
  return null;
}

/**
 * Resuelve la ruta al binario 7-Zip, priorizando 7zip-bin (bundled) y cayendo a sistema.
 */
async function resolve7zBinary(): Promise<string> {
  // 1. Intentar 7zip-bin (incluido en dependencias)
  let sevenZipPath: string | null = null;
  try {
    const mod = await import('7zip-bin');
    sevenZipPath =
      (mod as { path7za?: string; default?: { path7za?: string } }).path7za ??
      (mod as { default?: { path7za?: string } }).default?.path7za ??
      null;
    if (
      sevenZipPath &&
      app.isPackaged &&
      sevenZipPath.includes('app.asar') &&
      !sevenZipPath.includes('app.asar.unpacked')
    ) {
      sevenZipPath = sevenZipPath.replace('app.asar', 'app.asar.unpacked');
    }
    if (!sevenZipPath || !(await fileExists(sevenZipPath))) sevenZipPath = null;
  } catch {
    log.debug?.('7zip-bin no disponible, usando fallback');
  }

  // 2. Fallback a 7-Zip del sistema
  if (!sevenZipPath) {
    sevenZipPath = await find7zPath();
    if (sevenZipPath) log.info('Usando 7-Zip del sistema:', sevenZipPath);
  } else {
    log.info('Usando 7zip-bin (binario incluido):', sevenZipPath);
  }

  if (!sevenZipPath) {
    const hint =
      process.platform === 'win32'
        ? 'Instala 7-Zip desde https://www.7-zip.org/ o coloca el archivo .db (myrient_data.db o lolrom_data.db) en la carpeta resources de la aplicación.'
        : 'Instala 7-Zip (p. ej. pkg install 7z o apt install p7zip-full) o coloca el archivo .db correspondiente en la carpeta resources.';
    throw new Error(`No se encontró 7-Zip para extraer la base de datos.\n\n${hint}`);
  }

  return sevenZipPath;
}

/** HTML de la ventana de progreso durante la extracción. */
const PROGRESS_HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg-main:#0b0f1a;--bg-secondary:rgba(31,41,55,0.5);--border-color:rgba(75,85,99,0.3);--primary-color:#10b981;--primary-alpha:rgba(16,185,129,0.2);--text-primary:#f9fafb;--text-secondary:#9ca3af;--text-muted:#6b7280;--radius-lg:0.75rem;--shadow-glow:0 0 15px rgba(16,185,129,0.2);}*{box-sizing:border-box;}html,body{height:100%;margin:0;}body{font-family:'Inter',system-ui,sans-serif;background:var(--bg-main);color:var(--text-primary);display:flex;flex-direction:column;justify-content:center;align-items:center;padding:2rem;text-align:center;line-height:1.6;}.card{background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:2rem 2.5rem;max-width:420px;box-shadow:var(--shadow-glow);}h2{margin:0 0 1rem 0;font-size:1.25rem;font-weight:600;color:var(--primary-color);}.message{margin:0.5rem 0;color:var(--text-secondary);font-size:0.875rem;}.hint{margin-top:1rem;font-size:0.75rem;color:var(--text-muted);}.spinner{width:44px;height:44px;margin:1.5rem auto 0;border:3px solid var(--primary-alpha);border-top-color:var(--primary-color);border-radius:50%;animation:spin 0.8s linear infinite;}@keyframes spin{to{transform:rotate(360deg);}}</style></head><body><div class="card"><h2>Myrient Download Manager</h2><p class="message">Se está descomprimiendo la base de datos por primera vez.</p><p class="message">Esto puede tardar varios minutos. Por favor espere.</p><p class="hint">La aplicación se abrirá automáticamente al terminar.</p><div class="spinner"></div></div></body></html>`;

/**
 * Extrae la base de datos desde el .7z usando 7-Zip (sistema o 7zip-bin);
 * muestra ventana de progreso durante la extracción.
 * Se usa tanto para myrient_data.db como para lolrom_data.db (mismo flujo).
 *
 * @param dbPath — ruta destino del archivo .db
 * @param compressed7zPath — ruta del archivo .7z
 */
export async function extractDatabase(dbPath: string, compressed7zPath: string): Promise<boolean> {
  const extractDir = path.dirname(dbPath);

  try {
    await fs.promises.mkdir(extractDir, { recursive: true });
  } catch (err) {
    log.warn('No se pudo crear directorio de extracción:', (err as Error).message);
  }

  const sevenZipPath = await resolve7zBinary();

  return new Promise((resolve, reject) => {
    const progressWindow = new BrowserWindow({
      width: 620,
      height: 480,
      minWidth: 320,
      minHeight: 240,
      maxWidth: 620,
      maxHeight: 480,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    progressWindow.once('ready-to-show', () => progressWindow.show());
    progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_HTML)}`);

    const sevenZip = spawn(sevenZipPath, ['x', compressed7zPath, `-o${extractDir}`, '-y'], {
      shell: false,
      windowsHide: true,
    });

    let errorOutput = '';

    sevenZip.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      const progressMatch = text.match(/(\d+)%/);
      if (progressMatch && log.debug) log.debug('7z progreso:', progressMatch[1] + '%');
    });

    sevenZip.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    sevenZip.on('close', (code: number) => {
      progressWindow.close();
      if (code === 0) {
        log.info('Extracción completada exitosamente');
        fs.promises
          .unlink(compressed7zPath)
          .then(() => log.info('Archivo .7z eliminado'))
          .catch((err: Error) => log.warn('No se pudo eliminar .7z:', err.message));
        resolve(true);
      } else {
        log.error('Error en extracción, código:', code);
        reject(new Error(`7-Zip falló con código ${code}: ${errorOutput}`));
      }
    });

    sevenZip.on('error', (err: NodeJS.ErrnoException) => {
      progressWindow.close();
      log.error('Error ejecutando 7-Zip:', err);
      if (err?.code === 'ENOENT') {
        const hint =
          process.platform === 'win32'
            ? 'Instala 7-Zip desde https://www.7-zip.org/ o coloca el archivo .db (myrient_data.db o lolrom_data.db) en la carpeta resources.'
            : 'Instala 7-Zip (p. ej. pkg install 7z o apt install p7zip-full) o coloca el archivo .db correspondiente en la carpeta resources.';
        reject(new Error(`No se encontró el ejecutable de 7-Zip (spawn ENOENT).\n\n${hint}`));
      } else {
        reject(err);
      }
    });
  });
}
