const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// 1. Add AlarmStatus to RawData interface
const idx1a = txt.indexOf('    ReUpload: string;');
if (idx1a !== -1) {
    if (txt[idx1a - 1] === '\n' && txt[idx1a - 2] === '\r') {
        txt = txt.substring(0, idx1a) + '    AlarmStatus: string;\r\n' + txt.substring(idx1a);
    } else {
        txt = txt.substring(0, idx1a) + '    AlarmStatus: string;\n' + txt.substring(idx1a);
    }
} else {
    console.log("Failed to find interface ReUpload");
}

// 2. Add AlarmStatus to processCSV RawData instantiation
const t2 = "Speed: sanitize(row[7]) || '0',";
const idx2 = txt.indexOf(t2);
if (idx2 !== -1) {
    if (txt[idx2 - 1] === '\n' && txt[idx2 - 2] === '\r') {
        txt = txt.substring(0, idx2) + "AlarmStatus: sanitize(row[3]) || '',\r\n            " + txt.substring(idx2);
    } else {
        txt = txt.substring(0, idx2) + "AlarmStatus: sanitize(row[3]) || '',\n            " + txt.substring(idx2);
    }
} else {
    console.log("Failed to find processCSV implementation");
}

// 3. Fix alarm_status mapping in handleFileUpload rawPayload
const t3 = "alarm_status: item.DiskDetails || '',";
const idx3 = txt.indexOf(t3);
if (idx3 !== -1) {
    txt = txt.replace(t3, "alarm_status: item.AlarmStatus || '',");
} else {
    console.log("Failed to find alarm_status in rawPayload");
}

// 4. Update local Javascript uniqueMap deduplicator key
const t4 = "const uniqueKey = `${item.device_name}_${item.begin_time}_${item.alarm_type}_${item.start_details}`;";
const idx4 = txt.indexOf(t4);
if (idx4 !== -1) {
    txt = txt.replace(t4, "const uniqueKey = `${item.device_name}_${item.begin_time}_${item.alarm_type}_${item.start_details}_${item.alarm_status}`;");
} else {
    const fallbackT4 = "const uniqueKey = \\`\\${item.device_name}_\\${item.begin_time}_\\${item.alarm_type}_\\${item.start_details}\\`;";
    txt = txt.replace(fallbackT4, "const uniqueKey = \\`\\${item.device_name}_\\${item.begin_time}_\\${item.alarm_type}_\\${item.start_details}_\\${item.alarm_status}\\`;");
}

fs.writeFileSync(file, txt, 'utf8');
console.log('Script completed');
