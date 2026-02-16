/**
 * Valida que los archivos de idioma en src/locales tengan las mismas claves que en/common.json.
 * Uso: npx tsx scripts/validate-locales.ts
 *
 * Para contribuidores: añade nuevos idiomas copiando en/common.json y traduce los valores.
 * No elimines claves ni añadas claves que no existan en en/common.json.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const LOCALES_DIR = join(process.cwd(), 'src', 'locales');
const REFERENCE_LOCALE = 'en';
const REFERENCE_FILE = join(LOCALES_DIR, REFERENCE_LOCALE, 'common.json');

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

function main(): void {
  console.log('Validando archivos de idioma (referencia: en/common.json)...\n');

  let hasErrors = false;

  const reference = loadJson(REFERENCE_FILE);
  const referenceKeys = new Set(allKeys(reference));
  console.log(`Referencia: ${referenceKeys.size} claves en ${REFERENCE_LOCALE}/common.json`);

  const locales = ['es', 'es-CL'];
  for (const locale of locales) {
    const file = join(LOCALES_DIR, locale, 'common.json');
    if (!existsSync(file)) {
      console.error(`❌ ${locale}: archivo no encontrado ${file}`);
      hasErrors = true;
      continue;
    }
    const data = loadJson(file);
    const keys = new Set(allKeys(data));

    const missing: string[] = [];
    referenceKeys.forEach(k => {
      if (!keys.has(k)) missing.push(k);
    });
    const extra: string[] = [];
    keys.forEach(k => {
      if (!referenceKeys.has(k)) extra.push(k);
    });

    if (missing.length > 0) {
      console.error(`❌ ${locale}: faltan ${missing.length} clave(s):`);
      missing.slice(0, 20).forEach(k => console.error(`   - ${k}`));
      if (missing.length > 20) console.error(`   ... y ${missing.length - 20} más`);
      hasErrors = true;
    }
    if (extra.length > 0) {
      console.error(`❌ ${locale}: claves no válidas (no están en referencia): ${extra.length}`);
      extra.slice(0, 10).forEach(k => console.error(`   - ${k}`));
      if (extra.length > 10) console.error(`   ... y ${extra.length - 10} más`);
      hasErrors = true;
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`✅ ${locale}/common.json: OK (${keys.size} claves)`);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }
  console.log('\nTodos los idiomas son válidos.');
}

main();
