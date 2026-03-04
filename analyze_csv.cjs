const fs = require('fs');

const YANACOCHA_FLEETS = [
    "ABANTO", "ACUARIO", "AHORRO", "ALQUIMAX NORTE", "ANITA TOURS", "AYS CONTRATISTAS", "BUREAU", "C. QUINUA",
    "CALERO", "CATALAN", "CCA", "CCQ", "CERRO DORADO", "CHAQUICOCHA", "CITUAM", "COLLOTAN", "COLUMBITO",
    "COMBAYO", "CONFIPETROL", "CONSORCIO COLLANTES", "COPEMI", "CPQ", "CVO", "DCR-YANACOCHA", "DEYFOR",
    "DEYFOR2", "DINO", "DISAL", "DIVINO SALVADOR", "EL ALISO", "EL PORVENIR", "EL PROGRESO", "EMIM", "FISAC",
    "FUERA SERVICIO_YANACOCHA", "G&S SERVICIOS", "GARCIA", "GEOTEC_YANACOCHA", "GEOTECNIA", "GUVI", "HESAM",
    "HUYU YURAQ", "HVH", "INGENIEROS", "INV. GEN. CRISTIAN", "J & J QUISHUAR", "JACH", "JOWEERS", "JUCASA",
    "KUNTUR", "LA PAJUELA", "LICAN", "LIMATAMBO", "MANNUCCI", "MARCEL YOPLA", "MEGAPACK", "MISEMATH",
    "MSA AUTOMOTRIZ", "MULT. TRNSP. CAJAMARCA", "MULTITRAC", "NUMAY", "NUMAY_MANT", "PATRON SAN MARCOS",
    "PCC", "PURUAY", "QUINUA SAC", "RANSA_P", "RANSA-YANACOCHA", "RENOVA - YANACOCHA", "RESCUE", "RICSAM",
    "RIO GRANDE", "ROHUAY", "SAEG", "SAGITARIO", "SAN FRANCISCO", "SECURITAS", "SGS", "STI", "TECNO SANPF",
    "TECNOLDHER", "TELECOM", "TRANSGROUP CAJAM", "VULCO", "VYC", "YANACOCHA", "YANACOCHA SULFURO",
    "YANACOCHA_CAMIONETAS", "ZAMINE", "ZASAL"
];

try {
    const content = fs.readFileSync('public/mdvrVideotracklogAll.csv', 'utf-8');
    const lines = content.split('\n');
    const header = lines[0].split(';');

    console.log('Total Columns:', header.length);
    header.forEach((h, i) => console.log(`Col ${i}: ${h}`));

    // Check first 100 rows for matches
    const matchesPerCol = new Array(header.length).fill(0);
    const sampleValues = new Array(header.length).fill(null);

    for (let i = 1; i < Math.min(lines.length, 500); i++) {
        const row = lines[i].split(';');
        if (row.length !== header.length) continue;

        row.forEach((val, idx) => {
            const cleanVal = val.trim();
            if (!sampleValues[idx] && cleanVal) sampleValues[idx] = cleanVal;
            if (YANACOCHA_FLEETS.includes(cleanVal)) {
                matchesPerCol[idx]++;
            }
        });
    }

    console.log('\n--- MATCH ANALYSIS ---');
    matchesPerCol.forEach((count, idx) => {
        if (count > 0 || idx < 5) {
            console.log(`Col ${idx} (${header[idx]}): ${count} matches. Sample: ${sampleValues[idx]}`);
        }
    });

} catch (e) {
    console.error(e);
}
