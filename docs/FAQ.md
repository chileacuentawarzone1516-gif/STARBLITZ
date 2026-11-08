# Preguntas frecuentes

## ¿Mis páginas salen de mi equipo?
No. La traducción se ejecuta en tu dispositivo, sin cuentas ni telemetría. Lo único que sale a Internet es la descarga
de modelos que tú pides (Hugging Face; el detector, desde su publicación en GitHub). Excepción: si configuras tú un
servidor de lenguaje remoto (Ollama, LM Studio u otro compatible con OpenAI), las páginas se envían a ese servidor.

## ¿Funciona sin Internet?
Sí, una vez descargados los modelos. Hace falta Internet solo para descargarlos.

## ¿Qué formatos puedo importar y exportar?
Importar: ZIP, CBZ, PDF, JPG, PNG y WEBP (hasta 50 páginas por proyecto, ajustable). Exportar: PDF, ZIP, JPG, PNG o WEBP.

## ¿Qué plataformas se soportan?
Windows 10 21H2 / 11 x64 y Android 9+ arm64. Ver [INSTALACION](INSTALACION.md).

## ¿Necesito una tarjeta gráfica?
No: funciona en CPU, más lento. Con una GPU compatible con Vulkan/DirectX 12 (≥ 6 GB de VRAM para un modelo de 9 B) en
Windows el procesamiento es más rápido. En Android la traducción usa solo CPU.

## ¿Qué idiomas de origen funcionan?
El japonés se probó con páginas reales. Chino, coreano, inglés y lenguas latinas están integrados (PP-OCR) pero no
evaluados con páginas reales. El destino es español latinoamericano neutro o de España.

## ¿Qué modelos de lenguaje usa?
El que elijas en **Modelos**; la app recomienda uno según tu RAM y GPU (por ejemplo, Qwen 3.5 o Gemma 4 en GGUF). Ver
[MODELOS](MODELOS.md). Cada modelo tiene su propia licencia, que la app muestra antes de instalar.

## ¿Por qué una traducción sale mal?
Los modelos pequeños (2–4 B) fallan más con argot y juegos de palabras. STARBLITZ marca las líneas dudosas para
revisión y no sobrescribe lo que apruebas o editas. No sustituye la revisión humana. Ver [LIMITACIONES](LIMITACIONES.md).

## ¿Dónde se guardan mis proyectos?
En Windows instalado: `%APPDATA%\STARBLITZ`; en la versión portátil: la carpeta `data` junto al ejecutable. En Android:
almacenamiento privado de la app.

## Windows muestra un aviso de SmartScreen
El ejecutable no está firmado digitalmente. Elige «Más información → Ejecutar de todas formas» solo si lo descargaste de
una Release oficial y su SHA-256 coincide con `SHA256SUMS.txt`.

## ¿Está validado en equipos reales?
Todavía no. El código está completo y probado con pruebas automáticas, pero las pruebas en hardware real están
**pendientes**. Ver [PRUEBAS-HARDWARE](PRUEBAS-HARDWARE.md) y [ROADMAP](ROADMAP.md).

## ¿Con qué licencia se distribuye?
Está pendiente de confirmación por el titular. Las licencias de modelos y componentes de terceros están en
[LICENCIAS-TERCEROS](LICENCIAS-TERCEROS.md).
