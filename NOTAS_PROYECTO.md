# Notas del Proyecto: Reproductor MP3

## Información General
- **Descripción:** Un reproductor de música MP3 basado en web (Progressive Web App).
- **Tecnologías principales:**
  - HTML5 (Estructura en `index.html`)
  - CSS3 (Estilos en `styles.css`)
  - JavaScript Vanilla (Lógica en `app.js`)
  - Funcionalidad PWA (Definida en `manifest.json` y manejada mediante Service Workers si corresponde).

## Estado Actual
- **Versión 1.1:** La aplicación funciona como PWA offline: el Service Worker guarda la interfaz localmente y la biblioteca sigue viviendo en IndexedDB.
- Implementada la lógica de IndexedDB para almacenamiento persistente de archivos de audio locales.
- Implementado controles de velocidad, adelanto/retroceso de 15 segundos y memoria de posición en la que se dejó el audio.
- Solucionados los bugs de reproducción en segundo plano específicos de iOS.

- **Versión 5 (nov 2026):** posición recordada por cada audio, avance visible en la biblioteca («12:30 de 32:29», «✓ Escuchado»), reemplazo de lecturas regeneradas con el mismo título (conserva marcas), velocidades finas (0.8x–2.0x), ±15 s en pantalla bloqueada (sin pista anterior/siguiente), `setPositionState` para la barra de la pantalla bloqueada, almacenamiento persistente con espacio usado, y **frases marcadas** con botón para copiarlas. Al terminar un audio sigue con el siguiente no escuchado y se detiene al final.

- **Versión 6 (nov 2026):** botón «⇅ Ordenar» en la biblioteca: flechas ▲▼ para cambiar el orden, que se guarda en el teléfono y es el orden en que se reproduce.

## Tareas Pendientes (TODO)
- [x] Revisión del código en `app.js` para organizar funciones.
- [x] Validar que la interfaz sea totalmente responsiva mediante `styles.css` (Glassmorphism oscuro implementado).
- [x] Probar la persistencia o instalación PWA comprobando el `manifest.json`.
- [x] Implementación offline usando un Service Worker para el app shell.
- [x] Controles de pantalla bloqueada/auriculares mediante Media Session API cuando el navegador lo soporta.
- [x] Eliminación individual de pistas, prevención de duplicados y mensajes de errores de almacenamiento/reproducción.

## Estructura de Archivos (Referencia)
- `index.html`: La vista principal del reproductor.
- `app.js`: Contiene toda la lógica de reproducción, manejo de eventos de la interfaz y probablemente la carga de archivos.
- `styles.css`: Todos los estilos para la interfaz del usuario.
- `manifest.json`: Configuración de la aplicación web progresiva y definición de iconos.
- `icon-192.png` / `icon-512.png`: Iconos para la instalación PWA.

## Ideas a Futuro (Backlog)
- Controles multimedia desde notificaciones si estuviese minimizado en móvil (mediante Media Session API).
- Mostrar espacio utilizado/disponible de la biblioteca local.
- Permitir reordenar la biblioteca o crear listas de reproducción.

## Notas Técnicas y Problemas Solucionados (iOS Safari)
- **Visualizador de Audio:** Añadir un ecualizador en tiempo real usando Web Audio API (`AudioContext`) en iOS causa que el audio se corte en el instante en que el teléfono se bloquea o la app pasa a segundo plano. Además genera un bucle al pausar la música. Por lo tanto, el reproductor debe mantenerse usando la etiqueta nativa `<audio>` puro.
- **Restauración de Tiempo (`currentTime`):** En iOS, al tratar de restaurar el minuto exacto del audio guardado, se debe hacer _después_ de que se dispara el evento `loadedmetadata`, de lo contrario el navegador ignora el salto de tiempo y empieza el track desde cero.

## Recursos e Inspiración
- *(Añade aquí enlaces a recursos de diseño, librerías, foros, o documentación consultados)*

---
*Nota: Este archivo sirve como bitácora y registro vivo del proyecto. Actualízalo frecuentemente a medida que se desarrolla el Reproductor MP3.*
