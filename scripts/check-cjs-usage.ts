#!/usr/bin/env node
/**
 * @fileoverview Identifica archivos que aún usan CommonJS en electron/
 * @module scripts/check-cjs-usage
 *
 * Busca require(), module.exports y exports.* en .js/.ts para rastrear la migración a ESM.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const directoriesToCheck = [path.join(projectRoot, 'electron')];
const excludedFromCheck: string[] = [];
const extensions = ['.js', '.ts'];

const patterns = {
  require: /\brequire\s*\(/,
  moduleExports: /\bmodule\.exports\b/,
  exportsDot: /\bexports\.\w+\s*=/,
};

interface Results {
  totalFiles: number;
  filesWithRequire: string[];
  filesWithModuleExports: string[];
  filesWithExportsDot: string[];
  fullyMigrated: string[];
}

const results: Results = {
  totalFiles: 0,
  filesWithRequire: [],
  filesWithModuleExports: [],
  filesWithExportsDot: [],
  fullyMigrated: [],
};

function checkFile(filePath: string): boolean | undefined {
  const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (excludedFromCheck.includes(relativePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, 'utf-8');

  const hasRequire = patterns.require.test(content);
  const hasModuleExports = patterns.moduleExports.test(content);
  const hasExportsDot = patterns.exportsDot.test(content);

  const usesCommonJS = hasRequire || hasModuleExports || hasExportsDot;

  results.totalFiles++;

  if (hasRequire) results.filesWithRequire.push(relativePath);
  if (hasModuleExports) results.filesWithModuleExports.push(relativePath);
  if (hasExportsDot) results.filesWithExportsDot.push(relativePath);
  if (!usesCommonJS) results.fullyMigrated.push(relativePath);

  return usesCommonJS;
}

function walkDirectory(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'dist-electron', '.git'].includes(entry.name)) {
        walkDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        checkFile(fullPath);
      }
    }
  }
}

console.log('🔍 Analizando archivos para migración a ESM...\n');

for (const dir of directoriesToCheck) {
  if (fs.existsSync(dir)) {
    walkDirectory(dir);
  }
}

console.log('📊 Resultados del Análisis\n');
if (excludedFromCheck.length > 0) {
  console.log(`Excluidos (CJS intencional): ${excludedFromCheck.join(', ')}\n`);
}
console.log(`Total de archivos analizados: ${results.totalFiles}`);
console.log(`Archivos con require(): ${results.filesWithRequire.length}`);
console.log(`Archivos con module.exports: ${results.filesWithModuleExports.length}`);
console.log(`Archivos con exports.*: ${results.filesWithExportsDot.length}`);
console.log(`Archivos ya migrados a ESM: ${results.fullyMigrated.length}\n`);

if (results.filesWithRequire.length > 0) {
  console.log('📋 Archivos que usan require():');
  results.filesWithRequire.forEach(file => console.log(`  - ${file}`));
  console.log('');
}

if (results.filesWithModuleExports.length > 0) {
  console.log('📋 Archivos que usan module.exports:');
  results.filesWithModuleExports.forEach(file => console.log(`  - ${file}`));
  console.log('');
}

if (results.filesWithExportsDot.length > 0) {
  console.log('📋 Archivos que usan exports.*:');
  results.filesWithExportsDot.forEach(file => console.log(`  - ${file}`));
  console.log('');
}

if (results.fullyMigrated.length > 0) {
  console.log('✅ Archivos ya migrados a ESM:');
  results.fullyMigrated.forEach(file => console.log(`  - ${file}`));
  console.log('');
}

const needsMigration = new Set([
  ...results.filesWithRequire,
  ...results.filesWithModuleExports,
  ...results.filesWithExportsDot,
]);

const progress =
  results.totalFiles > 0
    ? ((results.fullyMigrated.length / results.totalFiles) * 100).toFixed(1)
    : '0';

console.log('📈 Progreso de Migración:');
console.log(
  `  ${results.fullyMigrated.length}/${results.totalFiles} archivos migrados (${progress}%)`
);
console.log(`  ${needsMigration.size} archivos pendientes\n`);

if (needsMigration.size === 0) {
  console.log('🎉 ¡Todos los archivos han sido migrados a ESM!');
} else {
  console.log('⚠️  Aún hay archivos pendientes de migración.');
}
