/**
 * @fileoverview Test de calibración de conexión para recomendar descargas y chunks simultáneos
 * @module utils/connectionTest
 */

import { net } from 'electron';
import { logger } from './logger';

const log = logger.child('ConnectionTest');

const PROBE_CHUNK_SIZE = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

export interface ConnectionTestResult {
  success: boolean;
  recommendedMaxChunks: number;
  recommendedMaxParallel: number;
  message: string;
  details: string[];
}

export interface ConnectionTestOptions {
  url: string;
  totalBytes: number;
  onProgress?: (_message: string) => void;
}

function fetchRange(
  url: string,
  start: number,
  end: number
): Promise<{ success: boolean; error?: string }> {
  return new Promise(resolve => {
    const req = net.request({ url, method: 'GET' });
    req.setHeader('Range', `bytes=${start}-${end}`);
    let resolved = false;
    const finish = (success: boolean, error?: string) => {
      if (resolved) return;
      resolved = true;
      try {
        req.abort();
      } catch (abortErr) {
        // Error esperado al abortar request de test
        if ((abortErr as Error)?.message) {
          // Solo loguear si no es un error trivial de request ya finalizado
        }
      }
      clearTimeout(timer);
      resolve({ success, error });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), REQUEST_TIMEOUT_MS);
    req.on('response', (response: Electron.IncomingMessage) => {
      const code = response.statusCode;
      if (code !== 200 && code !== 206) {
        finish(false, `HTTP ${code}`);
        return;
      }
      response.on('data', () => {});
      response.on('end', () => finish(true));
      response.on('error', (err: Error) => finish(false, err.message));
    });
    req.on('error', (err: Error) => {
      const msg = err.message || String(err);
      finish(
        false,
        msg.includes('ERR_CONNECTION_RESET') || msg.includes('ECONNRESET')
          ? 'ERR_CONNECTION_RESET'
          : msg
      );
    });
    req.end();
  });
}

export async function runConnectionTest({
  url,
  totalBytes,
  onProgress = () => {},
}: ConnectionTestOptions): Promise<ConnectionTestResult> {
  const details: string[] = [];
  let recommendedMaxChunks = 1;
  let recommendedMaxParallel = 1;

  if (!url || !totalBytes || totalBytes < 1024) {
    return {
      success: false,
      recommendedMaxChunks: 1,
      recommendedMaxParallel: 1,
      message: 'URL o tamaño inválido para la prueba.',
      details: ['Se necesita un archivo de al menos 1 KB.'],
    };
  }

  const maxTestBytes = Math.min(totalBytes, PROBE_CHUNK_SIZE * 8);
  const chunkSizesToTest = [1, 2, 4, 8];
  const parallelToTest = [1, 2, 3];

  onProgress('Probando chunks simultáneos por archivo...');
  for (const numChunks of chunkSizesToTest) {
    const chunkSize = Math.floor(maxTestBytes / numChunks);
    if (chunkSize < 1024) break;
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = i === numChunks - 1 ? maxTestBytes - 1 : (i + 1) * chunkSize - 1;
      ranges.push({ start, end });
    }
    const results = await Promise.all(ranges.map(r => fetchRange(url, r.start, r.end)));
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      details.push(`${numChunks} chunks: fallo (${failed[0].error || 'conexión reseteada'}).`);
      break;
    }
    recommendedMaxChunks = numChunks;
    details.push(`${numChunks} chunks: OK.`);
  }

  onProgress('Probando descargas paralelas...');
  for (const numParallel of parallelToTest) {
    const tasks = Array.from({ length: numParallel }, (_, i) => {
      const start = i * PROBE_CHUNK_SIZE;
      const end = Math.min(start + PROBE_CHUNK_SIZE - 1, totalBytes - 1);
      if (start > end) return Promise.resolve({ success: true });
      return fetchRange(url, start, end);
    });
    const results = await Promise.all(tasks);
    const anyFailed = results.some(r => !r.success);
    if (anyFailed) {
      details.push(`${numParallel} descargas paralelas: fallo.`);
      break;
    }
    recommendedMaxParallel = numParallel;
    details.push(`${numParallel} descargas paralelas: OK.`);
  }

  const message =
    recommendedMaxChunks >= 1 && recommendedMaxParallel >= 1
      ? `Recomendación: ${recommendedMaxParallel} descarga(s) paralela(s), ${recommendedMaxChunks} chunk(s) por archivo.`
      : 'El servidor cortó la conexión con valores bajos. Usa 1 descarga paralela y 1 chunk.';

  log.info('Test de conexión finalizado', {
    recommendedMaxChunks,
    recommendedMaxParallel,
    details,
  });

  return {
    success: recommendedMaxChunks >= 1 && recommendedMaxParallel >= 1,
    recommendedMaxChunks,
    recommendedMaxParallel,
    message,
    details,
  };
}
