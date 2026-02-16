#!/usr/bin/env node
/**
 * @fileoverview Renombra la carpeta de salida de Windows tras el build
 * @module scripts/rename-win-output
 *
 * Renombra dist-electron/win-unpacked a dist-electron/myrient-dm-win.
 * Se ejecuta después de electron-builder (post-build).
 * Si falla por EPERM (carpeta en uso por el .exe, OneDrive, antivirus, etc.),
 * reintenta con pausas y, si sigue fallando, solo advierte y sale 0 para no romper el build.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'dist-electron');
const oldName = path.join(outDir, 'win-unpacked');
const newName = path.join(outDir, 'myrient-dm-win');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function doRename(): void {
  if (fs.existsSync(newName)) {
    console.warn('rename-win-output: ya existe myrient-dm-win, eliminando para reemplazar.');
    fs.rmSync(newName, { recursive: true });
  }
  fs.renameSync(oldName, newName);
}

if (!fs.existsSync(oldName)) {
  console.log('rename-win-output: no existe win-unpacked, nada que renombrar.');
  process.exit(0);
}

(async () => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      doRename();
      console.log('Carpeta renombrada: win-unpacked → myrient-dm-win');
      process.exit(0);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'EPERM' && attempt < MAX_RETRIES) {
        console.warn(
          `rename-win-output: carpeta en uso (intento ${attempt}/${MAX_RETRIES}). Reintentando en ${RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      console.error(
        'rename-win-output: no se pudo renombrar win-unpacked → myrient-dm-win.',
        e?.message ?? err
      );
      console.warn(
        'El .exe ya se generó correctamente. Si necesitas la carpeta renombrada, cierra el .exe y OneDrive/antivirus y ejecuta de nuevo: npx tsx scripts/rename-win-output.ts'
      );
      process.exit(0);
    }
  }
})();
