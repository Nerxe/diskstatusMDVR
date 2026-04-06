const fs = require('fs');

const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// 1. Add RawDetails to RawData interface
txt = txt.replace(
    /ReUpload: string;\n}/,
    "ReUpload: string;\n    RawDetails: string;\n}"
);

// 2. Populate RawDetails in processCSV
txt = txt.replace(
    /Date: sanitize\(row\[4\]\) \|\| '',[ \t]*\/\/.+\n[ \t]*ReUpload: sanitize\(row\[9\]\) \|\| 'No'[ \t]*\/\/.+\n[ \t]*};/,
    `Date: sanitize(row[4]) || '',\n            ReUpload: sanitize(row[9]) || 'No',\n            RawDetails: rawDetails\n        };`
);

// 3. Map start_details to item.RawDetails instead of item.DiskDetails in handleFileUpload
txt = txt.replace(
    /start_details: item\.DiskDetails \|\| '',/g,
    "start_details: item.RawDetails || item.DiskDetails || '',"
);

fs.writeFileSync(file, txt, 'utf8');
console.log("Success");
