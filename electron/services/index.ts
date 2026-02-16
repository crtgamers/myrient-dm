/**
 * Capa de servicios de lógica de negocio del proceso main.
 *
 * ServiceManager crea e inicializa DownloadService, QueueService, SearchService y FileService
 * en orden; el main llama a serviceManager.initialize() tras crear la ventana. Los handlers IPC
 * y el DownloadEngine obtienen servicios vía getDownloadService(), getSearchService(), etc.
 *
 * @module services
 */

import BaseService from './BaseService';
import DownloadService from './DownloadService';
import QueueService from './QueueService';
import SearchService from './SearchService';
import FileService from './FileService';

/**
 * Crea, inicializa y expone los servicios de negocio. Inicialización secuencial (download, queue, search, file);
 * destroy() llama a destroy() de cada servicio y limpia el mapa.
 */
class ServiceManager {
  private services = new Map<string, BaseService>();
  private _initialized = false;

  get initialized(): boolean {
    return this._initialized;
  }

  /** Inicializa los cuatro servicios en orden; idempotente si ya está inicializado. */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    const downloadService = new DownloadService();
    const queueService = new QueueService();
    const searchService = new SearchService();
    const fileService = new FileService();

    await downloadService.initialize();
    await queueService.initialize();
    await searchService.initialize();
    await fileService.initialize();

    this.services.set('download', downloadService);
    this.services.set('queue', queueService);
    this.services.set('search', searchService);
    this.services.set('file', fileService);

    this._initialized = true;
  }

  /** Devuelve un servicio por nombre genérico ('download', 'queue', 'search', 'file'). */
  get(name: string): BaseService | null {
    return this.services.get(name) ?? null;
  }

  getDownloadService(): DownloadService | null {
    return (this.services.get('download') as DownloadService | undefined) ?? null;
  }

  getQueueService(): QueueService | null {
    return (this.services.get('queue') as QueueService | undefined) ?? null;
  }

  getSearchService(): SearchService | null {
    return (this.services.get('search') as SearchService | undefined) ?? null;
  }

  getFileService(): FileService | null {
    return (this.services.get('file') as FileService | undefined) ?? null;
  }

  /** Llama a destroy() de cada servicio, limpia el mapa y marca como no inicializado. */
  async destroy(): Promise<void> {
    const destroyPromises = Array.from(this.services.values()).map(service => {
      if (service && typeof service.destroy === 'function') {
        return service.destroy();
      }
      return Promise.resolve();
    });
    await Promise.all(destroyPromises);
    this.services.clear();
    this._initialized = false;
  }
}

const serviceManager = new ServiceManager();

export {
  BaseService,
  DownloadService,
  QueueService,
  SearchService,
  FileService,
  ServiceManager,
  serviceManager,
};

export type { ServiceResponse } from './BaseService';
