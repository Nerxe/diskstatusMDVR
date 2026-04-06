const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

const targetStr = "`\\$\\{item.device_name\\}_\\$\\{item.begin_time\\}_\\$\\{item.alarm_type\\}`";
// Wait, replacing the exact JS logic string:
const oldKey = "const uniqueKey = `${item.device_name}_${item.begin_time}_${item.alarm_type}`;";
const newKey = "const uniqueKey = `${item.device_name}_${item.begin_time}_${item.alarm_type}_${item.start_details}`;";

txt = txt.replace(oldKey, newKey);

// We also need to update the upsert conflict key inside the batch loop!
const oldUpsert = "onConflict: 'device_name, begin_time, alarm_type'";
const newUpsert = "onConflict: 'device_name, begin_time, alarm_type, start_details'";

txt = txt.replace(oldUpsert, newUpsert);

fs.writeFileSync(file, txt, 'utf8');
console.log("Success");
