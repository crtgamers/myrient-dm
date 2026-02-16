#!/usr/bin/env node
/**
 * @fileoverview Comprime las bases de datos de catálogo a .7z para el empaquetado
 * @module scripts/build-db-7z
 *
 * Comprime resources/myrient_data.db y resources/lolrom_data.db a sus respectivos
 * archivos .7z para que electron-builder pueda incluirlos en extraResources.
 * Ambas bases siguen el mismo flujo: compresión con 7za, extracción al arranque
 * si no existe el .db, e inyección de índices y element_paths.
 * Requiere: 7zip-bin (dependencia del proyecto).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(projectRoot, 'resources');

interface DbConfig {
  dbFile: string;
  archivePath: string;
  name: string;
}

const DB_CONFIGS: DbConfig[] = [
  {
    dbFile: path.join(resourcesDir, 'myrient_data.db'),
    archivePath: path.join(resourcesDir, 'myrient_data.7z'),
    name: 'myrient_data',
  },
  {
    dbFile: path.join(resourcesDir, 'lolrom_data.db'),
    archivePath: path.join(resourcesDir, 'lolrom_data.7z'),
    name: 'lolrom_data',
  },
];

function compressDb(path7za: string, config: DbConfig): Promise<void> {
  const { dbFile, archivePath, name } = config;
  if (fs.existsSync(archivePath)) {
    fs.unlinkSync(archivePath);
  }
  console.log(`Comprimiendo ${name}...`);
  console.log('  Origen:', dbFile);
  console.log('  Destino:', archivePath);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      path7za,
      ['a', '-t7z', '-mx=5', path.basename(archivePath), path.basename(dbFile)],
      {
        cwd: resourcesDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer | string) => {
      stderr += d.toString();
    });
    proc.stdout?.on('data', (d: Buffer | string) => {
      const line = d.toString().trim();
      if (line) console.log('  7z:', line);
    });

    proc.on('close', code => {
      if (code === 0) {
        const stat = fs.statSync(archivePath);
        console.log(`  ${name}: listo. Tamaño .7z:`, (stat.size / 1024 / 1024).toFixed(2), 'MB');
        resolve();
      } else {
        reject(new Error(`7za salió con código ${code} para ${name}: ${stderr}`));
      }
    });

    proc.on('error', err => reject(err));
  });
}

async function main(): Promise<void> {
  const [myrient, lolrom] = DB_CONFIGS;
  const hasMyrientDb = fs.existsSync(myrient.dbFile);
  const hasMyrient7z = fs.existsSync(myrient.archivePath);
  const hasLolromDb = fs.existsSync(lolrom.dbFile);
  const hasLolrom7z = fs.existsSync(lolrom.archivePath);

  if (!hasMyrientDb && !hasMyrient7z) {
    console.error(
      'No se encontró resources/myrient_data.db ni resources/myrient_data.7z. Necesitas al menos uno para el build.'
    );
    process.exit(1);
  }

  let hasAnyToCompress = false;
  if (hasMyrientDb) hasAnyToCompress = true;
  else if (hasMyrient7z) {
    const stat = fs.statSync(myrient.archivePath);
    console.log(
      'No hay myrient_data.db; se usará el .7z existente en resources (',
      (stat.size / 1024 / 1024).toFixed(2),
      'MB ).'
    );
  }

  if (hasLolromDb) hasAnyToCompress = true;
  else if (hasLolrom7z) {
    const stat = fs.statSync(lolrom.archivePath);
    console.log(
      'No hay lolrom_data.db; se usará el .7z existente en resources (',
      (stat.size / 1024 / 1024).toFixed(2),
      'MB ).'
    );
  }

  if (!hasAnyToCompress) {
    return;
  }

  const mod = await import('7zip-bin');
  const path7za =
    (mod as { path7za?: string; default?: { path7za?: string } }).path7za ??
    (mod as { default?: { path7za?: string } }).default?.path7za;
  if (!path7za || !fs.existsSync(path7za)) {
    console.error('7zip-bin: no se encontró el binario 7za. Instala con: npm i -D 7zip-bin');
    process.exit(1);
  }

  for (const config of DB_CONFIGS) {
    const hasDb = fs.existsSync(config.dbFile);
    if (hasDb) {
      await compressDb(path7za, config);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
