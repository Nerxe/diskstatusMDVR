const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// Target 1
let idx1 = txt.indexOf('    ReUpload: string;\r\n}');
let repl1 = '    ReUpload: string;\r\n    RawDetails: string;\r\n}';
let len1 = 24;

if (idx1 === -1) {
    idx1 = txt.indexOf('    ReUpload: string;\n}');
    repl1 = '    ReUpload: string;\n    RawDetails: string;\n}';
    len1 = 23;
}

if (idx1 !== -1) {
    txt = txt.substring(0, idx1) + repl1 + txt.substring(idx1 + len1);
    console.log("Replaced interface");
} else {
    console.log("Interface not found");
}

// Target 2
const t2 = "ReUpload: sanitize(row[9]) || 'No'      // Re-upload en columna 9";
const idx2 = txt.indexOf(t2);
if (idx2 !== -1) {
    txt = txt.substring(0, idx2) + "ReUpload: sanitize(row[9]) || 'No',      // Re-upload en columna 9\r\n            RawDetails: rawDetails" + txt.substring(idx2 + t2.length);
    console.log("Replaced implementation");
} else {
    console.log("Implementation not found");
}

fs.writeFileSync(file, txt);
