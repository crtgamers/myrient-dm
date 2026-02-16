/**
 * Valida que las keys usadas en t() / $t() del frontend existan en en/common.json.
 * Opcionalmente reporta keys huérfanas (definidas en en pero no usadas en código).
 *
 * Uso:
 *   npx tsx scripts/validate-i18n-keys.ts           # solo keys usadas vs definidas
 *   npx tsx scripts/validate-i18n-keys.ts --orphans # además reporta keys huérfanas
 *
 * Ámbito: src/**\/*.vue y src/**\/*.ts (excluye src/locales/*.json y scripts).
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const SRC_DIR = join(process.cwd(), 'src');
const EN_COMMON_JSON = join(SRC_DIR, 'locales', 'en', 'common.json');

/** Regex: t('key') o t("key") o $t('key') o $t("key"). Captura la key en grupo 1. */
const T_KEY_REGEX = /(?:\$t|\bt)\s*\(\s*['"]([^'"]+)['"]/g;

function loadJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Archivo no encontrado: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`JSON inválido en ${path}: ${(e as Error).message}`);
  }
}

/** Devuelve todas las keys en notación punto (ej. app.name, nav.home). */
function allKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...allKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function* walkFiles(dir: string, ext: string): Generator<string> {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'locales') continue;
      yield* walkFiles(full, ext);
    } else if (e.isFile() && e.name.endsWith(ext)) {
      yield full;
    }
  }
}

/** Extrae keys literales de t() / $t() en el contenido. */
function extractUsedKeys(content: string): string[] {
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  T_KEY_REGEX.lastIndex = 0;
  while ((m = T_KEY_REGEX.exec(content)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

function main(): void {
  const reportOrphans = process.argv.includes('--orphans');

  console.log('Validando uso de keys i18n (referencia: en/common.json)...\n');

  const reference = loadJson(EN_COMMON_JSON);
  const definedKeys = new Set(allKeys(reference));
  console.log(`Referencia: ${definedKeys.size} keys en en/common.json`);

  const usedKeys = new Set<string>();
  const usedKeysByFile = new Map<string, Map<string, number[]>>(); // file -> key -> line numbers
  const missing: { file: string; key: string; line: number }[] = [];

  for (const ext of ['.vue', '.ts']) {
    for (const file of walkFiles(SRC_DIR, ext)) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      const relPath = relative(process.cwd(), file);

      lines.forEach((line, i) => {
        const lineNum = i + 1;
        const keysInLine = extractUsedKeys(line);
        for (const key of keysInLine) {
          usedKeys.add(key);
          if (!usedKeysByFile.has(relPath)) {
            usedKeysByFile.set(relPath, new Map());
          }
          const byKey = usedKeysByFile.get(relPath)!;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key)!.push(lineNum);

          if (!definedKeys.has(key)) {
            missing.push({ file: relPath, key, line: lineNum });
          }
        }
      });
    }
  }

  console.log(`Keys usadas en código (literales): ${usedKeys.size}\n`);

  let hasErrors = false;

  if (missing.length > 0) {
    hasErrors = true;
    console.error('❌ Keys usadas en código pero NO definidas en en/common.json:\n');
    const byKey = new Map<string, { file: string; line: number }[]>();
    for (const { file, key, line } of missing) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ file, line });
    }
    for (const [key, locations] of byKey) {
      console.error(`   "${key}"`);
      for (const { file, line } of locations) {
        console.error(`      ${file}:${line}`);
      }
    }
    console.error('');
  }

  if (reportOrphans) {
    const orphans: string[] = [];
    definedKeys.forEach(k => {
      if (!usedKeys.has(k)) orphans.push(k);
    });
    if (orphans.length > 0) {
      console.log(
        '⚠️  Keys definidas en en/common.json pero no usadas como literal en código (posibles huérfanas o keys dinámicas):'
      );
      orphans.sort();
      orphans.slice(0, 30).forEach(k => console.log(`   ${k}`));
      if (orphans.length > 30) {
        console.log(`   ... y ${orphans.length - 30} más. Total: ${orphans.length}`);
      }
      console.log('');
    }
  }

  if (!hasErrors) {
    console.log('✅ Todas las keys usadas (literales) existen en en/common.json.');
  }

  process.exit(hasErrors ? 1 : 0);
}

main();
