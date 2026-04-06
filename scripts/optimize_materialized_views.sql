-- ============================================================
-- OPTIMIZACIÓN: Índices en Vistas Materializadas
-- ============================================================
-- PROBLEMA: Las queries SELECT contra view_device_summary y
-- view_daily_trends exceden el statement timeout de Supabase
-- (8s por defecto en plan Free) porque las vistas no tienen
-- índices en las columnas filtradas (month_number, alarm_date).
--
-- SOLUCIÓN: Crear índices en las columnas de filtro y aumentar
-- el timeout del rol authenticated/anon a 30s.
--
-- ⚠️  Ejecutar este script en el Editor SQL de Supabase.
-- ============================================================

-- 1. Índice en view_device_summary para filtrado por month_number
CREATE INDEX IF NOT EXISTS idx_vds_month
    ON view_device_summary (month_number);

-- 2. Índice en view_daily_trends para filtrado por alarm_date
CREATE INDEX IF NOT EXISTS idx_vdt_alarm_date
    ON view_daily_trends (alarm_date);

-- 3. (Opcional) Índice compuesto para queries más complejas
CREATE INDEX IF NOT EXISTS idx_vds_month_fleet
    ON view_device_summary (month_number, fleet);

-- ============================================================
-- 4. Aumentar statement timeout para roles anon/authenticated
--    De 8s (default) a 30s - suficiente para SELECT en vistas
--    pero no tanto como para bloquear la conexión
-- ============================================================
ALTER ROLE authenticated SET statement_timeout = '30s';
ALTER ROLE anon SET statement_timeout = '30s';

-- ============================================================
-- 5. Verificar que los índices se crearon correctamente
-- ============================================================
-- Ejecutar después de los CREATE INDEX:
-- SELECT indexname, tablename FROM pg_indexes
-- WHERE tablename IN ('view_device_summary', 'view_daily_trends');
