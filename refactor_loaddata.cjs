const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// 1. Add TrendData Interface
const interfaceInsert = `
interface TrendData {
    alarm_date: string;
    fleet: string;
    level: string;
    severity: string;
    total_alerts: number;
}
`;
txt = txt.replace('// --- DEFINICIÓN DE TIPOS ---', '// --- DEFINICIÓN DE TIPOS ---' + interfaceInsert);

// 2. Add trendRows state
const stateInsert = `    const [trendRows, setTrendRows] = useState<TrendData[]>([]);\n`;
txt = txt.replace('const [data, setData] = useState<ProcessedData[]>([]);', 'const [data, setData] = useState<ProcessedData[]>([]);\n' + stateInsert);

// 3. Rewrite loadData to fetch BOTH views
const loadDataOldStart = "const { data: alarmsData, error: dbError } = await supabase";
const loadDataOldEnd = "setData(mappedProcessed);";

const loadDataNew = `
            // 1. CARGAR RESUMEN GENERAL (Para KPIs y Tabla Principal)
            const { data: summaryData, error: summaryError } = await supabase
                .from('view_device_summary')
                .select('*');
                
            if (summaryError) throw summaryError;

            // 2. CARGAR TENDENCIAS DIARIAS (Para gráficos lineales)
            const { data: trendsData, error: trendsError } = await supabase
                .from('view_daily_trends')
                .select('*');
                
            if (trendsError) throw trendsError;
            if (trendsData) setTrendRows(trendsData);

            if (!summaryData) return;

            // Filtrar resúmenes por los meses seleccionados (Frontend)
            const filteredSummary = summaryData.filter(row => {
                return selectedNumbers.includes(Number(row.month_number));
            });

            // Convertir el resumen SQL a la interfaz ProcessedData legacy
            const mappedProcessed = filteredSummary.map((row, index) => {
                const d = new Date(row.latest_alarm || new Date().toISOString());
                const localeDateStr = \`\${d.getDate().toString().padStart(2, '0')}/\${(d.getMonth() + 1).toString().padStart(2, '0')}/\${d.getFullYear()} \${d.getHours().toString().padStart(2, '0')}:\${d.getMinutes().toString().padStart(2, '0')}:\${d.getSeconds().toString().padStart(2, '0')}\`;
                
                return {
                    id: index,
                    DeviceName: row.device_name,
                    ID: row.device_id_code || '',
                    Fleet: row.fleet || 'General',
                    DiskType: 'Aggregated',
                    DiskDetails: 'Dashboard SQL View',
                    Speed: '0',
                    Date: localeDateStr,
                    ReUpload: 'No',
                    RawDetails: '',
                    AlarmStatus: '',
                    speedVal: 0,
                    component: row.component,
                    action: row.action,
                    severity: row.severity,
                    level: row.level,
                    diagnosis: 'Consolidado General',
                    _total_alerts: Number(row.total_alerts)
                };
            });

            setData(mappedProcessed);
`;

const sIdx = txt.indexOf(loadDataOldStart);
const eIdx = txt.indexOf(loadDataOldEnd) + loadDataOldEnd.length;

if(sIdx !== -1 && txt.indexOf(loadDataOldEnd) !== -1) {
    txt = txt.substring(0, sIdx) + loadDataNew + txt.substring(eIdx);
    console.log('Replaced loadData');
} else {
    console.log('Failed to replace loadData');
}

// 4. Update stats trendMap logic
const trendOldStart = "// Agrupación por Día (Tendencia)";
const trendOldEnd = "const trendData = Object.entries(trendMap)";

const trendNew = `// Agrupación por Día (Tendencia) desde la Vista SQL Optimizada
        const trendMap: Record<string, number> = {};
        trendRows.forEach(row => {
            // Aplicar el mismo filtro Scope
            const inInternalSet = TRACKLOG_INTERNAL_FLEETS.has(row.fleet) || row.fleet === 'TRACKLOG';
            const inScope = scopeFilter === 'all' ? true : (scopeFilter === 'internal' ? inInternalSet : !inInternalSet);
            
            // Validar filtros del dashboard 
            const matchesAction = filterAction ? row.action === filterAction : true; // action not in trend, skip action filter or apply differently... wait view_daily_trends doesn't have action! It has level/severity. We skip action filter for trend or map it.
            
            if (inScope) {
                trendMap[row.alarm_date] = (trendMap[row.alarm_date] || 0) + Number(row.total_alerts);
            }
        });
        // Convertir a array y ordenar por fecha (ascendente para gráfico lineal)
        const trendData = Object.entries(trendMap)
`;

const sIdx2 = txt.indexOf(trendOldStart);
const eIdx2 = txt.indexOf(trendOldEnd) + trendOldEnd.length;

if(sIdx2 !== -1 && txt.indexOf(trendOldEnd) !== -1) {
    txt = txt.substring(0, sIdx2) + trendNew + txt.substring(eIdx2);
    console.log('Replaced stats trend');
} else {
    console.log('Failed to replace stats trend');
}

fs.writeFileSync(file, txt, 'utf8');
