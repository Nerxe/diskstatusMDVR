-- ============================================================
-- FIX: Auto-refresco de Vistas Materializadas en Supabase
-- ============================================================
-- PROBLEMA: Las vistas materializadas (view_device_summary,
-- view_daily_trends) son "snapshots" que NO se actualizan
-- automáticamente cuando se insertan, borran o modifican
-- datos en la tabla raw_alarms.
--
-- SOLUCIÓN: Este script crea una Función + Trigger que
-- automáticamente llama a REFRESH MATERIALIZED VIEW cada vez
-- que ocurre un cambio en raw_alarms.
--
-- ⚠️  ADVERTENCIA: Para tablas con millones de filas, el
-- refresh puede ser lento. Considera usar REFRESH CONCURRENTLY
-- (requiere UNIQUE INDEX en la vista materializada).
-- ============================================================

-- 1. Asegurarse de que la función refresh_dashboard_views exista
--    (si ya la tienes, este bloque es un NO-OP)
CREATE OR REPLACE FUNCTION refresh_dashboard_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW view_device_summary;
    REFRESH MATERIALIZED VIEW view_daily_trends;
END;
$$;

-- Dar permisos de ejecución al rol anon y authenticated
GRANT EXECUTE ON FUNCTION refresh_dashboard_views() TO anon;
GRANT EXECUTE ON FUNCTION refresh_dashboard_views() TO authenticated;

-- ============================================================
-- 2. (OPCIONAL) Trigger para auto-refrescar al modificar raw_alarms
--    ADVERTENCIA: Esto puede ser caro en tablas grandes.
--    Solo habilitar si los datos cambian infrecuentemente.
-- ============================================================

-- 2a. Función trigger para actualizar las vistas materializadas
CREATE OR REPLACE FUNCTION trigger_refresh_dashboard_views()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
AS $$
BEGIN
    -- Refrescamos las vistas directamente
    REFRESH MATERIALIZED VIEW view_device_summary;
    REFRESH MATERIALIZED VIEW view_daily_trends;
    RETURN NULL; -- RETURN NULL es válido para triggers AFTER del tipo STATEMENT
END;
$$;

-- 2b. Trigger en raw_alarms
DROP TRIGGER IF EXISTS trg_refresh_on_raw_alarms ON raw_alarms;
CREATE TRIGGER trg_refresh_on_raw_alarms
    AFTER INSERT OR UPDATE OR DELETE ON raw_alarms
    FOR EACH STATEMENT
    EXECUTE FUNCTION trigger_refresh_dashboard_views();

-- ============================================================
-- 3. Verificar que las vistas materializadas existen
--    y tienen índices únicos necesarios para CONCURRENTLY
-- ============================================================

-- Si CONCURRENTLY falla, agregar estos índices:
-- CREATE UNIQUE INDEX CONCURRENTLY idx_vds_unique ON view_device_summary(device_name, device_id_code, month_number, component, action, severity, level);
-- CREATE UNIQUE INDEX CONCURRENTLY idx_vdt_unique ON view_daily_trends(alarm_date, fleet, level, severity);

-- ============================================================
-- 4. Refresco manual inmediato (ejecutar esto ahora)
-- ============================================================
SELECT refresh_dashboard_views();
