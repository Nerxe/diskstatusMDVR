const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const publicDir = path.join(__dirname, '../public');

// Helper: Extract equipment ID from name
const extractEquipmentId = (equipmentName) => {
    if (!equipmentName || typeof equipmentName !== 'string') {
        return { name: String(equipmentName || ''), id: null };
    }
    const match = equipmentName.match(/^(.+?)\(([^)]+)\)$/);
    if (match) {
        return {
            name: match[1].trim(),
            id: match[2].trim()
        };
    }
    return { name: equipmentName, id: null };
};

// Parser del catálogo MDVR
const parseMdvrDetails = (csvText) => {
    const results = Papa.parse(csvText, { skipEmptyLines: true });
    const rows = results.data;
    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.length >= 4 && row[0]) {
            const deviceName = String(row[0]).trim();
            map.set(deviceName, {
                deviceName,
                Model: String(row[1] || '').trim(),
                Pv: String(row[2] || '').trim(),
                PvName: String(row[3] || '').trim()
            });
        }
    }
    return map;
};

// --- LOGICA DE PROCESAMIENTO ORIGINAL ---
const processCSV = (csvText, mdvrMap, fleetMap) => {
    const results = Papa.parse(csvText, {
        header: false,
        skipEmptyLines: true,
    });

    const rows = results.data;
    const result = [];

    const sanitize = (str) => {
        if (!str) return '';
        let clean = str.trim();
        clean = clean.replace(/<[^>]*>?/gm, '');
        if (/^[=+\-@]/.test(clean)) {
            clean = clean.substring(1);
        }
        return clean;
    };

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length < 10) continue;

        const rawNameId = sanitize(row[0]);
        const nameMatch = rawNameId.match(/^(.*)\((\d+)\)$/);
        const deviceName = nameMatch ? nameMatch[1].trim() : rawNameId;
        const deviceID = nameMatch ? nameMatch[2] : '';

        let fleet = sanitize(row[2]);
        if (fleetMap && fleetMap.has(deviceName)) {
            fleet = fleetMap.get(deviceName) || fleet;
        }
        if (!fleet) fleet = 'General';

        const rawDetails = sanitize(row[6]); 
        const detailParts = rawDetails.split(/[;,]/);

        let diskType = 'Unknown';
        let diskState = '';

        detailParts.forEach(part => {
            const p = part.trim();
            if (p.startsWith('NO:')) diskType = p.replace('NO:', '').trim();
            if (p.startsWith('State:')) diskState = p.replace('State:', '').trim();
        });

        if (!diskState && rawDetails) diskState = rawDetails;

        const raw = {
            DeviceName: deviceName,
            ID: deviceID,
            Fleet: fleet,
            DiskType: diskType,
            DiskDetails: diskState,
            Speed: sanitize(row[7]) || '0',
            Date: sanitize(row[4]) || '',
            ReUpload: sanitize(row[9]) || 'No'
        };

        const speedVal = parseFloat(raw.Speed.replace(/[^0-9.]/g, '')) || 0;

        let component = 'Otros';
        const diskLower = raw.DiskType.toLowerCase();

        if (diskLower.includes('hdd') || diskLower.includes('hard')) {
            component = 'SSD/HDD';
        } else if (diskLower.includes('sd') || diskLower.includes('card')) {
            component = 'SD/Firebox';
        }

        let action = 'Investigación';
        let severity = 'Baja';
        let diagnosis = "Revisar logs detallados";
        const detailsLower = raw.DiskDetails.toLowerCase();

        const isL1 = detailsLower.includes('l1_') ||
            detailsLower.includes('damage') ||
            detailsLower.includes('disk failure') ||
            detailsLower.includes('overwrite exception') ||
            detailsLower.includes('sampling verification') ||
            detailsLower.includes('lost') ||
            detailsLower.includes('not recorded') || 
            detailsLower.includes('bad blocks');

        const isL2 = detailsLower.includes('l2_') ||
            detailsLower.includes('pauses') ||
            detailsLower.includes('slowly') ||
            detailsLower.includes('write block failed');

        const isL3 = detailsLower.includes('l3_') ||
            detailsLower.includes('cannot overwrite') ||
            detailsLower.includes('invalid') || 
            detailsLower.includes('mount');

        let level = 'Otro';

        if (isL1) {
            action = 'Reemplazo Físico';
            severity = 'Alta';
            level = 'L1';
            if (detailsLower.includes('bad blocks')) diagnosis = "Sectores defectuosos (>20%) [L1]. Reemplazo urgente.";
            else if (detailsLower.includes('not recorded')) diagnosis = "Sin grabación por largo tiempo (>2min) [L1]. Falla crítica.";
            else if (detailsLower.includes('overwrite') || detailsLower.includes('sampling')) diagnosis = "Error verif. escritura/sobreescritura [L1]. Reemplazar.";
            else diagnosis = "Falla crítica de disco/hardware [L1]. Reemplazar.";
        }
        else if (isL2) {
            action = 'Revisión Config/Instalación';
            severity = 'Media';
            level = 'L2';
            if (detailsLower.includes('slowly')) diagnosis = "Escritura lenta [L2]. Buffer lleno. Revisar velocidad/clase media.";
            else if (detailsLower.includes('pauses')) diagnosis = "Pausas en escritura video [L2]. Revisar conexiones/vibración.";
            else if (detailsLower.includes('write block failed')) diagnosis = "Fallo escritura bloque [L2]. Intervención requerida.";
            else diagnosis = "Rendimiento degradado [L2]. Requiere intervención.";
        }
        else if (isL3) {
            action = 'Mantenimiento Lógico';
            severity = 'Media'; 
            level = 'L3';
            if (detailsLower.includes('mount')) diagnosis = "No se puede montar disco [L3]. Formatear.";
            else if (detailsLower.includes('invalid')) diagnosis = "Bloque inválido/Corrupción [L3]. Formatear.";
            else diagnosis = "Error de sistema de archivos [L3]. Intentar formateo.";
        }
        else {
            action = 'Investigación';
            severity = 'Baja';
            diagnosis = `Error no clasificado: ${raw.DiskDetails}`;
        }

        const mdvrDetails = mdvrMap?.get(deviceName);
        const model = mdvrDetails?.Model || 'Sin Asignar';
        const pv = mdvrDetails?.Pv || 'Sin Asignar';
        const pvName = mdvrDetails?.PvName || 'Soporte';

        result.push({
            ...raw,
            id: i,
            speedVal,
            component,
            action,
            severity,
            level,
            diagnosis,
            model,
            pv,
            pvName
        });
    }

    return result; 
};

