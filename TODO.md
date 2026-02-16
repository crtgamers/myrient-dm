# Roadmap de Funcionalidades Futuras

## Myrient Download Manager – Especificación Detallada

**Proyecto:** Myrient Download Manager  
**Estado:** Planificación / Implementación futura

## 1. Wizard de Configuración Inicial (First Run Wizard)

### Objetivo

Mejorar la experiencia del usuario en el primer inicio del programa, evitando configuraciones confusas o valores por defecto poco claros.

### Descripción

Al ejecutar el programa por primera vez, debe mostrarse un wizard de configuración guiado que permita definir los parámetros básicos del sistema.

### Parámetros a configurar

#### Apariencia

- Tema (claro / oscuro).
- Colores principales o presets.

#### Descargas

- Carpeta principal de descargas.
- Cantidad máxima de descargas simultáneas.
- Configuración inicial de chunks.

#### Comportamiento

- Inicio automático de descargas.
- Confirmaciones al agregar múltiples archivos.

### Consideraciones adicionales

- El wizard debe poder omitirse.
- Debe existir una opción para volver a ejecutar el wizard desde el menú de configuración.
- El wizard no debe bloquear el uso posterior del programa si se cancela.

---

## 2. Sistema de Tutorial Interactivo

### Objetivo

Reducir la curva de aprendizaje del programa y facilitar la comprensión de sus funciones principales.

### Descripción

Crear un tutorial interactivo que explique visualmente el uso del programa, enfocado en acciones concretas y no en documentación extensa.

### Contenido del tutorial

- Explicación del menú principal y sus secciones.
- Cómo agregar descargas individuales y múltiples.
- Uso del sistema de búsqueda.
- Navegación por carpetas y archivos.

### Implementación

- El tutorial debe ser:
  - breve,
  - visual,
  - paso a paso.
- Puede utilizar:
  - tooltips,
  - resaltado de botones,
  - mensajes contextuales.
- Debe poder ejecutarse nuevamente desde un botón accesible en el menú o configuración.

---

## 3. Sistema de Filtros Avanzados para Navegación de Archivos

### Objetivo

Mejorar la exploración de grandes volúmenes de archivos y carpetas, permitiendo encontrar contenido específico de forma rápida y clara.

### Descripción

Agregar una sección de filtros visible al navegar por carpetas que contengan archivos.

### Funcionalidades de filtros

- Filtrado por etiquetas presentes en el nombre del archivo, especialmente aquellas entre paréntesis.
- Ejemplos:
  - Región: `(JPN)`, `(JP)`, `(USA)`, `(US)`, `(EUR)`, `(EU)`
- Agrupación automática de variantes equivalentes.

### Normalización

- Crear un sistema interno de normalización de etiquetas:
  - `JP` = `JPN`
  - `US` = `USA`
  - `EU` = `EUR`
- Evitar depender exclusivamente del texto literal del nombre del archivo.

### Consideraciones UI/UX

- Filtros activables y desactivables fácilmente.
- Posibilidad de combinar múltiples filtros.
- Visualización clara de filtros activos.

---

## 4. Glosario de Términos y Etiquetas

### Objetivo

Ayudar al usuario a entender el significado de términos técnicos o poco comunes presentes en los nombres de archivos.

### Descripción

Crear una sección dedicada a explicar los términos más comunes utilizados en las bases de datos y nombres de archivos.

### Ejemplos de términos

- Aftermarket
- Rev
- Split
- Merge
- Region
- Multi-X
- Pirate
- Bootleg

### Funcionalidades

- Descripción clara y simple de cada término.
- Posibilidad de acceder al glosario:
  - desde el menú principal,
  - desde los filtros,
  - mediante íconos de ayuda contextual (`?`).

---

## 5. Sección Informativa de Emuladores

### Objetivo

Ofrecer al usuario información centralizada sobre emuladores compatibles con el contenido descargable, sin convertir inicialmente al programa en un launcher.

### Descripción

Agregar una sección informativa dedicada a emuladores, organizada de forma clara y accesible.

### Clasificación

- Multi-emuladores.
- Emuladores standalone.

### Información por emulador

- Nombre del emulador.
- Breve descripción.
- Sistemas o ROMs compatibles.
- Página web oficial.
- Enlace de descarga.
- Última versión estable o compilada disponible.

### Alcance inicial

- La sección debe ser únicamente informativa.
- No debe integrarse directamente con la ejecución de ROMs en etapas tempranas.
- Pensada como base para futuras integraciones más avanzadas.

---

## 6. Soporte para Múltiples Idiomas (i18n) —  Implementado (v1.3.0)

### Objetivo

Permitir que la aplicación pueda usarse en más de un idioma, mejorando la accesibilidad para usuarios no hispanohablantes.

### Estado (1.3.0)

- **Implementado:** Español como idioma principal (por defecto), inglés (en) y español de Chile (es-CL). Más de 360 claves en `src/locales/{en,es,es-CL}/common.json`. Toda la UI visible usa vue-i18n (`t()` / `$t()`).
- **Validaciones:** `npm run validate-locales` (mismas keys en todos los idiomas) y `npm run validate-i18n-keys` (keys usadas en código existan en en). CI ejecuta ambos en cada push/PR.
- **Documentación:** CONTRIBUTING.md explica cómo añadir un idioma y las reglas de keys. Tipado fuerte de keys (MessageSchema) y fallback en cadena (es-CL → es → en).
- **Próximos pasos opcionales:** Añadir más idiomas siguiendo CONTRIBUTING; revisión manual de layout en distintos idiomas (QA).

---

## Principios Generales de Implementación

- Todas las funcionalidades deben diseñarse de forma modular.
- Las mejoras no deben afectar el flujo básico del programa.
- Priorizar estabilidad, claridad y escalabilidad.
- Las funciones avanzadas deben ser opcionales y no intrusivas.
