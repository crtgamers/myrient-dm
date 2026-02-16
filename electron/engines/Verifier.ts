/**
 * Verificación de integridad: tamaño y hash SHA-256.
 *
 * verifyFile: comprueba que el tamaño coincida con expectedSize; si hay expectedHash
 * o el archivo es ≥1 MB, calcula hash y lo compara. calculateHash para archivos o
 * chunks individuales (con callback de progreso). Usado por el engine tras merge o
 * descarga simple cuando hay hash esperado.
 *
 * @module Verifier
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import { logger } from '../utils';

const log = logger.child('Verifier');

export interface VerifyFileResult {
  valid: boolean;
  sizeValid: boolean;
  hashValid: boolean | null;
  actualSize?: number;
  expectedSize?: number;
  actualHash?: string | null;
  expectedHash?: string | null;
  error?: string;
}

export interface VerifyChunkInput {
  path: string;
  expectedSize: number;
  expectedHash?: string | null;
}

export default class Verifier {
  private readonly minSizeForHash = 1024 * 1024;
  private readonly bufferSize = 8 * 1024 * 1024;

  /**
   * Comprueba tamaño del archivo y opcionalmente hash SHA-256.
   *
   * @returns VerifyFileResult con valid, sizeValid, hashValid y detalles en caso de error.
   */
  async verifyFile(
    filePath: string,
    expectedSize: number,
    expectedHash: string | null = null,
    onProgress: ((_progress: number) => void) | null = null
  ): Promise<VerifyFileResult> {
    try {
      const stats = await fs.stat(filePath);
      const sizeValid = stats.size === expectedSize;
      if (!sizeValid) {
        return {
          valid: false,
          sizeValid: false,
          hashValid: null,
          actualSize: stats.size,
          expectedSize,
          error: `Tamaño incorrecto: ${stats.size}/${expectedSize} bytes`,
        };
      }

      let hashValid: boolean | null = null;
      let actualHash: string | null = null;

      if (expectedHash || stats.size >= this.minSizeForHash) {
        actualHash = await this.calculateHash(filePath, onProgress);
        if (expectedHash) {
          hashValid = actualHash === expectedHash.toLowerCase();
          if (!hashValid) {
            return {
              valid: false,
              sizeValid: true,
              hashValid: false,
              actualHash,
              expectedHash,
              error: `Hash incorrecto: ${actualHash} !== ${expectedHash}`,
            };
          }
        }
      }

      return {
        valid: true,
        sizeValid: true,
        hashValid: hashValid === true || hashValid === null,
        actualSize: stats.size,
        expectedSize,
        actualHash,
        expectedHash: expectedHash ?? undefined,
      };
    } catch (error) {
      log.error('Error verificando archivo:', error);
      return {
        valid: false,
        sizeValid: false,
        hashValid: null,
        error: (error as Error).message,
      };
    }
  }

  async calculateHash(
    filePath: string,
    onProgress: ((_progress: number) => void) | null = null
  ): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stats = await fs.stat(filePath);
    const fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(this.bufferSize);
    let bytesRead = 0;

    try {
      while (bytesRead < stats.size) {
        const toRead = Math.min(buffer.length, stats.size - bytesRead);
        const { bytesRead: read } = await fileHandle.read(buffer, 0, toRead, bytesRead);
        if (read === 0) break;
        hash.update(buffer.slice(0, read));
        bytesRead += read;
        if (onProgress) onProgress(bytesRead / stats.size);
      }
      return hash.digest('hex');
    } finally {
      await fileHandle.close();
    }
  }

  async verifyChunk(
    chunkPath: string,
    expectedSize: number,
    expectedHash: string | null = null
  ): Promise<VerifyFileResult> {
    try {
      const stats = await fs.stat(chunkPath);
      if (stats.size !== expectedSize) {
        return {
          valid: false,
          sizeValid: false,
          hashValid: null,
          actualSize: stats.size,
          expectedSize,
          error: `Tamaño de chunk incorrecto: ${stats.size}/${expectedSize}`,
        };
      }
      if (expectedHash) {
        const actualHash = await this.calculateHash(chunkPath);
        const hashValid = actualHash === expectedHash.toLowerCase();
        if (!hashValid) {
          return {
            valid: false,
            sizeValid: true,
            hashValid: false,
            actualHash,
            expectedHash,
            error: `Hash de chunk incorrecto: ${actualHash} !== ${expectedHash}`,
          };
        }
        return {
          valid: true,
          sizeValid: true,
          hashValid: true,
          actualHash,
        };
      }
      return {
        valid: true,
        sizeValid: true,
        hashValid: null,
      };
    } catch (error) {
      log.error(
        `[Chunk] Error verificando chunk (ruta: ${chunkPath}): ${(error as NodeJS.ErrnoException).code ?? 'VERIFY_ERROR'}: ${(error as Error).message}`,
        error
      );
      return {
        valid: false,
        sizeValid: false,
        hashValid: null,
        error: (error as Error).message,
      };
    }
  }

  async verifyChunks(chunks: VerifyChunkInput[], maxConcurrent = 4): Promise<VerifyFileResult[]> {
    const results: VerifyFileResult[] = [];
    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const batch = chunks.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(chunk =>
          this.verifyChunk(chunk.path, chunk.expectedSize, chunk.expectedHash ?? null)
        )
      );
      results.push(...batchResults);
    }
    return results;
  }
}
