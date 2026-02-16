/**
 * Clase base para los servicios de negocio (Download, Queue, Search, File).
 *
 * Proporciona: name, log (logger.child), initialized, initialize(), destroy(), handleError()
 * y success() para respuestas tipadas. Los servicios concretos extienden y sobrescriben
 * initialize() según sus dependencias.
 *
 * @module BaseService
 */

import { logger } from '../utils';
import { ERRORS } from '../constants/errors';

/** Respuesta estándar de servicios: success, data opcional, error/code/context en fallo. */
export interface ServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  code?: string;
  context?: string;
}

type LoggerChild = ReturnType<typeof logger.child>;

export default class BaseService {
  name: string;
  log: LoggerChild;
  initialized: boolean;

  constructor(name: string) {
    this.name = name;
    this.log = logger.child(`Service:${name}`);
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
    this.log.info('Servicio inicializado');
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    this.initialized = false;
    this.log.info('Servicio destruido');
  }

  /** Registra el error en log y devuelve ServiceResponse con success: false. */
  handleError(error: Error & { code?: string }, context = ''): ServiceResponse {
    const message = context
      ? `Error en ${this.name}${context ? ` - ${context}` : ''}: ${error.message}`
      : `Error en ${this.name}: ${error.message}`;

    this.log.error(message, error);
    return {
      success: false,
      error: error.message || ERRORS.GENERAL.UNKNOWN,
      code: error.code,
      context,
    };
  }

  /** Devuelve ServiceResponse con success: true y data opcional. */
  success<T = null>(data: T = null as T, message = ''): ServiceResponse<T> {
    return {
      success: true,
      data,
      message,
    };
  }
}
