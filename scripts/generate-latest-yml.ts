#!/usr/bin/env node
/**
 * @fileoverview Genera latest.yml para actualizaciones automáticas (Windows portable).
 * @module scripts/generate-latest-yml
 *
 * electron-builder no genera latest.yml cuando se usa --publish never.
 * Este script crea latest.yml en dist-electron/ para que puedas subirlo al release
 * de GitHub junto con el .exe y el .zip.
 *
 * Uso: npx tsx scripts/generate-latest-yml.ts
 * Se ejecuta automáticamente después de build:win (rename-win-output).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'dist-electron');

function sha512Base64(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha512').update(data).digest('base64');
}

function main(): void {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    version: string;
    name?: string;
    build?: { productName?: string };
  };
  const version = pkg.version;
  const productName = pkg.build?.productName ?? pkg.name ?? 'app';
  // Nombre del .exe en disco (con espacios)
  const exeNameOnDisk = `${productName} ${version}.exe`;
  // En la URL de GitHub el provider reemplaza espacios por guiones
  const exeNameForUrl = `${productName.replace(/ /g, '-')}-${version}.exe`;
  const exePath = path.join(outDir, exeNameOnDisk);

  if (!fs.existsSync(exePath)) {
    console.warn(
      `generate-latest-yml: no se encontró ${exeNameOnDisk} en dist-electron/. Ejecuta antes npm run build:win.`
    );
    process.exit(0);
    return;
  }

  const stat = fs.statSync(exePath);
  const sha512 = sha512Base64(exePath);
  const releaseDate = new Date().toISOString();

  const yml = `# Generado por scripts/generate-latest-yml.ts - subir este archivo al release de GitHub
version: ${version}
releaseDate: "${releaseDate}"
path: ${exeNameForUrl}
sha512: ${sha512}
files:
  - url: ${exeNameForUrl}
    sha512: ${sha512}
    size: ${stat.size}
`;

  const ymlPath = path.join(outDir, 'latest.yml');
  fs.writeFileSync(ymlPath, yml, 'utf8');
  console.log('latest.yml generado en dist-electron/latest.yml');
}

main();
