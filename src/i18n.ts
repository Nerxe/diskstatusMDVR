import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Dictionaries
const resources = {
  es: {
    translation: {
      "title": "DiskStatus MDVR",
      "subtitle": "Dashboard de Monitoreo",
      "tab_dashboard": "Dashboard",
      "tab_records": "Registros",
      "tab_corrective": "Seguimiento Correctivo",
      "tab_general": "Seguimiento General",
      "loading": "Cargando Datos...",
      "loading_desc": "Procesando información de almacenamiento MDVR",
      "error_loading": "Error al Cargar Datos",
      "error_desc": "No se pudo cargar la base de datos. Verifique que el archivo CSV esté disponible.",
      "retry": "Reintentar",
      
      "all": "Todos",
      "fleet": "Flota",
      "severity": "Severidad",
      "component": "Componente",
      "platform": "Plataforma",
      "model": "Modelo",
      "date_range": "Rango de Fechas",
      "start_date": "Fecha Inicio",
      "end_date": "Fecha Fin",
      "clear_filters": "Limpiar Filtros",
      "search_placeholder": "Buscar...",
      "select": "Seleccionar",
      
      "kpi_total": "Total Equipos",
      "kpi_l1": "L1 - Reemplazo Físico",
      "kpi_l2": "L2 - Revisión Config",
      "kpi_l3": "L3 - Mante. Lógico",
      "alerts": "alertas",
      "chart_top_fleets": "Flotas con Mayor Incidencia",
      
      "severity_alta": "Alta",
      "severity_media": "Media",
      "severity_baja": "Baja",
      "action_replace": "Reemplazo Físico",
      "action_review": "Revisión Config/Instalación",
      "action_logical": "Mantenimiento Lógico",
      "action_investigation": "Investigación",
      "disk_ssd": "SSD/HDD",
      "disk_sd": "SD/Firebox",
      "disk_other": "Otros",

      "th_plate": "Equipo",
      "th_l1": "Fallas L1",
      "th_work": "Trabajo",
      "th_status": "Estado",
      "th_device": "Dispositivo",
      "th_detail": "Detalle Error",
      "th_diagnosis": "Diagnóstico",
      "th_severity": "Severidad",
      "th_action": "Acción",
      "th_equipment_fleet": "Equipo / Flota",
      "th_total_alerts": "Total Alertas",
      "th_main_diagnosis": "Diagnóstico Principal (Peor Caso)",
      "th_max_severity": "Severidad Max",
      "th_suggested_action": "Acción Sugerida",

      "results_local": "Resultados Locales",
      "showing": "Mostrando",
      "of": "de",
      "page": "Página",
      "previous": "Anterior",
      "next": "Siguiente"
    }
  },
  en: {
    translation: {
      "title": "DiskStatus MDVR",
      "subtitle": "Monitoring Dashboard",
      "tab_dashboard": "Dashboard",
      "tab_records": "Records",
      "tab_corrective": "Corrective Tracking",
      "tab_general": "General Tracking",
      "loading": "Loading Data...",
      "loading_desc": "Processing MDVR storage information",
      "error_loading": "Data Loading Error",
      "error_desc": "Could not load the database. Please verify the CSV file is available.",
      "retry": "Retry",
      
      "all": "All",
      "fleet": "Fleet",
      "severity": "Severity",
      "component": "Component",
      "platform": "Platform",
      "model": "Model",
      "date_range": "Date Range",
      "start_date": "Start Date",
      "end_date": "End Date",
      "clear_filters": "Clear Filters",
      "search_placeholder": "Search...",
      "select": "Select",
      
      "kpi_total": "Total Devices",
      "kpi_l1": "L1 - Physical Replace",
      "kpi_l2": "L2 - Config Review",
      "kpi_l3": "L3 - Logical Maint.",
      "alerts": "alerts",
      "chart_top_fleets": "Top Fleets with Errors",
      
      "severity_alta": "High",
      "severity_media": "Medium",
      "severity_baja": "Low",
      "action_replace": "Physical Replacement",
      "action_review": "Config/Installation Review",
      "action_logical": "Logical Maintenance",
      "action_investigation": "Investigation",
      "disk_ssd": "SSD/HDD",
      "disk_sd": "SD/Firebox",
      "disk_other": "Others",

      "th_plate": "Device ID",
      "th_l1": "L1 Failures",
      "th_work": "Work Type",
      "th_status": "Status",
      "th_device": "Device",
      "th_detail": "Error Detail",
      "th_diagnosis": "Diagnosis",
      "th_severity": "Severity",
      "th_action": "Action",
      "th_equipment_fleet": "Device / Fleet",
      "th_total_alerts": "Total Alerts",
      "th_main_diagnosis": "Main Diagnosis (Worst Case)",
      "th_max_severity": "Max Severity",
      "th_suggested_action": "Suggested Action",

      "results_local": "Local Results",
      "showing": "Showing",
      "of": "of",
      "page": "Page",
      "previous": "Previous",
      "next": "Next"
    }
  },
  zh: {
    translation: {
      "title": "DiskStatus MDVR",
      "subtitle": "监控仪表板",
      "tab_dashboard": "仪表板",
      "tab_records": "警报记录",
      "tab_corrective": "纠正跟踪",
      "tab_general": "综合跟踪",
      "loading": "加载数据中...",
      "loading_desc": "处理 MDVR 存储信息中",
      "error_loading": "数据加载错误",
      "error_desc": "无法加载数据库。请确认 CSV 文件可用。",
      "retry": "重试",
      
      "all": "全部",
      "fleet": "车队",
      "severity": "严重程度",
      "component": "组件",
      "platform": "平台",
      "model": "型号",
      "date_range": "日期范围",
      "start_date": "开始日期",
      "end_date": "结束日期",
      "clear_filters": "清除筛选",
      "search_placeholder": "搜索...",
      "select": "选择",
      
      "kpi_total": "总设备数",
      "kpi_l1": "L1 - 物理更换",
      "kpi_l2": "L2 - 配置检查",
      "kpi_l3": "L3 - 逻辑维护",
      "alerts": "警报",
      "chart_top_fleets": "错误最多的车队",
      
      "severity_alta": "高",
      "severity_media": "中",
      "severity_baja": "低",
      "action_replace": "物理更换",
      "action_review": "配置/安装检查",
      "action_logical": "逻辑维护",
      "action_investigation": "调查",
      "disk_ssd": "固态/机械硬盘",
      "disk_sd": "SD/防火盒",
      "disk_other": "其他",

      "th_plate": "设备",
      "th_l1": "L1 故障",
      "th_work": "工作",
      "th_status": "状态",
      "th_device": "设备",
      "th_detail": "错误详情",
      "th_diagnosis": "诊断",
      "th_severity": "严重程度",
      "th_action": "操作",
      "th_equipment_fleet": "设备 / 车队",
      "th_total_alerts": "总警报数",
      "th_main_diagnosis": "主要诊断（最坏情况）",
      "th_max_severity": "最大严重程度",
      "th_suggested_action": "建议操作",

      "results_local": "本地结果",
      "showing": "显示",
      "of": "的",
      "page": "页",
      "previous": "上一页",
      "next": "下一页"
    }
  }
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: "es", // idioma por defecto
    fallbackLng: "en",
    interpolation: {
      escapeValue: false // react ya protege de xss
    }
  });

export default i18n;
