# DiskStatus MDVR — Dashboard de Monitoreo

Dashboard interactivo para el monitoreo y seguimiento del estado de discos duros en equipos MDVR (Mobile Digital Video Recorder). Permite visualizar alarmas de disco, realizar seguimiento de mantenimiento preventivo y generar reportes PDF.

## Características

- **Registros de Alarmas** — Visualización y filtrado de alarmas de disco por equipo, flota y severidad
- **Seguimiento General** — Tracking del estado de mantenimiento de cada unidad con tipos de trabajo (Cambio, Formateo, Configuración)
- **Gráficos de Tendencia** — Visualización de tendencias mensuales con Recharts
- **Generación de PDF** — Exportación de órdenes de trabajo en formato PDF
- **Backup/Restore** — Exportación e importación de datos de seguimiento en JSON
- **Modo Oscuro** — Interfaz con soporte para tema claro y oscuro

## Tecnologías

- **React 19** + **TypeScript**
- **Vite 7** — Bundler y servidor de desarrollo
- **Tailwind CSS 4** — Estilos utilitarios
- **Recharts** — Gráficos y visualizaciones
- **PapaParse** — Parsing de archivos CSV
- **jsPDF** — Generación de documentos PDF
- **Day.js** — Manipulación de fechas
- **Lucide React** — Iconografía

## Instalación

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

## Datos CSV

La aplicación requiere archivos CSV en la carpeta `public/`:

| Archivo | Descripción |
|---------|-------------|
| `diskAlarm_<Mes>.csv` | Registros de alarmas de disco por mes |
| `mdvrDetailsPvModel.csv` | Detalles de equipos MDVR y modelos |
| `mdvrVideotracklogAll.csv` | Registro de tracklog de video |

> **Nota:** Los archivos `diskAlarm_*.csv` son muy grandes y están excluidos del repositorio vía `.gitignore`. Deben obtenerse por separado.

## Build de Producción

```bash
npm run build
npm run preview
```

## Licencia

Proyecto privado — Uso interno.
