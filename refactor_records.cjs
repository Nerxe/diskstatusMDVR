const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// 1. Add new states
const statesInsert = `
    // --- ESTADOS PARA SERVER-SIDE PAGINATION ---
    const [serverRecords, setServerRecords] = useState<ProcessedData[]>([]);
    const [serverTotalCount, setServerTotalCount] = useState(0);
    const [isSearching, setIsSearching] = useState(false);

    const parseDateParam = (dateStr: string) => {
        if (!dateStr) return null;
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            return \`\${parts[2]}-\${parts[1]}-\${parts[0]}\`; // YYYY-MM-DD
        }
        return dateStr;
    }

    const fetchDetailedRecords = async (pageToLoad = 1) => {
        setIsSearching(true);
        setHasSearched(true);
        setCurrentPage(pageToLoad);
        
        try {
            let query = supabase.from('raw_alarms').select('*', { count: 'exact' });

            // 1. Buscador de Texto (Dispositivo, detalles o diagnóstico)
            if (searchTerm) {
                query = query.or(\`device_name.ilike.%\${searchTerm}%,device_id_code.ilike.%\${searchTerm}%,start_details.ilike.%\${searchTerm}%,diagnosis.ilike.%\${searchTerm}%\`);
            }

            // 2. Filtros Simples
            if (filterFleet !== 'all') query = query.eq('fleet', filterFleet);
            if (filterSeverity !== 'all') query = query.eq('severity', filterSeverity);
            if (filterComponent !== 'all') {
                const compMap = { 'ssd': 'SSD/HDD', 'sd': 'SD/Firebox', 'other': 'Otros' };
                query = query.eq('component', compMap[filterComponent as keyof typeof compMap]);
            }

            // 3. Rango de Fechas
            if (dateRange.start) {
                const startDate = parseDateParam(dateRange.start);
                if (startDate) query = query.gte('begin_time', \`\${startDate} 00:00:00\`);
            }
            if (dateRange.end) {
                const endDate = parseDateParam(dateRange.end);
                if (endDate) query = query.lte('begin_time', \`\${endDate} 23:59:59\`);
            }

            // 4. Filtros Locales Avanzados (PV y Modalidad) usando mapeo inverso
            if (filterPv !== 'all' || filterModel !== 'all') {
                const validDevices = data.filter(d => 
                    (filterPv === 'all' || d.pvName === filterPv) &&
                    (filterModel === 'all' || d.model === filterModel)
                ).map(d => d.DeviceName);
                
                if (validDevices.length === 0) {
                    setServerRecords([]);
                    setServerTotalCount(0);
                    setIsSearching(false);
                    return;
                }
                
                // Supabase in() restriction: prevent huge arrays
                query = query.in('device_name', validDevices.slice(0, 100));
            }

            // Paginación
            const startIdx = (pageToLoad - 1) * RECORDS_PER_PAGE;
            const endIdx = startIdx + RECORDS_PER_PAGE - 1;
            
            query = query.range(startIdx, endIdx).order('begin_time', { ascending: false });

            const { data: rawRes, count, error } = await query;
            
            if (error) throw error;

            if (rawRes && count !== null) {
                setServerTotalCount(count);
                
                // Map raw db to ProcessedData for rendering
                const mappedRecords = rawRes.map((row, index) => {
                    const d = new Date(row.begin_time);
                    const localeDateStr = \`\${d.getDate().toString().padStart(2, '0')}/\${(d.getMonth() + 1).toString().padStart(2, '0')}/\${d.getFullYear()} \${d.getHours().toString().padStart(2, '0')}:\${d.getMinutes().toString().padStart(2, '0')}:\${d.getSeconds().toString().padStart(2, '0')}\`;

                    return {
                        id: index,
                        DeviceName: row.device_name,
                        ID: row.device_id_code || '',
                        Fleet: row.fleet || 'General',
                        DiskType: 'From Table',
                        DiskDetails: row.start_details || '',
                        Speed: '0',
                        Date: localeDateStr,
                        ReUpload: 'No',
                        RawDetails: '',
                        AlarmStatus: '',
                        speedVal: 0,
                        component: row.component || 'Otros',
                        action: row.action || '',
                        severity: row.severity || 'Baja',
                        level: row.level || 'NA',
                        diagnosis: row.diagnosis || '',
                        _total_alerts: 1,
                        model: 'Dynamic',
                        pv: 'Dynamic',
                        pvName: 'Dynamic'
                    };
                });
                
                setServerRecords(mappedRecords);
            }

        } catch (err) {
            console.error('Error fetching paginated records:', err);
            alert('Error al consultar la base de datos.');
        } finally {
            setIsSearching(false);
        }
    };
`;

txt = txt.replace('    const [hasSearched, setHasSearched] = useState(false);', '    const [hasSearched, setHasSearched] = useState(false);\n' + statesInsert);

// 2. Modify handleSearch
const oldHandleSearch = `
    // Handler de búsqueda
    const handleSearch = () => {
        setHasSearched(true);
        setCurrentPage(1);
    };`;
    
const newHandleSearch = `
    // Handler de búsqueda
    const handleSearch = () => {
        if (viewMode === 'alerts') {
            fetchDetailedRecords(1);
        } else {
            setHasSearched(true);
            setCurrentPage(1);
        }
    };`;

txt = txt.replace(oldHandleSearch, newHandleSearch);

// 3. Add Page Change Hook for alerts Mode
const hookInsert = `
    // Interceptar cambios de página para el modo alertas
    const handlePageChange = (newPage: number) => {
        if (viewMode === 'alerts') {
            fetchDetailedRecords(newPage);
        } else {
            setCurrentPage(newPage);
        }
    };
`;

txt = txt.replace('    const resetFilters = () => {', hookInsert + '\n    const resetFilters = () => {');

// 4. Update the mapping in tabular view
txt = txt.replace('{(paginatedData as ProcessedData[]).map((row) => (', '{serverRecords.map((row) => (');

// 5. Update pagination total logic and counts in footer
const tableFooterFind = `{((currentPage - 1) * RECORDS_PER_PAGE) + 1}</strong> - <strong>{Math.min(currentPage * RECORDS_PER_PAGE, currentDataSource.length)}`;
const tableFooterReplace = `{((currentPage - 1) * RECORDS_PER_PAGE) + 1}</strong> - <strong>{Math.min(currentPage * RECORDS_PER_PAGE, viewMode === 'devices' ? currentDataSource.length : serverTotalCount)}`;
txt = txt.replace(tableFooterFind, tableFooterReplace);

txt = txt.replace(`{t('of')} <strong>{currentDataSource.length.toLocaleString()}</strong>`, `{t('of')} <strong>{(viewMode === 'devices' ? currentDataSource.length : serverTotalCount).toLocaleString()}</strong>`);

txt = txt.replace('const totalPages = Math.ceil(currentDataSource.length / RECORDS_PER_PAGE);', `const totalPages = Math.ceil((viewMode === 'devices' ? currentDataSource.length : serverTotalCount) / RECORDS_PER_PAGE);`);

txt = txt.replace(/setCurrentPage\(p => Math.max\(1, p - 1\)\)/g, "handlePageChange(Math.max(1, currentPage - 1))");
txt = txt.replace(/setCurrentPage\(pageNum\)/g, "handlePageChange(pageNum)");
txt = txt.replace(/setCurrentPage\(p => Math.min\(totalPages, p \+ 1\)\)/g, "handlePageChange(Math.min(totalPages, currentPage + 1))");


fs.writeFileSync(file, txt, 'utf8');
console.log('Script completed.');
