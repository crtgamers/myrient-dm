/**
 * Hook beforePack de electron-builder.
 * Reduce el tamaño del app.asar eliminando de node_modules lo que no
 * se necesita en runtime (código fuente, binarios de otras plataformas, etc.).
 *
 * Debe exportar la función como default para que electron-builder la invoque.
 */

const fs = require('fs');
const path = require('path');

function rmRecursiveSync(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) rmRecursiveSync(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // intentionally ignore
  }
}

function safeRmDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) rmRecursiveSync(dirPath);
  } catch {
    // intentionally ignore
  }
}

exports.default = async function beforePack(context) {
  // appOutDir = directorio donde se ensambla la app antes de empaquetar (electron-builder no expone appDir)
  const appOutDir = context.appOutDir;
  if (!appOutDir || typeof appOutDir !== 'string') return;
  const nodeModules = path.join(appOutDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;

  const platform = process.platform; // 'win32' | 'darwin' | 'linux'

  // --- better-sqlite3: solo necesitamos lib/, build/ y el .node
  const bsql = path.join(nodeModules, 'better-sqlite3');
  if (fs.existsSync(bsql)) {
    safeRmDir(path.join(bsql, 'deps'));
    safeRmDir(path.join(bsql, 'src'));
    safeUnlink(path.join(bsql, 'binding.gyp'));
    safeUnlink(path.join(bsql, 'README.md'));
  }

  // --- 7zip-bin: dejar solo el binario de la plataforma actual
  const p7z = path.join(nodeModules, '7zip-bin');
  if (fs.existsSync(p7z)) {
    const keepPlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
    const dirs = fs.readdirSync(p7z, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      if (d.name !== keepPlatform) safeRmDir(path.join(p7z, d.name));
    }
    // En la plataforma que no sea linux/darwin, el script .sh no se usa
    if (platform === 'win32') safeUnlink(path.join(p7z, '7x.sh'));
    safeUnlink(path.join(p7z, 'README.md'));
  }
};
