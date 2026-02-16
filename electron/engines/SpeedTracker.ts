/**
 * Velocidad de descarga y ETA por downloadId usando media móvil exponencial (EMA).
 *
 * ensureTracking/startTracking inician la sesión; update() recibe bytes descargados y total
 * y devuelve speedBytesPerSec y remainingTime. stopTracking limpia la entrada. Usado por
 * SimpleDownloader y ChunkDownloader para reportar progreso al EventBus.
 *
 * @module engines/SpeedTracker
 */

export interface SpeedTrackerEntry {
  sessionStartTime: number;
  sessionDownloaded: number;
  lastUpdate: number;
  lastDownloaded: number;
  emaSpeed: number;
  emaRemainingTime: number | null;
  alpha: number;
}

export interface SpeedUpdateResult {
  speedBytesPerSec: number;
  remainingTime: number | null;
}

/**
 * Mantiene métricas por downloadId (velocidad en bytes/s y tiempo restante) usando EMA.
 */
export class SpeedTracker {
  private trackers = new Map<number, SpeedTrackerEntry>();
  private readonly emaAlpha: number;
  private readonly minTimeDelta: number;

  constructor(alpha = 0.3, minTimeDelta = 0.1) {
    this.emaAlpha = alpha;
    this.minTimeDelta = minTimeDelta;
  }

  /**
   * Asegura que la descarga esté siendo trackeada. Si se reanuda una descarga, pasar
   * initialDownloadedBytes (total ya descargado) para evitar un pico de velocidad en el
   * primer cálculo (bytesDelta sería todo el histórico en vez del incremento reciente).
   */
  ensureTracking(
    downloadId: number,
    sessionStartTime = Date.now(),
    initialDownloadedBytes?: number
  ): void {
    if (!this.trackers.has(downloadId)) {
      this.startTracking(downloadId, sessionStartTime, initialDownloadedBytes);
    }
  }

  startTracking(
    downloadId: number,
    sessionStartTime = Date.now(),
    initialDownloadedBytes?: number
  ): void {
    const initial = Math.max(0, initialDownloadedBytes ?? 0);
    this.trackers.set(downloadId, {
      sessionStartTime,
      sessionDownloaded: 0,
      lastUpdate: Date.now(),
      lastDownloaded: initial,
      emaSpeed: 0,
      emaRemainingTime: null,
      alpha: this.emaAlpha,
    });
  }

  update(
    downloadId: number,
    downloadedBytes: number,
    totalBytes: number
  ): SpeedUpdateResult | null {
    const tracker = this.trackers.get(downloadId);
    if (!tracker) return null;

    const now = Date.now();
    const timeDelta = (now - tracker.lastUpdate) / 1000;
    const bytesDelta = downloadedBytes - tracker.lastDownloaded;

    let instantSpeedBytesPerSec = 0;
    if (timeDelta >= this.minTimeDelta && bytesDelta >= 0) {
      instantSpeedBytesPerSec = bytesDelta / timeDelta;
    }

    if (bytesDelta > 0 || timeDelta >= this.minTimeDelta) {
      tracker.lastUpdate = now;
      tracker.lastDownloaded = downloadedBytes;
      if (bytesDelta > 0) {
        tracker.sessionDownloaded += bytesDelta;
      }
    }

    let speedBytesPerSec = 0;
    if (instantSpeedBytesPerSec > 0) {
      if (tracker.emaSpeed === 0) {
        tracker.emaSpeed = instantSpeedBytesPerSec;
        speedBytesPerSec = instantSpeedBytesPerSec;
      } else {
        tracker.emaSpeed =
          tracker.alpha * instantSpeedBytesPerSec + (1 - tracker.alpha) * tracker.emaSpeed;
        speedBytesPerSec = tracker.emaSpeed;
      }
    } else if (tracker.emaSpeed > 0) {
      const totalElapsed = (now - tracker.sessionStartTime) / 1000;
      if (totalElapsed > 0 && tracker.sessionDownloaded > 0) {
        const avgSpeed = tracker.sessionDownloaded / totalElapsed;
        speedBytesPerSec = Math.min(tracker.emaSpeed, avgSpeed);
      } else {
        speedBytesPerSec = tracker.emaSpeed;
      }
    } else {
      const totalElapsed = (now - tracker.sessionStartTime) / 1000;
      if (totalElapsed >= this.minTimeDelta && tracker.sessionDownloaded > 0) {
        speedBytesPerSec = tracker.sessionDownloaded / totalElapsed;
        tracker.emaSpeed = speedBytesPerSec;
      }
    }

    const remainingBytes = totalBytes - downloadedBytes;
    let remainingTime: number | null = null;
    if (speedBytesPerSec > 0 && remainingBytes > 0) {
      const instantRemainingTime = remainingBytes / speedBytesPerSec;
      if (isFinite(instantRemainingTime) && instantRemainingTime >= 0) {
        if (tracker.emaRemainingTime === null || tracker.emaRemainingTime === 0) {
          tracker.emaRemainingTime = instantRemainingTime;
          remainingTime = instantRemainingTime;
        } else {
          tracker.emaRemainingTime =
            tracker.alpha * instantRemainingTime + (1 - tracker.alpha) * tracker.emaRemainingTime;
          remainingTime =
            isFinite(tracker.emaRemainingTime) && tracker.emaRemainingTime >= 0
              ? tracker.emaRemainingTime
              : instantRemainingTime;
        }
      }
    }

    return { speedBytesPerSec, remainingTime };
  }

  stopTracking(downloadId: number): void {
    this.trackers.delete(downloadId);
  }

  clear(): void {
    this.trackers.clear();
  }
}

const speedTracker = new SpeedTracker();
export default speedTracker;
