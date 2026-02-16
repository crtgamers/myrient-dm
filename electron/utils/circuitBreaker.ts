/**
 * @fileoverview Implementación del patrón Circuit Breaker para manejo inteligente de errores repetidos
 * @module circuitBreaker
 */

import { logger } from './logger';

const log = logger.child('CircuitBreaker');

export const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitStateType = (typeof CircuitState)[keyof typeof CircuitState];

export interface CircuitBreakerStats {
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalRejected: number;
  totalStateChanges: number;
}

export interface StateChangeInfo {
  name: string;
  oldState: CircuitStateType;
  newState: CircuitStateType;
  timestamp: number;
  failureCount: number;
  successCount: number;
}

export interface CircuitBreakerOptions {
  name?: string;
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  resetTimeout?: number;
  onStateChange?: (_info: StateChangeInfo) => void;
  /** (failureCount, failureThreshold, error) => boolean */
  shouldOpen?: (_failureCount: number, _failureThreshold: number, _error: Error) => boolean;
  shouldClose?: (_successCount: number) => boolean;
}

export class CircuitBreaker {
  name: string;
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  resetTimeout: number;
  state: CircuitStateType;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  stateChangedAt: number;
  nextAttemptTime: number | null;
  onStateChange: (_info: StateChangeInfo) => void;
  shouldOpen: ((_failureCount: number, _failureThreshold: number, _error: Error) => boolean) | null;
  shouldClose: ((_successCount: number) => boolean) | null;
  stats: CircuitBreakerStats;
  private resetInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'CircuitBreaker';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeout = options.timeout ?? 60000;
    this.resetTimeout = options.resetTimeout ?? 60000;

    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.stateChangedAt = Date.now();
    this.nextAttemptTime = null;

    this.onStateChange = options.onStateChange ?? (() => {});
    this.shouldOpen = options.shouldOpen ?? null;
    this.shouldClose = options.shouldClose ?? null;

    this.stats = {
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalRejected: 0,
      totalStateChanges: 0,
    };

    this._startResetInterval();
  }

  async execute<T>(
    operation: () => Promise<T>,
    fallback: T | (() => T) = null as unknown as T
  ): Promise<T> {
    this.stats.totalRequests++;

    if (this.state === CircuitState.OPEN) {
      if (this.nextAttemptTime !== null && Date.now() >= this.nextAttemptTime) {
        log.debug(`[CircuitBreaker:${this.name}] Intentando transición OPEN -> HALF_OPEN`);
        this._transitionToState(CircuitState.HALF_OPEN);
      } else {
        this.stats.totalRejected++;
        log.debug(
          `[CircuitBreaker:${this.name}] Request rechazado (OPEN hasta ${this.nextAttemptTime != null ? new Date(this.nextAttemptTime).toISOString() : '?'})`
        );
        if (typeof fallback === 'function') {
          return (fallback as () => T)();
        }
        return fallback;
      }
    }

    try {
      const result = await operation();
      this._recordSuccess();
      return result;
    } catch (error) {
      this._recordFailure(error as Error);
      throw error;
    }
  }

  private _recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.stats.totalSuccesses++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        log.info(
          `[CircuitBreaker:${this.name}] Transición HALF_OPEN -> CLOSED (${this.successCount} éxitos)`
        );
        this._transitionToState(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureCount > 0) {
        const timeSinceLastFailure = Date.now() - (this.lastFailureTime ?? 0);
        if (timeSinceLastFailure > this.resetTimeout) {
          log.debug(
            `[CircuitBreaker:${this.name}] Reseteando contador de fallos (${this.failureCount} -> 0)`
          );
          this.failureCount = 0;
        }
      }
    }
  }

  private _recordFailure(error: Error): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    this.stats.totalFailures++;

    log.debug(
      `[CircuitBreaker:${this.name}] Fallo registrado (${this.failureCount}/${this.failureThreshold}): ${error.message}`
    );

    if (this.state === CircuitState.HALF_OPEN) {
      log.warn(`[CircuitBreaker:${this.name}] Transición HALF_OPEN -> OPEN (fallo durante prueba)`);
      this._transitionToState(CircuitState.OPEN);
      this.successCount = 0;
    } else if (this.state === CircuitState.CLOSED) {
      const shouldOpen = this.shouldOpen
        ? this.shouldOpen(this.failureCount, this.failureThreshold, error)
        : this.failureCount >= this.failureThreshold;

      if (shouldOpen) {
        log.warn(
          `[CircuitBreaker:${this.name}] Transición CLOSED -> OPEN (${this.failureCount} fallos)`
        );
        this._transitionToState(CircuitState.OPEN);
      }
    }
  }

  private _transitionToState(newState: CircuitStateType): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.stateChangedAt = Date.now();
    this.stats.totalStateChanges++;

    if (newState === CircuitState.OPEN) {
      this.nextAttemptTime = Date.now() + this.timeout;
      this.successCount = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;
      this.nextAttemptTime = null;
    } else if (newState === CircuitState.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
      this.nextAttemptTime = null;
    }

    try {
      this.onStateChange({
        name: this.name,
        oldState,
        newState,
        timestamp: this.stateChangedAt,
        failureCount: this.failureCount,
        successCount: this.successCount,
      });
    } catch (err) {
      log.error(`[CircuitBreaker:${this.name}] Error en callback onStateChange:`, err);
    }

    log.info(`[CircuitBreaker:${this.name}] Estado: ${oldState} -> ${newState}`);
  }

  private _startResetInterval(): void {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
    }

    this.resetInterval = setInterval(
      () => {
        if (this.state === CircuitState.CLOSED && this.failureCount > 0) {
          const timeSinceLastFailure = Date.now() - (this.lastFailureTime ?? 0);
          if (timeSinceLastFailure > this.resetTimeout) {
            log.debug(`[CircuitBreaker:${this.name}] Reset periódico: ${this.failureCount} -> 0`);
            this.failureCount = 0;
          }
        }
      },
      Math.min(this.resetTimeout / 2, 30000)
    );
  }

  reset(): void {
    log.info(`[CircuitBreaker:${this.name}] Reset manual forzado`);
    this._transitionToState(CircuitState.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;
  }

  getState(): {
    state: CircuitStateType;
    failureCount: number;
    successCount: number;
    lastFailureTime: number | null;
    lastSuccessTime: number | null;
    nextAttemptTime: number | null;
    stats: CircuitBreakerStats;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: this.nextAttemptTime,
      stats: { ...this.stats },
    };
  }

  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  isHalfOpen(): boolean {
    return this.state === CircuitState.HALF_OPEN;
  }

  destroy(): void {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
      this.resetInterval = null;
    }
    log.debug(`[CircuitBreaker:${this.name}] Destruido`);
  }
}
