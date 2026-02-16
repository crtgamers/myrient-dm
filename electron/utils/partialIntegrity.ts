/**
 * Verificación de integridad parcial al reanudar (checkpoint de últimos N bytes).
 * Hashea los últimos N bytes de un archivo parcial y permite comparar con un checkpoint.
 */
import { promises as fs } from 'fs';
import crypto from 'crypto';

/** Número de bytes del final del archivo a hashear para el checkpoint (64 KB). */
export const PARTIAL_TAIL_BYTES = 65536;

/**
 * Lee los últimos N bytes del archivo y devuelve su hash SHA-256 en hex.
 * Si el archivo tiene menos de N bytes, hashea todo el archivo.
 */
export async function hashLastNBytes(
  filePath: string,
  fileSize: number,
  nBytes: number = PARTIAL_TAIL_BYTES
): Promise<string> {
  if (fileSize <= 0) return crypto.createHash('sha256').update('').digest('hex');
  const toRead = Math.min(nBytes, fileSize);
  const start = fileSize - toRead;
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(toRead);
    await handle.read(buffer, 0, toRead, start);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Verifica que los últimos N bytes del archivo coincidan con el hash esperado.
 * @returns true si el archivo tiene tamaño expectedSize y el hash de los últimos N bytes coincide.
 */
export async function verifyPartialTail(
  filePath: string,
  expectedSize: number,
  expectedHash: string,
  nBytes: number = PARTIAL_TAIL_BYTES
): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size !== expectedSize) return false;
    const actualHash = await hashLastNBytes(filePath, stat.size, nBytes);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}
