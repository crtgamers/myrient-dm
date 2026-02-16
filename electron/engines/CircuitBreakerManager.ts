/**
 * Circuit breakers para descargas: uno global y uno por host (configurable).
 *
 * getCircuitBreaker(url): devuelve el CircuitBreaker a usar (global o del host de la URL).
 * Si está abierto, las llamadas execute() fallan sin intentar la operación. El engine
 * usa esto antes de iniciar una descarga para no saturar un host con fallos.
 *
 * @module engines/CircuitBreakerManager
 */

import config from '../config';
import { logger } from '../utils';
import { CircuitBreaker } from '../utils/circuitBreaker';

const log = logger.child('CircuitBreakerManager');

interface CircuitBreakerConfig {
  enabled?: boolean;
  download?: {
    failureThreshold?: number;
    successThreshold?: number;
    timeout?: number;
    resetTimeout?: number;
  };
  perHost?: {
    enabled?: boolean;
    failureThreshold?: number;
    timeout?: number;
  };
}

export class CircuitBreakerManager {
  private globalCircuitBreaker: CircuitBreaker | null = null;
  private hostCircuitBreakers = new Map<string, CircuitBreaker>();

  constructor() {
    const cbConfig = config.circuitBreaker as CircuitBreakerConfig | undefined;
    if (cbConfig?.enabled) {
      const downloadConfig = cbConfig.download ?? {};
      this.globalCircuitBreaker = new CircuitBreaker({
        name: 'DownloadEngine',
        failureThreshold: downloadConfig.failureThreshold ?? 5,
        successThreshold: downloadConfig.successThreshold ?? 2,
        timeout: downloadConfig.timeout ?? 60000,
        resetTimeout: downloadConfig.resetTimeout ?? 60000,
      });
    }
  }

  /**
   * Estado del circuit breaker por host (o _global si solo hay uno global).
   * Útil para diagnóstico y métricas extendidas.
   */
  getAllHostStates(): Record<string, string> {
    const out: Record<string, string> = {};
    const cbConfig = config.circuitBreaker as CircuitBreakerConfig | undefined;
    if (cbConfig?.perHost?.enabled) {
      for (const [host, cb] of this.hostCircuitBreakers) {
        out[host] = cb.state;
      }
    } else if (this.globalCircuitBreaker) {
      out['_global'] = this.globalCircuitBreaker.state;
    }
    return out;
  }

  /** Devuelve el circuit breaker a usar para la URL (global o por host según config). */
  getCircuitBreaker(url: string): CircuitBreaker | null {
    const cbConfig = config.circuitBreaker as CircuitBreakerConfig | undefined;
    if (!cbConfig?.perHost?.enabled) {
      return this.globalCircuitBreaker;
    }

    try {
      const host = new URL(url).hostname;
      if (!this.hostCircuitBreakers.has(host)) {
        const perHostConfig = cbConfig.perHost ?? {};
        const cb = new CircuitBreaker({
          name: `Host-${host}`,
          failureThreshold: perHostConfig.failureThreshold ?? 10,
          successThreshold: 2,
          timeout: perHostConfig.timeout ?? 120000,
          resetTimeout: 60000,
        });
        this.hostCircuitBreakers.set(host, cb);
      }
      return this.hostCircuitBreakers.get(host) ?? null;
    } catch (err) {
      log.warn(
        'Error extrayendo host de URL, usando circuit breaker global:',
        (err as Error).message
      );
      return this.globalCircuitBreaker;
    }
  }
}

const circuitBreakerManager = new CircuitBreakerManager();
export default circuitBreakerManager;
