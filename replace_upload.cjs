const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'TracklogDashboard.tsx');
let fileContent = fs.readFileSync(filePath, 'utf8');

const targetStr = `            // Formatear masivamente a objetos SQL
            const dbPayload = processedArray.map(item => ({
                device_name: item.DeviceName || 'Unknown',
                device_id_code: item.ID || '',
                alarm_type: 'Disk Status', // Marcador por defecto para diferenciar
                fleet: item.Fleet,
                alarm_status: item.DiskDetails || '',
                begin_time: parseDateToISO(item.Date),
                start_details: item.DiskDetails || '',
                speed_val: isNaN(item.speedVal) ? 0 : item.speedVal,
                component: item.component,
                action: item.action,
                severity: item.severity,
                level: item.level,
                diagnosis: item.diagnosis
            }));

            // Inserción en bloques (Lotes de 1000 para no reventar API limit)
            const BATCH_SIZE = 1000;
            let totalInserted = 0;

            for (let i = 0; i < dbPayload.length; i += BATCH_SIZE) {
                const batch = dbPayload.slice(i, i + BATCH_SIZE);`;

const replacement = `            // Formatear masivamente a objetos SQL
            const rawPayload = processedArray.map(item => ({
                device_name: item.DeviceName || 'Unknown',
                device_id_code: item.ID || '',
                alarm_type: 'Disk Status', // Marcador por defecto para diferenciar
                fleet: item.Fleet,
                alarm_status: item.DiskDetails || '',
                begin_time: parseDateToISO(item.Date),
                start_details: item.DiskDetails || '',
                speed_val: isNaN(item.speedVal) ? 0 : item.speedVal,
                component: item.component,
                action: item.action,
                severity: item.severity,
                level: item.level,
                diagnosis: item.diagnosis
            }));

            // Deduplicar localmente ANTES de enviar a la Base de Datos
            // Esto evita el error de PostgreSQL si el propio archivo trae dos filas idénticas al mismo milisegundo.
            const uniqueMap = new Map();
            rawPayload.forEach(item => {
                const uniqueKey = \`\${item.device_name}_\${item.begin_time}_\${item.alarm_type}\`;
                uniqueMap.set(uniqueKey, item);
            });
            const dbPayload = Array.from(uniqueMap.values());

            // Inserción en bloques (Lotes de 1000 para no reventar API limit)
            const BATCH_SIZE = 1000;
            let totalInserted = 0;

            for (let i = 0; i < dbPayload.length; i += BATCH_SIZE) {
                const batch = dbPayload.slice(i, i + BATCH_SIZE);`;

if (!fileContent.includes(targetStr)) {
    console.error("Target string not found in file!");
    process.exit(1);
}

const newContent = fileContent.replace(targetStr, replacement);
fs.writeFileSync(filePath, newContent, 'utf8');
console.log("Successfully replaced deduplication logic!");
