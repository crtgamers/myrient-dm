# Migración (referencia histórica)

El módulo **queueDatabase** y el script de migración **queueToStateStore** fueron eliminados. La cola de descargas usa únicamente **StateStore** (`electron/engines/StateStore.ts`).

- **Estado actual:** No existe script de migración desde el sistema legacy (downloads.db / QueueDatabase). Las instalaciones que ya usan StateStore no se ven afectadas.
- **Actualizaciones desde versiones muy antiguas:** Si alguien tenía una versión que solo usaba QueueDatabase (downloads.db), esa ruta de actualización ya no está soportada en código; habría que restaurar el script y queueDatabase desde el historial de versiones si en el futuro se requiriera de nuevo.

Ver [docs/QUEUE-LEGACY.md](../../docs/QUEUE-LEGACY.md) para el contexto cola vs legacy.
