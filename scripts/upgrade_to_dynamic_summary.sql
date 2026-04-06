-- ============================================================
-- FIX: Selección Multi-Año y Fechas Personalizadas Reales
-- ============================================================
-- PROBLEMA: view_device_summary agrupa estrictamente por mes
-- (sin año), por lo que mezclaría datos de Marzo 2025 y Marzo 2026.
-- Además, si el usuario elige un rango del 1 al 15 de un mes, 
-- la vista materializada solo le puede devolver el mes completo.
--
-- SOLUCIÓN: Agregación dinámica a demanda vía Función RPC parametrizada.
-- Postgres agrupará al vuelo usando los índices de fecha, permitiendo
-- exactitud sin desbordar la memoria del Frontend.
--
-- ⚠️ Ejecutar esto en el SQL Editor de Supabase
-- ============================================================

CREATE OR REPLACE FUNCTION get_device_summary_custom(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
    device_name TEXT,
    device_id_code TEXT,
    fleet TEXT,
    component TEXT,
    action TEXT,
    severity TEXT,
    level TEXT,
    diagnosis TEXT,
    disk_details TEXT,
    total_alerts BIGINT,
    latest_alarm timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
    SELECT 
        device_name,
        device_id_code,
        fleet,
        component,
        action,
        severity,
        level,
        COALESCE(diagnosis, 'Consolidado General') as diagnosis,
        MAX(start_details) as disk_details,
        COUNT(*) AS total_alerts,
        MAX(begin_time) AS latest_alarm
    FROM raw_alarms
    WHERE begin_time >= p_from AND begin_time <= p_to
    GROUP BY 
        device_name,
        device_id_code,
        fleet,
        component,
        action,
        severity,
        level,
        diagnosis;
$$;

GRANT EXECUTE ON FUNCTION get_device_summary_custom(timestamptz, timestamptz) TO anon;
GRANT EXECUTE ON FUNCTION get_device_summary_custom(timestamptz, timestamptz) TO authenticated;
