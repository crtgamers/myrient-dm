/**
 * Tests unitarios para electron/engines/FileAssembler.ts (merge incremental).
 *
 * Cubre: startIncrementalMerge, appendChunk (orden y fuera de orden),
 * finalize, validación de tamaño, appendChunk tras finalize.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import FileAssembler from '../../electron/engines/FileAssembler';
import type ChunkStore from '../../electron/engines/ChunkStore';

/** ChunkStore de prueba que usa os.tmpdir() para evitar EPERM en rutas mock (ej. C:\Users\Test). */
function createTestChunkStore(): ChunkStore & { baseDir: string } {
  const baseDir = path.join(
    os.tmpdir(),
    'file-assembler-test',
    String(Date.now()) + Math.random().toString(36).slice(2)
  );
  return {
    baseDir,
    getChunkDir(downloadId: number) {
      return path.join(baseDir, String(downloadId));
    },
    getChunkPath(downloadId: number, chunkIndex: number) {
      return path.join(this.getChunkDir(downloadId), `.chunk.${chunkIndex}`);
    },
    getStagingPath(downloadId: number, finalPath: string) {
      const finalName = path.basename(finalPath);
      return path.join(this.getChunkDir(downloadId), `${finalName}.staging`);
    },
    async createChunkDir(downloadId: number) {
      const chunkDir = this.getChunkDir(downloadId);
      await fs.mkdir(chunkDir, { recursive: true });
      return chunkDir;
    },
  } as ChunkStore & { baseDir: string };
}

describe('FileAssembler (incremental merge)', () => {
  let chunkStore: ChunkStore & { baseDir: string };
  let fileAssembler: FileAssembler;
  let testDir: string;
  let downloadId: number;

  beforeEach(() => {
    chunkStore = createTestChunkStore();
    fileAssembler = new FileAssembler(chunkStore);
    testDir = path.join(chunkStore.baseDir, 'output');
    downloadId = Math.floor(100000 + Math.random() * 900000);
  });

  async function createChunkFiles(
    downloadId: number,
    contents: string[]
  ): Promise<{ paths: string[]; totalSize: number }> {
    await chunkStore.createChunkDir(downloadId);
    const paths: string[] = [];
    let totalSize = 0;
    for (let i = 0; i < contents.length; i++) {
      const chunkPath = chunkStore.getChunkPath(downloadId, i);
      const buf = Buffer.from(contents[i], 'utf8');
      await fs.writeFile(chunkPath, buf);
      paths.push(chunkPath);
      totalSize += buf.length;
    }
    return { paths, totalSize };
  }

  function getFinalPath(subdir: string): string {
    return path.join(testDir, String(downloadId), subdir, 'out.bin');
  }

  // -----------------------------------------------------------------------
  // Chunks en orden
  // -----------------------------------------------------------------------
  describe('appendChunk en orden', () => {
    it('debe completar merge cuando los chunks se reciben en orden y finalize escribe el archivo final', async () => {
      const contents = ['aaa', 'bbb', 'ccc'];
      const { paths, totalSize } = await createChunkFiles(downloadId, contents);
      const finalPath = getFinalPath('in-order');

      const session = fileAssembler.startIncrementalMerge(downloadId, finalPath, totalSize, 3);

      let result = await session.appendChunk(0, paths[0], contents[0].length);
      expect(result.complete).toBe(false);

      result = await session.appendChunk(1, paths[1], contents[1].length);
      expect(result.complete).toBe(false);

      result = await session.appendChunk(2, paths[2], contents[2].length);
      expect(result.complete).toBe(true);

      await session.finalize();

      const merged = await fs.readFile(finalPath, 'utf8');
      expect(merged).toBe('aaabbbccc');
      expect((await fs.stat(finalPath)).size).toBe(totalSize);
    });
  });

  // -----------------------------------------------------------------------
  // Chunks fuera de orden
  // -----------------------------------------------------------------------
  describe('appendChunk fuera de orden', () => {
    it('debe completar merge cuando los chunks llegan fuera de orden (buffer pending)', async () => {
      const contents = ['11', '22', '33'];
      const { paths, totalSize } = await createChunkFiles(downloadId, contents);
      const finalPath = getFinalPath('out-of-order');

      const session = fileAssembler.startIncrementalMerge(downloadId, finalPath, totalSize, 3);

      await session.appendChunk(1, paths[1], contents[1].length);
      let result = await session.appendChunk(0, paths[0], contents[0].length);
      expect(result.complete).toBe(false);

      result = await session.appendChunk(2, paths[2], contents[2].length);
      expect(result.complete).toBe(true);

      await session.finalize();

      const merged = await fs.readFile(finalPath, 'utf8');
      expect(merged).toBe('112233');
      expect((await fs.stat(finalPath)).size).toBe(totalSize);
    });
  });

  // -----------------------------------------------------------------------
  // finalize: validación de tamaño
  // -----------------------------------------------------------------------
  describe('finalize', () => {
    it('debe lanzar si el tamaño del staging no coincide con expectedSize', async () => {
      const contents = ['a', 'b', 'c']; // 3 bytes
      const { paths } = await createChunkFiles(downloadId, contents);
      const finalPath = getFinalPath('wrong-size');
      const wrongExpectedSize = 10; // real total = 3

      const session = fileAssembler.startIncrementalMerge(
        downloadId,
        finalPath,
        wrongExpectedSize,
        3
      );

      await session.appendChunk(0, paths[0], 1);
      await session.appendChunk(1, paths[1], 1);
      await session.appendChunk(2, paths[2], 1);

      await expect(session.finalize()).rejects.toThrow(
        /Tamaño incorrecto después de merge incremental/
      );
      await expect(fs.access(finalPath)).rejects.toThrow(); // archivo final no debe existir
    });
  });

  // -----------------------------------------------------------------------
  // appendChunk tras finalize
  // -----------------------------------------------------------------------
  describe('appendChunk tras finalize', () => {
    it('debe retornar complete: false si se llama appendChunk después de finalize', async () => {
      const contents = ['x', 'y'];
      const { paths, totalSize } = await createChunkFiles(downloadId, contents);
      const finalPath = getFinalPath('after-finalize');

      const session = fileAssembler.startIncrementalMerge(downloadId, finalPath, totalSize, 2);
      await session.appendChunk(0, paths[0], 1);
      await session.appendChunk(1, paths[1], 1);
      await session.finalize();

      const result = await session.appendChunk(0, paths[0], 1);
      expect(result.complete).toBe(false);
    });
  });
});
