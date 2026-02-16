/**
 * Punto de entrada del motor de descargas: reexporta EventBus, StateStore, Scheduler,
 * DownloadEngine, ChunkStore, ChunkManager, ChunkDownloader, SimpleDownloader, FileAssembler,
 * Verifier, DownloadManager, DownloadValidator, SpeedTracker, CircuitBreakerManager,
 * SessionManager y tipos compartidos.
 *
 * @module engines
 */

export { default as eventBus, EventBus } from './EventBus';
export { default as speedTracker, SpeedTracker } from './SpeedTracker';
export type { DownloadStateType, ChunkStateType } from './types';
export { DownloadState, ChunkState } from './types';
export { default as stateStore, StateStore } from './StateStore';
export type {
  Download,
  Chunk,
  Snapshot,
  AddDownloadInput,
  UpdateDownloadUpdates,
} from './StateStore';
export {
  validateSavePath,
  isTransientNetworkError,
  parseRetryAfter,
  calculateBackoffDelay,
  classifyTransientError,
  calculateAdaptiveRetryDelay,
} from './DownloadValidator';
export type {
  ValidateSavePathResult,
  ParseRetryAfterOptions,
  TransientErrorType,
} from './DownloadValidator';
export { default as Scheduler } from './Scheduler';
export type { CanStartResult } from './Scheduler';
export { default as circuitBreakerManager, CircuitBreakerManager } from './CircuitBreakerManager';
export { default as sessionManager, SessionManager } from './SessionManager';
export { default as ChunkStore } from './ChunkStore';
export type { ChunkInfo, DbChunkLike, ReconcileResult } from './ChunkStore';
export { default as FileAssembler } from './FileAssembler';
export type { ChunkToAssemble, AssembleResult } from './FileAssembler';
export { default as Verifier } from './Verifier';
export type { VerifyFileResult, VerifyChunkInput } from './Verifier';
export { default as downloadManager, DownloadManager } from './DownloadManager';
export type { ActiveDownloadEntry } from './DownloadManager';
export { default as chunkManager, ChunkManager } from './ChunkManager';
export type { ActiveChunkEntry } from './ChunkManager';
export * as simpleDownloader from './SimpleDownloader';
export type { SimpleDownloadInput } from './SimpleDownloader';
export * as chunkDownloader from './ChunkDownloader';
export type {
  ChunkRange,
  ChunkedDownloadInput,
  RecordChunkFailureOptions,
} from './ChunkDownloader';
export type { DownloadEngineRef, ChunkEngineRef } from './types';
export { default as downloadEngine, DownloadEngine } from './DownloadEngine';
export type { AddDownloadPayload } from './DownloadEngine';
