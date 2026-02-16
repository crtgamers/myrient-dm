#!/usr/bin/env node
/**
 * @fileoverview Copia el icono de escritorio al directorio público del build
 * @module scripts/build-icon
 *
 * Copia logos/logo-final.png a public/icon.png (icono del ejecutable y ventana).
 * El logo en la interfaz usa logos/logo-vector.svg (public/logo.svg).
 */
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'logos', 'logo-final.png');
const outPath = path.join(root, 'public', 'icon.png');

try {
  if (!existsSync(srcPath)) {
    console.error('No se encuentra logos/logo-final.png');
    process.exit(1);
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  copyFileSync(srcPath, outPath);
  console.log('Icono de escritorio copiado: public/icon.png desde logos/logo-final.png');
} catch (err) {
  console.error('Error copiando icono:', (err as Error).message);
  process.exit(1);
}
