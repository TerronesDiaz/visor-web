# Arranque de Terrones POS

La ventana principal contiene una vista local de preparación sobre la vista del POS. La presentación se retira después de cargar y pintar el POS; reintentos, errores y cambios de tienda reutilizan la misma ventana. Un segundo proceso activa la instancia existente. Los mensajes periódicos no cambian el foco.

Docker se reutiliza si su motor responde. Cuando está detenido, se conserva su configuración y se cambia únicamente `OpenUIOnStartupDisabled` (o la clave heredada), antes de ejecutar `docker desktop start --detach` con consola oculta. Se necesita una versión de Docker Desktop que incluya ese comando.

## Verificación

- `npm test`: comportamiento de ventanas, reintentos, cierre, arranque de Docker y pruebas existentes.
- Ejecutar `tests/window-smoke.cjs` con Electron y sin `ELECTRON_RUN_AS_NODE`. Usa un servidor de prueba y un directorio de usuario aislado; no inicia Docker ni modifica tiendas. Guarda resultados y capturas en `runtime/window-smoke`.
- Para verificar los módulos empaquetados, establecer `TERRONES_SMOKE_MODULE_ROOT` a la ruta absoluta de `resources/app.asar` antes de ejecutar la misma prueba con Electron.
- En el repositorio del POS, `installer/Test-HiddenTaskMigration.ps1` verifica la migración con tareas simuladas. `installer/Test-HiddenWorker.ps1` verifica el subsistema GUI, ausencia de consola, argumentos y códigos de salida del ejecutable real.

## Distribución y actualización

El kit y el ZIP del POS construyen `Terrones.HiddenWorker.exe` durante el empaquetado. `TERRONES_CODE_SIGNING_THUMBPRINT` permite firmarlo con un certificado del almacén del publicador. Las cajas reciben el binario dentro del paquete; no compilan código. El registro de las tareas instala el auxiliar y cambia sus acciones conservando los horarios, usuarios y permisos existentes.

Para una caja existente se requiere ejecutar el instalador actualizado o `deploy/local/updater/Install-HiddenWorker.ps1` desde el paquete completo con los permisos de administración correspondientes. El actualizador periódico utiliza `SkipUpdaterRegistration`: actualizar únicamente el visor o copiar el código no migra las tareas de Windows.

El bloqueo inicial del antivirus quedó resuelto al repetir la prueba: `Test-HiddenWorker.ps1` pasó con el ejecutable real, verificando subsistema GUI, PowerShell sin consola, argumentos con espacios, código de salida y registro del error. También se generó el auxiliar con `Build-HiddenWorker.ps1` en `runtime/hidden-worker` del visor. No se migraron tareas reales.

La publicación usa el secreto `TERRONES_UPDATE_SIGNING_PRIVATE_XML` existente en GitHub Actions para firmar el catálogo y el feed; no requiere copiar la clave a la computadora de desarrollo. El paquete local de prueba no es un instalador distribuible. La verificación obligatoria del catálogo en producción sigue activa.

Pasaron 29 pruebas del visor, el flujo de ventana única/reintento/cierre sobre los módulos empaquetados, la prueba real del auxiliar y la migración con tareas simuladas. El arranque completo con servicios reales, la impresión física y los ciclos reales de respaldo/actualización requieren validación en una caja. La publicación ofrece la actualización; no la instala automáticamente en las cajas.
