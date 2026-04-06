const fs = require('fs');
const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

// Confirmed positions:
// Corruption starts at 74055 (right after "// Estados de Filtro para Registros\r\n")
// Real states start at 81459 (the correct "const [searchTerm...")

const commentEndIdx = 74055 + '    // Estados de Filtro para Registros\r\n'.length;
const realStatesIdx = 81459;

const prefix = txt.substring(0, commentEndIdx);
const suffix = txt.substring(realStatesIdx);

const fixed = prefix + suffix;
fs.writeFileSync(file, fixed, 'utf8');
console.log(`Done. File size: ${fixed.length} (removed ${txt.length - fixed.length} chars)`);
