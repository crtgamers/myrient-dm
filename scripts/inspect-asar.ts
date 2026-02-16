#!/usr/bin/env node
/**
 * @fileoverview Inspecciona el contenido de app.asar para diagnosticar tamaño excesivo
 * @module scripts/inspect-asar
 *
 * Uso: npx tsx scripts/inspect-asar.ts
 * Busca app.asar en dist-electron (win-unpacked, myrient-dm-win, linux-unpacked, etc.)
 * y muestra el tamaño por carpeta principal.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'dist-electron');

function findAppAsar(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const appAsar = path.join(full, 'resources', 'app.asar');
      if (fs.existsSync(appAsar)) return appAsar;
      const nested = findAppAsar(full);
      if (nested) return nested;
    }
  }
  return null;
}

function sizeMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function dirSize(dir: string): number {
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

async function main(): Promise<void> {
  const asarPath = findAppAsar(outDir);
  if (!asarPath) {
    console.error('No se encontró app.asar en', outDir);
    console.error('Ejecuta antes: npm run build (o build:win / build:linux / build:mac)');
    process.exit(1);
  }

  const stat = fs.statSync(asarPath);
  console.log('app.asar encontrado:', asarPath);
  console.log('Tamaño total:', sizeMb(stat.size), 'MB\n');

  const { extractAll } = await import('@electron/asar');
  const extractDir = path.join(outDir, '.asar-inspect-tmp');
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    extractAll(asarPath, extractDir);
    const topDirs = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    const sizes: { name: string; bytes: number }[] = [];
    for (const d of topDirs) {
      const full = path.join(extractDir, d.name);
      sizes.push({ name: d.name, bytes: dirSize(full) });
    }
    sizes.sort((a, b) => b.bytes - a.bytes);
    console.log('Tamaño por carpeta (dentro del asar):');
    for (const s of sizes) {
      console.log('  ', s.name.padEnd(20), sizeMb(s.bytes).padStart(8), 'MB');
    }
    const topFiles = fs.readdirSync(extractDir, { withFileTypes: true }).filter(d => d.isFile());
    if (topFiles.length) {
      let fileTotal = 0;
      for (const f of topFiles) fileTotal += fs.statSync(path.join(extractDir, f.name)).size;
      console.log('  ', '(archivos raíz)'.padEnd(20), sizeMb(fileTotal).padStart(8), 'MB');
    }
    if (sizes.some(s => s.name === 'node_modules')) {
      const nmPath = path.join(extractDir, 'node_modules');
      const pkgs = fs
        .readdirSync(nmPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));
      const pkgSizes: { name: string; bytes: number }[] = [];
      for (const p of pkgs) {
        const full = path.join(nmPath, p.name);
        pkgSizes.push({ name: p.name, bytes: dirSize(full) });
      }
      pkgSizes.sort((a, b) => b.bytes - a.bytes);
      console.log('\n  node_modules (mayores primero):');
      for (const s of pkgSizes.slice(0, 15)) {
        console.log('    ', s.name.padEnd(25), sizeMb(s.bytes).padStart(8), 'MB');
      }
    }
  } finally {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
