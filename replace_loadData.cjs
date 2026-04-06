const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'TracklogDashboard.tsx');
let fileContent = fs.readFileSync(filePath, 'utf8');

const startMarker = "    // 1. CARGA INTELIGENTE DE DATOS";
const endMarker = "    useEffect(() => {";

const startIndex = fileContent.indexOf(startMarker);
const endIndex = fileContent.indexOf(endMarker, startIndex);

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find markers!");
    process.exit(1);
}

const replacement = `    // 1. CARGA INTELIGENTE DE DATOS DESDE POSTGRES
    const loadData = async (force: boolean = false) => {
        setIsLoading(true);
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            // Mapeo genérico de meses para filtrado SQL simple
            const monthMap: Record<string, number> = {
                'January': 1, 'February': 2, 'March': 3, 'April': 4,
                'May': 5, 'June': 6, 'July': 7, 'August': 8,
                'September': 9, 'October': 10, 'November': 11, 'December': 12
            };
            const selectedNumbers = selectedMonths.map(sm => monthMap[sm]);

            if (selectedNumbers.length === 0) {
                setData([]);
                setIsLoading(false);
                return;
            }

            // A) Obtener alarmas desde SQL
            const { data: alarmsData, error: dbError } = await supabase
                .from('raw_alarms')
                .select('*')
                .limit(100000); // Elevado para traer el grueso de registros sin paginación forzada
            
            if (dbError) throw dbError;
            if (!alarmsData) return;

            // B) Filtrado Local según los meses seleccionados
            const filteredAlarms = alarmsData.filter(row => {
                const d = new Date(row.begin_time);
                return selectedNumbers.includes(d.getMonth() + 1);
            });

            // C) Convertir datos de DB al viejo modelo de React para máxima retrocompatibilidad
            const mappedProcessed = filteredAlarms.map((row, index) => {
                const d = new Date(row.begin_time);
                const localeDateStr = \`\${d.getDate().toString().padStart(2, '0')}/\${(d.getMonth() + 1).toString().padStart(2, '0')}/\${d.getFullYear()} \${d.getHours().toString().padStart(2, '0')}:\${d.getMinutes().toString().padStart(2, '0')}:\${d.getSeconds().toString().padStart(2, '0')}\`;
                
                return {
                    id: index,
                    DeviceName: row.device_name,
                    ID: row.device_id_code,
                    Fleet: row.fleet,
                    DiskType: 'From Table',
                    DiskDetails: row.start_details,
                    Speed: row.speed_val?.toString() || '0',
                    Date: localeDateStr,
                    ReUpload: 'No',
                    speedVal: Number(row.speed_val) || 0,
                    component: row.component,
                    action: row.action,
                    severity: row.severity,
                    level: row.level,
                    diagnosis: row.diagnosis,
                    _total_alerts: 1, // Nuestro truco .reduce() maneja 1 fila igual a 1 alerta
                };
            });

            setData(mappedProcessed);

            // D) Validar metadatos y fechas
            try {
                const { data: metaData } = await supabase.from('system_metadata').select('last_updated').eq('id', 1).single();
                if (metaData && metaData.last_updated) {
                    setLastUpdate(new Date(metaData.last_updated).toLocaleString());
                } else {
                    setLastUpdate(new Date().toLocaleString());
                }
            } catch (e) {
                console.warn("Metadatos no disponibles.");
            }

            // Descubrir qué meses están REALMENTE activos en la base de datos para habilitar los botones
            const existingMonthsInDbNums = Array.from(new Set(alarmsData.map(a => new Date(a.begin_time).getMonth() + 1)));
            const newAvailable = ALL_MONTHS.map(m => ({ ...m, exists: existingMonthsInDbNums.includes(monthMap[m.id]) }))
                .filter(m => m.exists)
                .map(m => ({ id: m.id, name: m.name, file: 'db' }));

            setAvailableMonths(newAvailable);
            
        } catch (err) {
            console.error("Error SQL loadData:", err);
            alert("No se pudieron cargar los datos de Supabase. \\n¿Recordaste cambiar el 'Max Rows' a 100000 en la configuración de Supabase API?");
        } finally {
            setIsLoading(false);
        }
    };

    `;

const newContent = fileContent.substring(0, startIndex) + replacement + fileContent.substring(endIndex);
fs.writeFileSync(filePath, newContent, 'utf8');
console.log("Successfully replaced loadData function!");
