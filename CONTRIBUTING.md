# Guía para contribuir

Gracias por tu interés en contribuir a **Myrient Download Manager**. Este documento resume lo que necesitas saber para enviar cambios, con especial atención a la **internacionalización (i18n)**.

---

## Antes de abrir un PR

- **Estilo de código:** el proyecto usa ESLint y Prettier. Ejecuta `npm run lint` y `npm run format:check`. Opcional: `npm run format` para formatear.
- **Tipos y tests:** `npm run typecheck:all` y `npm run test:unit` (y `npm run test:integration` si aplica).
- **Si tocas traducciones o textos de la UI:** ejecuta las validaciones i18n (ver más abajo). El CI también las ejecuta y el PR fallará si no pasan.
- **Exports no usados:** de forma opcional o en CI se puede ejecutar `npx ts-prune` o `npx knip` para detectar exports muertos; ver Fase 4.3 en la auditoría.

---

## Internacionalización (i18n)

La aplicación usa **vue-i18n** con mensajes en `src/locales/`. El idioma de referencia es **inglés** (`en/common.json`).

### Cómo añadir un nuevo idioma

1. **Copia el archivo de referencia**
   - Copia `src/locales/en/common.json` a `src/locales/<código>/common.json`.
   - Usa un código de idioma coherente (ej. `es`, `es-CL`, `fr`).

2. **Traduce los valores**
   - Sustituye solo los **valores** (strings a la derecha de los `:`). No cambies las **claves** (ej. `"app.name"`, `"nav.home"`).
   - Mantén las mismas claves que en `en/common.json`.

3. **Registra el idioma en el código**
   - En `src/locales/index.ts`:
     - Añade el código al array `SUPPORTED_LOCALES`.
     - Añade la etiqueta en `LOCALE_LABELS` (nombre del idioma en su propio idioma, ej. `'Español (Chile)'`).
   - Si aplica, actualiza la lógica de `resolveSupportedLocale()` para que tu código (ej. `fr-FR`) se resuelva al nuevo locale.

4. **Valida antes de abrir el PR**
   - `npm run validate-locales` — comprueba que todos los `common.json` (es, es-CL, y el tuyo) tengan **exactamente** las mismas claves que `en/common.json`. No elimines ni añadas claves.
   - `npm run validate-i18n-keys` — comprueba que las keys usadas en el código existan en `en/common.json`. Si añadiste keys nuevas en inglés, el resto de idiomas debe tenerlas también (y `validate-locales` ya lo exige).

### Reglas importantes

- **No elimines claves** de ningún `common.json`. Si una clave deja de usarse en el código, se puede dejar el valor en inglés o traducido; la estructura debe seguir igual que en `en`.
- **No añadas claves** que no existan en `en/common.json`. Primero añade la clave en `en`, luego en el resto de idiomas.
- **Claves semánticas:** usa nombres con sentido (ej. `errors.connectionError`), no la frase literal como clave.

Si algo no queda claro, puedes abrir un issue o preguntar en el PR.

---

## Resumen de comandos útiles

| Comando | Descripción |
|--------|-------------|
| `npm run validate-locales` | Comprueba que todos los idiomas tengan las mismas keys que `en`. |
| `npm run validate-i18n-keys` | Comprueba que las keys usadas en `t()` / `$t()` existan en `en`. |
| `npm run validate-i18n-keys:orphans` | Además lista keys definidas pero no usadas como literal. |
| `npm run lint` | ESLint. |
| `npm run format:check` | Prettier (solo comprobación). |
| `npm run typecheck:all` | TypeScript + Vue. |
| `npm run test:unit` | Tests unitarios. |

---

## Licencia

Las contribuciones se incorporan al proyecto bajo la misma licencia **GPL-3.0-or-later**. Al contribuir, aceptas que tu código se distribuya bajo esa licencia.
