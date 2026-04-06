const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

const sIdx = txt.indexOf('const dbPayload = processedArray.map(');
const eIdx = txt.indexOf('for (let i = 0; i < dbPayload.length; i += BATCH_SIZE)');

if (sIdx === -1 || eIdx === -1) {
    console.error("Index not found!");
    process.exit(1);
}

const replacement = `const rawPayload = processedArray.map(item => ({
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
            const uniqueMap = new Map();
            rawPayload.forEach(item => {
                const uniqueKey = \`\${item.device_name}_\${item.begin_time}_\${item.alarm_type}\`;
                uniqueMap.set(uniqueKey, item);
            });
            const dbPayload = Array.from(uniqueMap.values());

            // Inserción en bloques (Lotes de 1000 para no reventar API limit)
            const BATCH_SIZE = 1000;
            let totalInserted = 0;

            `;

txt = txt.substring(0, sIdx) + replacement + txt.substring(eIdx);
fs.writeFileSync(file, txt);
console.log("Success");