// Main Run
console.log('Starting CSV preprocessing...');
try {
    let mdvrMap = new Map();
    const mdvrFile = path.join(publicDir, 'mdvrDetailsPvModel.csv');
    if (fs.existsSync(mdvrFile)) {
        mdvrMap = parseMdvrDetails(fs.readFileSync(mdvrFile, 'utf-8'));
        console.log(`Loaded MDVR Map with ${mdvrMap.size} entries.`);
    }

    let fleetMap = new Map();
    const fleetFile = path.join(publicDir, 'mdvrVideotracklogAll.csv');
    if (fs.existsSync(fleetFile)) {
        const fleetCsv = fs.readFileSync(fleetFile, 'utf-8');
        const results = Papa.parse(fleetCsv, { skipEmptyLines: true });
        const rows = results.data;
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row && row.length >= 7 && row[0]) {
                const deviceNameFull = String(row[0]).trim();
                const fleetPart = String(row[6] || '').trim();
                if (deviceNameFull && fleetPart) {
                    const extracted = extractEquipmentId(deviceNameFull);
                    fleetMap.set(extracted.name, fleetPart);
                }
            }
        }
        console.log(`Loaded Fleet Map with ${fleetMap.size} entries.`);
    }

    const files = fs.readdirSync(publicDir);
    const diskAlarmFiles = files.filter(f => f.startsWith('diskAlarm_') && f.endsWith('.csv'));

    for (const file of diskAlarmFiles) {
        console.log(`Processing ${file}...`);
        const csvPath = path.join(publicDir, file);
        const csvContent = fs.readFileSync(csvPath, 'utf-8');
        
        const processed = processCSV(csvContent, mdvrMap, fleetMap);
        
        const jsonFilename = file.replace('.csv', '.json');
        const jsonPath = path.join(publicDir, jsonFilename);
        const keys = Object.keys(processed[0] || {});
        const data = processed.map(obj => Object.values(obj));
        const compressedData = { keys, data };
        
        fs.writeFileSync(jsonPath, JSON.stringify(compressedData));
        console.log(`Saved ${jsonFilename} (${processed.length} records, ${(fs.statSync(jsonPath).size / 1024 / 1024).toFixed(2)} MB)`);
        
        // Optimize Vercel final bundle: delete original CSV only on Vercel
        if (process.env.VERCEL === "1") {
            try {
                fs.unlinkSync(csvPath);
                console.log(`Cleaned up raw CSV string data for production: ${file}`);
            } catch(e) { console.error(e) }
        }
    }

    console.log('Preprocessing complete!');
} catch (e) {
    console.error('Error preprocessing CSVs:', e);
}
