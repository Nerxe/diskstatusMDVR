-- ============================================================
-- Discovery Function: get_available_months()
-- ============================================================
-- Query rápida contra raw_alarms para descubrir qué año+mes
-- tienen datos, con conteo de registros y rango de fechas.
-- Se usa para la pantalla de selección pre-carga del dashboard.
-- ============================================================

CREATE OR REPLACE FUNCTION get_available_months()
RETURNS TABLE(
    alarm_year int,
    alarm_month int,
    record_count bigint,
    earliest_date timestamptz,
    latest_date timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout = '15s'
AS $$
    SELECT
        EXTRACT(YEAR FROM begin_time)::int AS alarm_year,
        EXTRACT(MONTH FROM begin_time)::int AS alarm_month,
        COUNT(*) AS record_count,
        MIN(begin_time) AS earliest_date,
        MAX(begin_time) AS latest_date
    FROM raw_alarms
    GROUP BY alarm_year, alarm_month
    ORDER BY alarm_year, alarm_month;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION get_available_months() TO anon;
GRANT EXECUTE ON FUNCTION get_available_months() TO authenticated;

-- ============================================================
-- Verificar que funciona:
-- SELECT * FROM get_available_months();
-- ============================================================
