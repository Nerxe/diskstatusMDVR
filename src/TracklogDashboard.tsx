import React, { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
    PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, LabelList, AreaChart, Area
} from 'recharts';
import {
    AlertTriangle, HardDrive, CheckCircle, Search,
    Wrench, Truck, AlertOctagon, Download, Upload, Filter, Database,
    LayoutDashboard, Table, ChevronLeft, ChevronRight, RefreshCw, FileText, X, Activity, Hammer, ExternalLink
} from 'lucide-react';
import { generateWorkOrderPDF } from './utils/pdfGenerator';
import { YANACOCHA_FLEETS, REPSOL_FLEETS, TRACKLOG_INTERNAL_FLEETS } from './utils/fleets';

import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
// Importar estilos personalizados para que coincidan con Tailwind si es necesario, 
// o usar className.


// --- DEFINICIÓN DE TIPOS ---

interface RawData {
    DeviceName: string;
    ID: string;
    Fleet: string;
    DiskType: string;
    DiskDetails: string;
    Speed: string;
    Date: string;
    ReUpload: string;
}

interface ProcessedData extends RawData {
    id: number;
    speedVal: number;
    component: 'SSD/HDD' | 'SD/Firebox' | 'Otros';
    action: 'Reemplazo Físico' | 'Mantenimiento Lógico' | 'Revisión Config/Instalación' | 'Investigación';
    severity: 'Alta' | 'Media' | 'Baja';
    level: 'L1' | 'L2' | 'L3' | 'Otro';
    diagnosis: string;
    model: string;
    pv: string;
    pvName: string;
}

interface MdvrDetails {
    deviceName: string;
    Model: string;
    Pv: string;
    PvName: string;
}

// Comment interface for tracking history
interface Comment {
    id: string;
    text: string;
    author: string;
    timestamp: string;
    type: 'user' | 'system'; // System comments for auto-generated entries
}

interface RepairTracking {
    deviceId: string;
    macroGroup: 'Yanacocha' | 'Repsol' | 'General';
    initialAlerts: number;
    status: 'Pendiente' | 'En Proceso' | 'Validando' | 'Reparado';
    repairDate?: string;
    notes?: string;

    // Enhanced tracking fields
    comments: Comment[];
    priority: 'Baja' | 'Media' | 'Alta' | 'Crítica';
    assignedTo?: string;
    estimatedCompletionDate?: string;
    actualCompletionDate?: string;
    lastModifiedBy: string;
    lastModifiedDate: string;
    createdDate: string;
}

type TabType = 'dashboard' | 'records' | 'tracking' | 'general-tracking';

interface DeviceGroup {
    equipment: string;
    fleet: string;
    model: string;
    pv: string;
    totalAlerts: number;
    highSeverityCount: number;
    maxSeverity: 'Alta' | 'Media' | 'Baja';
    worstDiagnosis: string;
    suggestedAction: string;
    component: string;
    diskType: string;
    id?: string;
}

// --- LOGICA DE PROCESAMIENTO ---

// Parser del catálogo MDVR
const parseMdvrDetails = (csvText: string): Map<string, MdvrDetails> => {
    const lines = csvText.split('\n');
    const map = new Map<string, MdvrDetails>();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(';');
        if (parts.length >= 4) {
            const deviceName = parts[0].trim();
            map.set(deviceName, {
                deviceName,
                Model: parts[1].trim(),
                Pv: parts[2].trim(),
                PvName: parts[3].trim()
            });
        }
    }
    return map;
};

const processCSV = (csvText: string, mdvrMap?: Map<string, MdvrDetails>, fleetMap?: Map<string, string>): ProcessedData[] => {
    const results = Papa.parse(csvText, {
        header: false,
        skipEmptyLines: true,
    });

    const rows = results.data as string[][];
    const result: ProcessedData[] = [];

    // Helper de Sanitización (Seguridad)
    const sanitize = (str: string): string => {
        if (!str) return '';
        let clean = str.trim();
        // 1. Eliminar tags HTML (prevención XSS básico)
        clean = clean.replace(/<[^>]*>?/gm, '');
        // 2. Prevenir CSV Injection (si se re-exporta a Excel)
        // Si empieza con caracteres peligrosos =, +, -, @, los neutralizamos quitándolos
        if (/^[=+\-@]/.test(clean)) {
            clean = clean.substring(1);
        }
        return clean;
    };

    // Empezamos en 1 para saltar el header dada la estructura del CSV
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length < 5) continue;

        // Mapeo basado en la NUEVA estructura (Enero 2026):
        // 0: Device Name (ID)
        // 1: Alarm Type
        // 2: Fleet
        // 3: Alarm Status
        // 4: Begin Time
        // 5: Start position
        // 6: Start details (Contiene Type y State)
        // 7: Start Speed
        // 8: Reporting time
        // 9: Re-upload

        const rawNameId = sanitize(row[0]);
        const nameMatch = rawNameId.match(/^(.*)\((\d+)\)$/);
        const deviceName = nameMatch ? nameMatch[1].trim() : rawNameId; // Ya sanitizado
        const deviceID = nameMatch ? nameMatch[2] : '';

        // DETERMINAR FLOTA (Prioridad: Map > CSV)
        let fleet = sanitize(row[2]);
        if (fleetMap && fleetMap.has(deviceName)) {
            // Usamos el valor del mapa si existe
            fleet = fleetMap.get(deviceName) || fleet;
        } else if (fleetMap) {
            // Intento de match parcial/fallback si hiciera falta
            // Por ahora confiamos en deviceName exacto
        }
        if (!fleet) fleet = 'General';

        const rawDetails = sanitize(row[6]); // 'Start details' está en la columna 6
        const detailParts = rawDetails.split(';');

        let diskType = 'Unknown';
        let diskState = '';

        detailParts.forEach(part => {
            const p = part.trim();
            if (p.startsWith('NO:')) diskType = p.replace('NO:', '').trim();
            if (p.startsWith('State:')) diskState = p.replace('State:', '').trim();
        });

        // Fallback si no hay "State:" explícito
        if (!diskState && rawDetails) diskState = rawDetails;

        const raw: RawData = {
            DeviceName: deviceName,
            ID: deviceID,
            Fleet: fleet,
            DiskType: diskType,
            DiskDetails: diskState,
            Speed: sanitize(row[7]) || '0',         // Speed en columna 7
            Date: sanitize(row[4]) || '',           // Begin Time en columna 4
            ReUpload: sanitize(row[9]) || 'No'      // Re-upload en columna 9
        };

        // --- Reglas de Negocio ---
        const speedVal = parseFloat(raw.Speed.replace(/[^0-9.]/g, '')) || 0;

        let component: ProcessedData['component'] = 'Otros';
        const diskLower = raw.DiskType.toLowerCase();

        // Nomenclatura MDVR:
        if (diskLower.includes('hdd') || diskLower.includes('hard')) {
            component = 'SSD/HDD';
        } else if (diskLower.includes('sd') || diskLower.includes('card')) {
            component = 'SD/Firebox';
        }
        // Todo lo demás cae en 'Otros' (aprox 1095 registros)

        let action: ProcessedData['action'] = 'Investigación';
        let severity: ProcessedData['severity'] = 'Baja';
        let diagnosis = "Revisar logs detallados";
        const detailsLower = raw.DiskDetails.toLowerCase();

        // Clasificación basada en Niveles del Usuario:
        // L1: Fallas Críticas -> Reemplazo Físico
        const isL1 = detailsLower.includes('l1_') ||
            detailsLower.includes('damage') ||
            detailsLower.includes('disk failure') ||
            detailsLower.includes('overwrite exception') ||
            detailsLower.includes('sampling verification') ||
            detailsLower.includes('lost') ||
            detailsLower.includes('not recorded') || // "not recorded for a long time"
            detailsLower.includes('bad blocks');

        // L2: Requieren Intervención -> Revisión Config/Instalación
        const isL2 = detailsLower.includes('l2_') ||
            detailsLower.includes('pauses') ||
            detailsLower.includes('slowly') ||
            detailsLower.includes('write block failed');

        // L3: Se resuelven con Formateo -> Mantenimiento Lógico
        const isL3 = detailsLower.includes('l3_') ||
            detailsLower.includes('cannot overwrite') ||
            detailsLower.includes('invalid') || // "invalid block"
            detailsLower.includes('mount');

        let level: ProcessedData['level'] = 'Otro';

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
            severity = 'Media'; // Usuario indicó que se resuelven con formateo, severidad media/baja
            level = 'L3';
            if (detailsLower.includes('mount')) diagnosis = "No se puede montar disco [L3]. Formatear.";
            else if (detailsLower.includes('invalid')) diagnosis = "Bloque inválido/Corrupción [L3]. Formatear.";
            else diagnosis = "Error de sistema de archivos [L3]. Intentar formateo.";
        }
        else {
            // Fallback para otros errores no clasificados explícitamente
            action = 'Investigación';
            severity = 'Baja';
            diagnosis = `Error no clasificado: ${raw.DiskDetails}`;
        }

        // Obtener detalles del catálogo MDVR
        const mdvrDetails = mdvrMap?.get(deviceName);
        const model = mdvrDetails?.Model || 'Sin Asignar';
        const pv = mdvrDetails?.Pv || 'Sin Asignar';
        const pvName = mdvrDetails?.PvName || 'Soporte';

        result.push({
            ...raw,
            id: i, // Usar índice como ID único simple
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

    // DEDUPLICACIÓN: Eliminar registros duplicados
    // Clave única: DeviceName + Date + DiskType + DiskDetails
    const seen = new Set<string>();
    const deduplicated = result.filter(item => {
        const key = `${item.DeviceName}|${item.Date}|${item.DiskType}|${item.DiskDetails}`;
        if (seen.has(key)) {
            return false; // Duplicado, filtrar
        }
        seen.add(key);
        return true; // Único, mantener
    });



    return deduplicated;
};


// --- COMPONENTES VISUALES ---

// Helper: Extract equipment ID from name (text in parentheses)
// Helper: Extract equipment ID from name (text in parentheses)
const extractEquipmentId = (equipmentName: string): { name: string; id: string | null } => {
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
    return {
        name: equipmentName,
        id: null
    };
};

// Helper: Format relative time
const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Justo ahora';
    if (diffMins < 60) return `Hace ${diffMins} min`;
    if (diffHours < 24) return `Hace ${diffHours}h`;
    if (diffDays < 7) return `Hace ${diffDays}d`;
    return then.toLocaleDateString();
};

const parseDateLocal = (dateStr: string): number => {
    if (!dateStr || typeof dateStr !== 'string') return 0;
    // Attempt DD/MM/YYYY format
    const parts = dateStr.split(' ')[0].split('/'); // Handle potential time part
    if (parts.length === 3) {
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1; // Months are 0-indexed
        const y = parseInt(parts[2], 10);
        if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
            return new Date(y, m, d).getTime();
        }
    }
    // Fallback for YYYY-MM-DD or other formats
    return new Date(dateStr).getTime();
};

// Comment Timeline Component
const CommentTimeline = ({ comments }: { comments: Comment[] }) => {
    if (!comments || comments.length === 0) {
        return (
            <div className="text-center py-4 text-slate-400 text-xs">
                No hay comentarios aún
            </div>
        );
    }

    // Sort comments by timestamp (newest first)
    const sortedComments = [...comments].sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return (
        <div className="space-y-2 max-h-60 overflow-y-auto">
            {sortedComments.map((comment) => (
                <div
                    key={comment.id}
                    className={`p-2 rounded-lg text-xs ${comment.type === 'system'
                        ? 'bg-blue-50 border border-blue-200'
                        : 'bg-slate-50 border border-slate-200'
                        }`}
                >
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`font-bold ${comment.type === 'system' ? 'text-blue-700' : 'text-slate-700'
                                    }`}>
                                    {comment.type === 'system' ? '🤖' : '👤'} {comment.author}
                                </span>
                                <span className="text-slate-400 text-[10px]">
                                    {formatRelativeTime(comment.timestamp)}
                                </span>
                            </div>
                            <p className="text-slate-600 whitespace-pre-wrap">{comment.text}</p>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

// Comment Input Component
const CommentInput = ({
    onSubmit,
    placeholder = "Agregar comentario..."
}: {
    onSubmit: (text: string) => void;
    placeholder?: string;
}) => {
    const [commentText, setCommentText] = React.useState('');
    const [isExpanded, setIsExpanded] = React.useState(false);

    const handleSubmit = () => {
        if (commentText.trim()) {
            onSubmit(commentText.trim());
            setCommentText('');
            setIsExpanded(false);
        }
    };

    return (
        <div className="space-y-2">
            {isExpanded ? (
                <>
                    <textarea
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        placeholder={placeholder}
                        maxLength={500}
                        className="w-full p-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                        rows={3}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400">
                            {commentText.length}/500
                        </span>
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    setCommentText('');
                                    setIsExpanded(false);
                                }}
                                className="px-3 py-1 text-xs text-slate-600 hover:text-slate-800 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSubmit}
                                disabled={!commentText.trim()}
                                className="px-3 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                Agregar
                            </button>
                        </div>
                    </div>
                </>
            ) : (
                <button
                    onClick={() => setIsExpanded(true)}
                    className="w-full p-2 text-xs text-left text-slate-400 border border-slate-200 rounded-lg hover:border-blue-300 hover:text-blue-600 transition-colors"
                >
                    {placeholder}
                </button>
            )}
        </div>
    );
};


const KpiCard = ({ title, value, icon, color, subtext, onClick, isActive }: any) => (
    <div
        onClick={onClick}
        className={`bg-white p-5 rounded-xl shadow-sm border transition-all cursor-pointer flex items-center justify-between
      ${isActive ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-blue-300 hover:shadow-md'}
    `}
    >
        <div>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-wide mb-1">{title}</p>
            <h3 className="text-3xl font-bold text-slate-800">{value}</h3>
            {subtext && <p className="text-xs text-slate-400 mt-1">{subtext}</p>}
        </div>
        <div className={`p-3 rounded-lg ${color} bg-opacity-20`}>
            {React.cloneElement(icon, { className: `w-6 h-6 ${color.replace('bg-', 'text-').replace('/20', '')}` })}
        </div>
    </div>
);

// Componente Modal de Detalles del Equipo
const DeviceDetailsModal = ({
    isOpen,
    onClose,
    equipment,
    fleet,
    id: explicitId,
    repairData,
    alarms,
    onAddComment
}: {
    isOpen: boolean;
    onClose: () => void;
    equipment: string;
    fleet: string;
    id?: string;
    repairData: RepairTracking | undefined;
    alarms: ProcessedData[];
    onAddComment: (text: string) => void;
}) => {
    if (!isOpen) return null;

    const extracted = extractEquipmentId(equipment);
    const name = extracted.name;
    const id = explicitId || extracted.id;
    const sortedAlarms = [...alarms].sort((a, b) => {
        const getTime = (dStr: string) => {
            if (!dStr) return 0;
            // Intentar formato DD/MM/YYYY HH:mm
            const parts = dStr.split(' ');
            const dateParts = parts[0].split('/');
            if (dateParts.length === 3) {
                const day = parseInt(dateParts[0], 10);
                const month = parseInt(dateParts[1], 10) - 1;
                const year = parseInt(dateParts[2], 10);
                const timeParts = (parts[1] || '00:00').split(':');
                const hour = parseInt(timeParts[0], 10) || 0;
                const min = parseInt(timeParts[1], 10) || 0;
                return new Date(year, month, day, hour, min).getTime();
            }
            // Fallback a constructor estándar
            return new Date(dStr).getTime();
        };
        return getTime(b.Date) - getTime(a.Date);
    });

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-start bg-slate-50">
                    <div>
                        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                            {name}
                            {id && <span className="text-lg font-mono text-slate-500 bg-slate-200 px-2 py-0.5 rounded">ID: {id}</span>}
                        </h2>
                        <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 font-bold uppercase">
                            <span>{fleet}</span>
                            <span className="text-slate-300">•</span>
                            <span>{alarms.length} Alarmas Totales</span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        title="Cerrar"
                        aria-label="Cerrar"
                        className="text-slate-400 hover:text-slate-600 p-2 hover:bg-slate-200 rounded-full transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
                    {/* Left Column: Alarms History & Status */}
                    <div className="flex-1 overflow-y-auto p-6 border-r border-slate-200 bg-white">

                        {/* Status Summary */}
                        <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 mb-6 flex gap-8">
                            <div>
                                <div className="text-xs text-slate-400 uppercase font-bold mb-1">Estado de Reparación</div>
                                <div className={`inline-flex px-3 py-1 rounded text-sm font-bold border
                                    ${repairData?.status === 'Pendiente' ? 'bg-slate-100 text-slate-600 border-slate-300' :
                                        repairData?.status === 'En Proceso' ? 'bg-amber-100 text-amber-700 border-amber-300' :
                                            repairData?.status === 'Validando' ? 'bg-blue-100 text-blue-700 border-blue-300' :
                                                'bg-emerald-100 text-emerald-700 border-emerald-300'}`}>
                                    {repairData?.status || 'Pendiente'}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-400 uppercase font-bold mb-1">Prioridad</div>
                                <div className={`text-sm font-bold ${repairData?.priority === 'Crítica' ? 'text-red-600' :
                                    repairData?.priority === 'Alta' ? 'text-orange-600' :
                                        'text-blue-600'
                                    }`}>
                                    {repairData?.priority || 'Media'}
                                </div>
                            </div>
                        </div>

                        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500"></span>
                            Historial de Fallas
                        </h3>

                        <div className="space-y-3 relative">
                            {/* Vertical Line */}
                            <div className="absolute left-[85px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                            {sortedAlarms.map((alarm, idx) => (
                                <div key={idx} className="flex gap-4 group">
                                    <div className="w-20 pt-1 text-right">
                                        <div className="text-xs font-bold text-slate-500">{alarm.Date.split(' ')[0]}</div>
                                        <div className="text-[10px] text-slate-400">{alarm.Date.split(' ')[1]}</div>
                                    </div>

                                    <div className="relative z-10 pt-1.5">
                                        <div className={`w-3 h-3 rounded-full border-2 border-white ring-1 
                                            ${alarm.severity === 'Alta' ? 'bg-red-500 ring-red-100' :
                                                alarm.severity === 'Media' ? 'bg-amber-500 ring-amber-100' :
                                                    'bg-blue-500 ring-blue-100'}`}></div>
                                    </div>

                                    <div className="flex-1 bg-slate-50 rounded p-3 border border-transparent group-hover:border-slate-200 transition-colors">
                                        <div className="flex justify-between items-start gap-2">
                                            <div className="text-sm font-bold text-slate-700">{alarm.diagnosis}</div>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase whitespace-nowrap
                                                 ${alarm.severity === 'Alta' ? 'bg-red-100 text-red-700' :
                                                    alarm.severity === 'Media' ? 'bg-amber-100 text-amber-700' :
                                                        'bg-slate-200 text-slate-600'}`}>
                                                {alarm.level}
                                            </span>
                                        </div>
                                        <div className="text-xs text-slate-500 mt-1">
                                            <span className="font-semibold">Acción:</span> {alarm.action}
                                        </div>
                                        <div className="text-[10px] text-slate-400 mt-2 font-mono">
                                            Componente: {alarm.component} | Modelo: {alarm.model}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Right Column: Comments (Bitácora) */}
                    <div className="w-full lg:w-96 flex flex-col bg-slate-50 border-t lg:border-t-0 lg:border-l border-slate-200 h-96 lg:h-auto">
                        <div className="p-4 border-b border-slate-200 bg-white shadow-sm z-10">
                            <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                                💬 Bitácora de Seguimiento
                            </h3>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">
                            <CommentTimeline comments={repairData?.comments || []} />
                        </div>
                        <div className="p-4 border-t border-slate-200 bg-white">
                            <CommentInput
                                onSubmit={(text) => onAddComment(text)}
                                placeholder="Agregar nota, actualización o cambio de estado..."
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ----------------------------------------------------------------------
// Componente de Fila de Rastreo (TrackingRow)
// ----------------------------------------------------------------------

interface TrackingRowProps {
    item: any;
    repairData: Record<string, RepairTracking>;
    onUpdateStatus: (id: string, status: any, alerts: number) => void;
    onAddComment: (id: string, text: string) => void;
    selectedDevice?: string | null;
    onSelectDevice?: (id: string | null) => void;
    showAll?: boolean;
    onViewDetails?: (id: string) => void;
}

const TrackingRow: React.FC<TrackingRowProps> = ({
    item,
    repairData,
    onUpdateStatus,
    onAddComment,
    selectedDevice,
    onSelectDevice,
    showAll,
    onViewDetails
}) => {
    const tracking = repairData[item.equipment];
    const status = tracking?.status || 'Pendiente';
    const [isExpanded, setIsExpanded] = React.useState(false);
    const { name } = extractEquipmentId(item.equipment);
    const useId = item.id;

    return (
        <React.Fragment>
            <tr
                className={`hover:bg-slate-50 transition-colors ${selectedDevice === item.equipment ? 'bg-blue-100/50 ring-1 ring-blue-400' : ''}`}
            >
                <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                        {/* Expand/Collapse Button */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsExpanded(!isExpanded);
                            }}
                            className="text-slate-400 hover:text-slate-600 transition-colors"
                            title={isExpanded ? "Ocultar comentarios" : "Ver comentarios"}
                        >
                            {isExpanded ? '▼' : '▶'}
                        </button>

                        <div
                            className="cursor-pointer flex-1"
                            onClick={() => onSelectDevice && onSelectDevice(item.equipment === selectedDevice ? null : item.equipment)}
                        >
                            <div className="font-bold text-slate-900">{name}</div>
                            {/* Mostrar ID solo si es Seguimiento General (showAll=true) y existe ID */}
                            {showAll && useId && (
                                <div className="text-[10px] text-slate-400 font-mono">
                                    ID: {useId}
                                </div>
                            )}
                            <div className="text-xs text-slate-500">{item.fleet}</div>
                        </div>
                    </div>
                </td>
                <td className="px-4 py-3 text-center">
                    <span className="font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded">
                        {item.highSeverityCount}
                    </span>
                </td>
                <td className="px-4 py-3 text-right">
                    <select
                        aria-label="Estado de reparación"
                        className={`text-xs font-bold py-1 px-2 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer
                            ${status === 'Pendiente' ? 'bg-slate-100 text-slate-600 border-slate-300' :
                                status === 'En Proceso' ? 'bg-amber-100 text-amber-700 border-amber-300' :
                                    status === 'Validando' ? 'bg-blue-100 text-blue-700 border-blue-300' :
                                        'bg-emerald-100 text-emerald-700 border-emerald-300'}
                        `}
                        value={status}
                        onChange={(e) => onUpdateStatus(item.equipment, e.target.value, item.highSeverityCount)}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <option value="Pendiente">Pendiente</option>
                        <option value="En Proceso">En Proceso</option>
                        <option value="Validando">Validando</option>
                        <option value="Reparado">Reparado</option>
                    </select>
                </td>
            </tr>

            {/* Fila de Comentarios (Expandible) */}
            {isExpanded && (
                <tr className="bg-slate-50/50">
                    <td colSpan={3} className="px-4 py-3 border-b border-slate-100">
                        <div className="pl-6 space-y-3">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => onViewDetails && onViewDetails(item.equipment)}
                                    className="text-xs bg-white border border-slate-200 hover:bg-slate-50 px-3 py-1 rounded shadow-sm flex items-center gap-1 text-slate-600"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    Ver Detalles Completos
                                </button>
                            </div>
                            <CommentTimeline
                                equipmentId={item.equipment}
                                comments={tracking?.comments || []}
                            />
                            <CommentInput
                                onSubmit={(text) => onAddComment(item.equipment, text)}
                                placeholder="Agregar comentario sobre este equipo..."
                            />
                        </div>
                    </td>
                </tr>
            )}
        </React.Fragment>
    );
};

// Componente Auxiliar para Columna de Seguimiento
const TrackingColumn = ({ title, color, data, repairData, onUpdateStatus, onAddComment, selectedDevice, onSelectDevice, onViewDetails, showAll = false, statusFilter = 'all' }: {
    title: string,
    color: 'blue' | 'orange',
    data: any[],
    repairData: Record<string, RepairTracking>,
    onUpdateStatus: (id: string, status: any, alerts: number) => void,
    onAddComment: (deviceId: string, commentText: string) => void,
    selectedDevice?: string | null,
    onSelectDevice?: (device: string | null) => void,
    onViewDetails?: (device: string) => void,
    showAll?: boolean,
    statusFilter?: 'all' | 'Pendiente' | 'En Proceso' | 'Validando' | 'Reparado'
}) => {
    // Estado de paginación
    const [currentPage, setCurrentPage] = React.useState(0);

    // Estado de búsqueda (solo para showAll)


    // Filtrar y ordenar con useMemo para evitar re-renders
    const items = React.useMemo(() => {
        let filtered = data
            .filter((d: any) => showAll ? d.totalAlerts > 0 : d.highSeverityCount > 1)
            .sort((a: any, b: any) => showAll ? b.totalAlerts - a.totalAlerts : b.highSeverityCount - a.highSeverityCount);



        // Aplicar filtro de estado si no es 'all'
        if (statusFilter !== 'all') {
            filtered = filtered.filter((d: any) => {
                const status = repairData[d.equipment]?.status || 'Pendiente';
                return status === statusFilter;
            });
        }

        // Si no es showAll, limitar a Top 5
        if (!showAll) {
            filtered = filtered.slice(0, 5);
        }

        return filtered;
    }, [data, showAll, statusFilter, repairData]);

    // Paginación para showAll
    const ITEMS_PER_PAGE = 50;
    const totalPages = showAll ? Math.ceil(items.length / ITEMS_PER_PAGE) : 1;
    const paginatedItems = showAll
        ? items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE)
        : items;

    const top10 = paginatedItems;

    const bgColor = color === 'blue' ? 'bg-blue-50' : 'bg-orange-50';
    const borderColor = color === 'blue' ? 'border-blue-200' : 'border-orange-200';
    const textColor = color === 'blue' ? 'text-blue-800' : 'text-orange-800';

    return (
        <div className={`rounded-xl border ${borderColor} shadow-sm overflow-hidden bg-white`}>
            {/* Search Bar and Pagination (only for showAll) */}
            {showAll && (
                <div className="px-6 py-3 border-b border-slate-200 bg-slate-50">
                    {/* Pagination Controls */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between text-xs">
                            <div className="text-slate-500">
                                Mostrando {currentPage * ITEMS_PER_PAGE + 1} - {Math.min((currentPage + 1) * ITEMS_PER_PAGE, items.length)} de {items.length} equipos
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setCurrentPage(prev => Math.max(0, prev - 1))}
                                    disabled={currentPage === 0}
                                    className="px-3 py-1.5 font-bold rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    ← Anterior
                                </button>
                                <span className="px-3 py-1.5 font-bold text-slate-600">
                                    Página {currentPage + 1} de {totalPages}
                                </span>
                                <button
                                    onClick={() => setCurrentPage(prev => Math.min(totalPages - 1, prev + 1))}
                                    disabled={currentPage >= totalPages - 1}
                                    className="px-3 py-1.5 font-bold rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Siguiente →
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Title Header */}
            <div className={`px-6 py-4 border-b ${borderColor} ${bgColor}`}>
                <h3 className={`font-bold ${textColor} flex items-center gap-2`}>
                    {title}
                    <span className="bg-white px-2 py-0.5 rounded text-xs border border-slate-200 text-slate-500">
                        {showAll ? `${items.length} Equipos` : 'Top 5 Críticos'}
                    </span>
                </h3>
            </div>

            <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-500 font-semibold uppercase text-xs">
                    <tr>
                        <th className="px-4 py-3">Equipo</th>
                        <th className="px-4 py-3 text-center">Fallas L1</th>
                        <th className="px-4 py-3 text-right">Estado</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {top10.map((item: any) => (
                        <TrackingRow
                            key={item.equipment}
                            item={item}
                            repairData={repairData}
                            onUpdateStatus={onUpdateStatus}
                            onAddComment={onAddComment}
                            selectedDevice={selectedDevice}
                            onSelectDevice={onSelectDevice}
                            showAll={showAll}
                            onViewDetails={onViewDetails}
                        />
                    ))}
                    {top10.length === 0 && (
                        <tr>
                            <td colSpan={3} className="px-4 py-8 text-center">
                                <div className="text-slate-400 italic">
                                    {showAll ? (
                                        'No se encontraron equipos.'
                                    ) : (
                                        'No se encontraron equipos en este grupo.'
                                    )}
                                </div>
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
};

// Componente de Pestaña
const TabButton = ({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) => (
    <button
        onClick={onClick}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all ${active
            ? 'bg-blue-600 text-white shadow-md'
            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
            }`}
    >
        {icon}
        {label}
    </button>
);

// Constantes
const RECORDS_PER_PAGE = 50;

const ALL_MONTHS = [
    { id: 'January', label: 'Enero' },
    { id: 'February', label: 'Febrero' },
    { id: 'March', label: 'Marzo' },
    { id: 'April', label: 'Abril' },
    { id: 'May', label: 'Mayo' },
    { id: 'June', label: 'Junio' },
    { id: 'July', label: 'Julio' },
    { id: 'August', label: 'Agosto' },
    { id: 'September', label: 'Septiembre' },
    { id: 'October', label: 'Octubre' },
    { id: 'November', label: 'Noviembre' },
    { id: 'December', label: 'Diciembre' }
];

export default function TracklogDashboard() {
    const [data, setData] = useState<ProcessedData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [lastUpdate, setLastUpdate] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabType>('dashboard');
    const [trackingFilter, setTrackingFilter] = useState<'all' | 'yanacocha' | 'repsol'>('all');

    // Estado para Seguimiento Correctivo
    const [repairData, setRepairData] = useState<Record<string, RepairTracking>>({});

    // Estado para filtro de nivel en Seguimiento General
    const [generalSeverityFilter, setGeneralSeverityFilter] = useState<'all' | 'L1' | 'L2' | 'L3'>('all');

    // Estado para filtro de estado de reparación en Seguimiento General
    const [generalStatusFilter, setGeneralStatusFilter] = useState<'all' | 'Pendiente' | 'En Proceso' | 'Validando' | 'Reparado'>('all');
    const [generalComponentFilter, setGeneralComponentFilter] = useState<'all' | 'ssd' | 'sd' | 'other'>('all');

    // Cargar datos de reparación persistentes
    useEffect(() => {
        const saved = localStorage.getItem('repair_tracking_db');
        if (saved) {
            try {
                setRepairData(JSON.parse(saved));
            } catch (e) {
                console.error("Error cargando tracking DB", e);
            }
        }
    }, []);

    // Helper: Generate unique ID for comments
    const generateCommentId = () => `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Helper: Create system comment
    const createSystemComment = (text: string): Comment => ({
        id: generateCommentId(),
        text,
        author: 'Sistema',
        timestamp: new Date().toISOString(),
        type: 'system'
    });

    // Guardar cambios en reparación
    const updateRepairStatus = (deviceId: string, status: RepairTracking['status'], macroGroup: 'Yanacocha' | 'Repsol' | 'General', alerts: number) => {
        const existing = repairData[deviceId];
        const now = new Date().toISOString();

        // Crear comentario del sistema si cambió el estado
        const statusChanged = existing && existing.status !== status;
        const newComments = existing?.comments || [];

        if (statusChanged) {
            newComments.push(createSystemComment(
                `Estado cambiado de "${existing.status}" a "${status}"`
            ));
        }

        // Si es nuevo registro, agregar comentario de creación
        if (!existing) {
            newComments.push(createSystemComment(
                `Equipo agregado al seguimiento con ${alerts} alerta(s)`
            ));
        }

        const updated = {
            ...repairData,
            [deviceId]: {
                deviceId,
                macroGroup,
                initialAlerts: existing?.initialAlerts || alerts,
                status,
                repairDate: status === 'Reparado' ? now : existing?.repairDate,
                notes: existing?.notes,

                // New fields with defaults
                comments: newComments,
                priority: existing?.priority || 'Media', // Default priority
                assignedTo: existing?.assignedTo,
                estimatedCompletionDate: existing?.estimatedCompletionDate,
                actualCompletionDate: status === 'Reparado' ? now : existing?.actualCompletionDate,
                lastModifiedBy: 'Usuario', // TODO: Get from auth system
                lastModifiedDate: now,
                createdDate: existing?.createdDate || now
            }
        };
        setRepairData(updated);
        localStorage.setItem('repair_tracking_db', JSON.stringify(updated));
    };

    // Add user comment to equipment
    const addComment = (deviceId: string, commentText: string, author: string = 'Usuario') => {
        const existing = repairData[deviceId];
        if (!existing) return;

        const newComment: Comment = {
            id: generateCommentId(),
            text: commentText,
            author,
            timestamp: new Date().toISOString(),
            type: 'user'
        };

        const updated = {
            ...repairData,
            [deviceId]: {
                ...existing,
                comments: [...existing.comments, newComment],
                lastModifiedBy: author,
                lastModifiedDate: new Date().toISOString()
            }
        };

        setRepairData(updated);
        localStorage.setItem('repair_tracking_db', JSON.stringify(updated));
    };

    // Update priority
    // const updatePriority = (deviceId: string, priority: RepairTracking['priority']) => {
    //     const existing = repairData[deviceId];
    //     if (!existing) return;

    //     const systemComment = createSystemComment(`Prioridad cambiada a "${priority}"`);
    //     const updated = {
    //         ...repairData,
    //         [deviceId]: {
    //             ...existing,
    //             priority,
    //             comments: [...existing.comments, systemComment],
    //             lastModifiedBy: 'Usuario',
    //             lastModifiedDate: new Date().toISOString()
    //         }
    //     };

    //     setRepairData(updated);
    //     localStorage.setItem('repair_tracking_db', JSON.stringify(updated));
    // };

    // Update assigned technician
    // const updateAssignment = (deviceId: string, assignedTo: string | undefined) => {
    //     const existing = repairData[deviceId];
    //     if (!existing) return;

    //     const systemComment = createSystemComment(
    //         assignedTo ? `Asignado a: ${assignedTo}` : 'Asignación removida'
    //     );

    //     const updated = {
    //         ...repairData,
    //         [deviceId]: {
    //             ...existing,
    //             assignedTo,
    //             comments: [...existing.comments, systemComment],
    //             lastModifiedBy: 'Usuario',
    //             lastModifiedDate: new Date().toISOString()
    //         }
    //     };

    //     setRepairData(updated);
    //     localStorage.setItem('repair_tracking_db', JSON.stringify(updated));
    // };

    // Update estimated completion date
    // const updateEstimatedDate = (deviceId: string, date: string | undefined) => {
    //     const existing = repairData[deviceId];
    //     if (!existing) return;

    //     const systemComment = createSystemComment(
    //         date ? `Fecha estimada de finalización: ${new Date(date).toLocaleDateString()}` : 'Fecha estimada removida'
    //     );

    //     const updated = {
    //         ...repairData,
    //         [deviceId]: {
    //             ...existing,
    //             estimatedCompletionDate: date,
    //             comments: [...existing.comments, systemComment],
    //             lastModifiedBy: 'Usuario',
    //             lastModifiedDate: new Date().toISOString()
    //         }
    //     };

    //     setRepairData(updated);
    //     localStorage.setItem('repair_tracking_db', JSON.stringify(updated));
    // };

    // Estados de Filtro (para Dashboard KPIs)
    const [filterAction, setFilterAction] = useState<string | null>(null);
    const [dashboardComponent, setDashboardComponent] = useState<'all' | 'ssd' | 'sd' | 'other'>('all');
    const [scopeFilter, setScopeFilter] = useState<'customer' | 'internal' | 'all'>('customer'); // Default: Clientes
    const [selectedTrackingDevice, setSelectedTrackingDevice] = useState<string | null>(null);

    // Estados de Filtro para Registros
    const [searchTerm, setSearchTerm] = useState('');
    const [filterFleet, setFilterFleet] = useState<string>('all');
    const [filterSeverity, setFilterSeverity] = useState<string>('all');
    const [filterComponent, setFilterComponent] = useState<string>('all');
    const [dateRange, setDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
    const [selectedMonths, setSelectedMonths] = useState<string[]>(['January', 'February', 'March']); // Default months

    const [availableMonths, setAvailableMonths] = useState<{ id: string, label: string, file: string }[]>([
        { id: 'January', label: 'Enero', file: '/diskAlarm_January.csv' },
        { id: 'February', label: 'Febrero', file: '/diskAlarm_February.csv' },
        { id: 'March', label: 'Marzo', file: '/diskAlarm_March.csv' },
    ]);
    const [filterPv, setFilterPv] = useState<string>('all');
    const [filterModel, setFilterModel] = useState<string>('all');
    const [hasSearched, setHasSearched] = useState(false);

    // Paginación
    const [currentPage, setCurrentPage] = useState(1);

    // NUEVO: Modo de Vista (Alertas vs Equipos)
    const [viewMode, setViewMode] = useState<'alerts' | 'devices'>('alerts');

    // NUEVO: Estado para Modal de Detalles
    const [viewingDeviceDetails, setViewingDeviceDetails] = useState<string | null>(null);

    // NUEVO: Selección para Orden de Trabajo
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // Handler para selección individual
    const toggleSelection = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedIds(newSet);
    };

    // Handler para "Seleccionar Todo" (de la página actual)
    const toggleSelectAll = () => {
        const newSet = new Set(selectedIds);
        const allSelected = (paginatedData as DeviceGroup[]).every(item => newSet.has(item.equipment));

        if (allSelected) {
            (paginatedData as DeviceGroup[]).forEach(item => newSet.delete(item.equipment));
        } else {
            (paginatedData as DeviceGroup[]).forEach(item => newSet.add(item.equipment));
        }
        setSelectedIds(newSet);
    };

    // Handler Generar PDF
    const handleGeneratePDF = () => {
        const selectedItems = groupedData.filter(g => selectedIds.has(g.equipment));
        generateWorkOrderPDF(selectedItems);
    };






    // Funciones de Respaldo (Backup)
    const handleExportBackup = () => {
        const dataStr = JSON.stringify(repairData, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const exportFileDefaultName = `tracklog_repair_backup_${new Date().toISOString().split('T')[0]}.json`;

        const linkElement = document.createElement('a');
        linkElement.href = url;
        linkElement.download = exportFileDefaultName;
        linkElement.click();
        URL.revokeObjectURL(url);
    };

    const handleImportBackup = (event: React.ChangeEvent<HTMLInputElement>) => {
        const fileReader = new FileReader();
        if (event.target.files && event.target.files.length > 0) {
            fileReader.readAsText(event.target.files[0], "UTF-8");
            event.target.value = ''; // Reset input
            fileReader.onload = (e) => {
                try {
                    if (e.target?.result) {
                        const parsedData = JSON.parse(e.target.result as string);
                        // Validación básica
                        if (typeof parsedData === 'object' && parsedData !== null) {
                            setRepairData(parsedData);
                            localStorage.setItem('repair_tracking_db', JSON.stringify(parsedData));
                            alert('Respaldo cargado exitosamente.');
                        } else {
                            alert('El archivo no tiene un formato válido.');
                        }
                    }
                } catch (error) {
                    console.error("Error parsing JSON", error);
                    alert('Error al leer el archivo de respaldo.');
                }
            };
        }
    };

    // 1. CARGA INTELIGENTE DE DATOS
    const loadData = async (force: boolean = false) => {
        setIsLoading(true);

        const CACHE_KEY_DATA = 'tracklog_db_v2';
        const CACHE_KEY_LAST_MODIFIED = 'tracklog_last_modified';
        const CACHE_KEY_DATE = 'tracklog_date';

        try {
            let currentAvailable = [...availableMonths];
            let currentSelected = [...selectedMonths];

            if (force) {
                console.log("Verificando archivos mensuales disponibles...");
                const monthChecks = await Promise.all(
                    ALL_MONTHS.map(async (m) => {
                        try {
                            const res = await fetch(`/diskAlarm_${m.id}.csv`, { method: 'HEAD', cache: 'no-cache' });
                            return { month: m, exists: res.ok };
                        } catch (e) {
                            return { month: m, exists: false };
                        }
                    })
                );

                const foundMonths = monthChecks
                    .filter(mc => mc.exists)
                    .map(mc => ({ ...mc.month, file: `/diskAlarm_${mc.month.id}.csv` }));

                if (foundMonths.length > 0) {
                    setAvailableMonths(foundMonths);
                    currentAvailable = foundMonths;

                    const newlyFound = foundMonths.map(m => m.id).filter(id => !availableMonths.some(am => am.id === id));
                    if (newlyFound.length > 0) {
                        currentSelected = Array.from(new Set([...currentSelected, ...newlyFound]));
                        setSelectedMonths(currentSelected);
                        console.log("Nuevos meses detectados y seleccionados:", newlyFound);
                    }
                }
            }

            // Paso 1: Verificar si el archivo ha cambiado en el servidor (HEAD Request)
            let serverLastModified: string | null = null;
            try {
                const fallbackFile = currentSelected.length > 0 ? `/diskAlarm_${currentSelected[0]}.csv` : '/diskAlarm_January.csv';
                const headResponse = await fetch(fallbackFile, { method: 'HEAD' });
                if (headResponse.ok) {
                    serverLastModified = headResponse.headers.get('last-modified');
                }
            } catch (e) {
                console.warn("No se pudo verificar fecha del archivo, procediendo con carga estándar", e);
            }

            // Paso 2: Decidir si usar caché
            // Usamos caché SI:
            // - No se forzó la actualización
            // - Tenemos fecha guardada Y coincide con la del servidor (o el servidor no nos dio fecha)
            // - Existe data en localStorage
            const storedLastModified = localStorage.getItem(CACHE_KEY_LAST_MODIFIED);

            // Si el servidor nos dio fecha, y es diferente a la guardada -> NUEVA VERSIÓN DETECTADA
            const hasNewVersion = serverLastModified && storedLastModified && serverLastModified !== storedLastModified;

            if (!force && !hasNewVersion) {
                const savedData = localStorage.getItem(CACHE_KEY_DATA);
                const savedDate = localStorage.getItem(CACHE_KEY_DATE);

                if (savedData) {
                    try {
                        const parsed = JSON.parse(savedData);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            console.log("Cargando desde caché (Versión actual)");
                            setData(parsed);
                            setLastUpdate(savedDate || 'Recuperado de caché');
                            setIsLoading(false);
                            return; // ÉXITO: Datos cargados de caché
                        }
                    } catch (e) {
                        console.error("Error caché local (corrupto)", e);
                        // Datos corruptos, continuaremos a descargar
                    }
                }
            } else if (hasNewVersion) {
                console.log("Nueva versión del archivo detectada. Actualizando caché...");
            }

            // Paso 3: Cargar desde Red
            // LISTA DE ARCHIVOS DE ALARMAS BASADA EN SELECCIÓN
            const selectedFiles = currentAvailable
                .filter(m => currentSelected.includes(m.id))
                .map(m => m.file);

            if (selectedFiles.length === 0) {
                setData([]);
                setIsLoading(false);
                return;
            }

            const promises = [
                ...selectedFiles.map(file => fetch(file)),
                fetch('/mdvrDetailsPvModel.csv'),
                fetch('/mdvrVideotracklogAll.csv')
            ];

            const responses = await Promise.all(promises);

            // Separar respuestas
            const alertResponses = responses.slice(0, selectedFiles.length);
            const mdvrResponse = responses[selectedFiles.length];
            const fleetResponse = responses[selectedFiles.length + 1];

            // Combinar textos de alarmas
            let fullAlertsText = '';
            let headerSaved = false;

            for (const res of alertResponses) {
                if (res.ok) {
                    const text = await res.text();
                    // Validate content: Must not start with HTML tag
                    if (text.trim().startsWith('<')) {
                        console.warn(`Archivo ignorado (parece HTML/404): ${alertResponses.indexOf(res)}`);
                        continue;
                    }

                    if (!headerSaved) {
                        fullAlertsText += text;
                        headerSaved = true;
                    } else {
                        // Omitir header de archivos subsecuentes (asumiendo que tienen header)
                        const lines = text.split('\n');
                        if (lines.length > 1) {
                            fullAlertsText += '\n' + lines.slice(1).join('\n');
                        }
                    }

                    // Usar fecha del último archivo modificado
                    const lastMod = res.headers.get('last-modified');
                    if (lastMod) serverLastModified = lastMod;
                }
            }

            if (fullAlertsText) {
                /* const alertsText = await alertsResponse.text(); NO USAR: Ya tenemos fullAlertsText */

                // Actualizar timestamp
                if (!serverLastModified) {
                    serverLastModified = new Date().toUTCString();
                }

                let mdvrMap: Map<string, MdvrDetails> | undefined;
                if (mdvrResponse.ok) {
                    const mdvrText = await mdvrResponse.text();
                    mdvrMap = parseMdvrDetails(mdvrText);
                }

                // Parsear flota auxiliar
                let fleetMap = new Map<string, string>();
                if (fleetResponse.ok) {
                    const fleetText = await fleetResponse.text();
                    const lines = fleetText.split('\n');
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        const parts = line.split(';');
                        // El formato parece ser: Device Name (ID); Node name; ...
                        if (parts.length > 3) {
                            const rawDevName = parts[0].trim();
                            // Normalizar nombre igual que en processCSV: quitar (ID)
                            const nameMatch = rawDevName.match(/^(.*)\((\d+)\)$/);
                            const devName = nameMatch ? nameMatch[1].trim() : rawDevName;

                            const fleet = parts[3].trim();
                            if (devName && fleet) fleetMap.set(devName, fleet);
                        }
                    }
                }

                // Ahora pasando fleetMap a processCSV
                const processed = processCSV(fullAlertsText, mdvrMap, fleetMap);
                setData(processed);

                const now = new Date().toLocaleString();
                setLastUpdate(now);

                // NOTA: Desactivamos caché en localStorage para la data principal
                // porque >100MB excede el límite del navegador y causa errores.
                /*
                try {
                    localStorage.setItem(CACHE_KEY_DATA, JSON.stringify(processed));
                    localStorage.setItem(CACHE_KEY_DATE, now);
                     if (serverLastModified) {
                        localStorage.setItem(CACHE_KEY_LAST_MODIFIED, serverLastModified);
                    }
                } catch (cacheError) {
                    console.warn("Caché llena u omitida por tamaño:", cacheError);
                }
                */
            }
        } catch (err) {
            console.error("Error de red:", err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadData(false); // Carga inicial desde caché si existe
    }, [selectedMonths]);



    // --- ANALÍTICA & FILTROS ---

    // PRE-PROCESO: Aplicar Filtro de Scope (Clientes vs Tracklog)
    const scopedData = useMemo(() => {
        if (scopeFilter === 'all') return data;
        return data.filter(d => {
            const inInternalSet = TRACKLOG_INTERNAL_FLEETS.has(d.Fleet) || d.Fleet === 'TRACKLOG';
            return scopeFilter === 'internal' ? inInternalSet : !inInternalSet;
        });
    }, [data, scopeFilter]);

    const uniqueFleets = useMemo(() => Array.from(new Set(scopedData.map(d => d.Fleet))).sort(), [scopedData]);

    // Obtener fechas únicas de los datos
    const uniqueDates = useMemo(() => {
        const dates = new Set<string>();
        scopedData.forEach(d => {
            if (d.Date) {
                // Extraer solo la fecha (sin hora) - formato esperado: "YYYY-MM-DD" o "DD/MM/YYYY"
                const dateOnly = d.Date.split(' ')[0];

                // VALIDACIÓN: Solo permitir lo que parece una fecha (números y separadores)
                // Esto elimina basura como "satellites:..." si el CSV está malformado
                const isDate = /^[\d\-\/]+$/.test(dateOnly) && dateOnly.length >= 8;

                if (dateOnly && isDate) {
                    dates.add(dateOnly);
                }
            }
        });
        return Array.from(dates).sort((a, b) => parseDateLocal(b) - parseDateLocal(a));
    }, [scopedData]);

    // Obtener ejecutivos únicos
    const uniquePvNames = useMemo(() => {
        const pvNames = new Set<string>();
        scopedData.forEach(d => {
            if (d.pvName && d.pvName !== 'Sin Asignar') {
                pvNames.add(d.pvName);
            }
        });
        return Array.from(pvNames).sort();
    }, [scopedData]);

    // Obtener modelos únicos
    const uniqueModels = useMemo(() => {
        const models = new Set<string>();
        scopedData.forEach(d => {
            if (d.model && d.model !== 'Sin Asignar') {
                models.add(d.model);
            }
        });
        return Array.from(models).sort();
    }, [scopedData]);



    const stats = useMemo(() => {
        // Filtrado por componente (Global para el Dashboard)
        const statsData = dashboardComponent === 'all'
            ? scopedData
            : scopedData.filter(d =>
                dashboardComponent === 'ssd' ? d.component === 'SSD/HDD' :
                    dashboardComponent === 'sd' ? d.component === 'SD/Firebox' :
                        d.component === 'Otros'
            );

        const totalAlerts = statsData.length;

        // Contar equipos únicos totales
        const uniqueDevices = new Set(statsData.map(d => d.ID || d.DeviceName));
        const totalDevices = uniqueDevices.size;

        // Contar equipos únicos por tipo de acción y alertas totales
        const criticalRows = statsData.filter(d => d.action === 'Reemplazo Físico');
        const criticalDevices = new Set(criticalRows.map(d => d.ID || d.DeviceName));
        const criticalAlerts = criticalRows.length;

        const logicalRows = statsData.filter(d => d.action === 'Mantenimiento Lógico');
        const logicalDevices = new Set(logicalRows.map(d => d.ID || d.DeviceName));
        const logicalAlerts = logicalRows.length;

        const reviewRows = statsData.filter(d => d.action === 'Revisión Config/Instalación');
        const reviewDevices = new Set(reviewRows.map(d => d.ID || d.DeviceName));
        const reviewAlerts = reviewRows.length;

        const critical = criticalDevices.size;
        const logical = logicalDevices.size;
        const review = reviewDevices.size;

        // Filtrar datos para gráficos según la categoría seleccionada (usando statsData filtrado por componente)
        const filteredForCharts = filterAction
            ? statsData.filter(d => d.action === filterAction)
            : statsData;

        // Agrupación para Gráficos (equipos únicos) - respeta el filtro
        const actionData = [
            { name: 'Reemplazo Físico', value: critical, color: '#ef4444' },
            { name: 'Mantenimiento Lógico', value: logical, color: '#f59e0b' },
            { name: 'Revisión Config', value: review, color: '#3b82f6' },
        ].filter(d => d.value > 0);

        // Flotas con mayor incidencia (equipos únicos por flota) - respeta el filtro
        const fleetMap: Record<string, Set<string>> = {};
        filteredForCharts.forEach(d => {
            const deviceId = d.ID || d.DeviceName;
            if (!fleetMap[d.Fleet]) fleetMap[d.Fleet] = new Set();
            fleetMap[d.Fleet].add(deviceId);
        });
        const fleetData = Object.entries(fleetMap)
            .map(([name, devices]) => ({ name, value: devices.size }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 8); // Top 8

        // Agrupación por Día (Tendencia)
        const trendMap: Record<string, number> = {};
        scopedData.forEach(d => {
            if (d.Date) {
                const day = d.Date.split(' ')[0];
                // VALIDACIÓN EXTENDIDA: Filtrar basura tipo "satellites:..."
                const isDate = /^[\d\-\/]+$/.test(day) && day.length >= 8;

                if (day && isDate) {
                    trendMap[day] = (trendMap[day] || 0) + 1;
                }
            }
        });
        // Convertir a array y ordenar por fecha (ascendente para gráfico lineal)
        const trendData = Object.entries(trendMap)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => parseDateLocal(a.date) - parseDateLocal(b.date));

        return { totalAlerts, totalDevices, critical, logical, review, actionData, fleetData, trendData, criticalAlerts, logicalAlerts, reviewAlerts };
    }, [scopedData, filterAction, dashboardComponent]);

    // Lógica de Filtrado para Registros (solo cuando se ha buscado)
    const filteredData = useMemo(() => {
        if (!hasSearched) return [];

        return scopedData.filter(item => {
            // Buscador Texto
            const matchesSearch = !searchTerm ||
                item.DeviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                item.DiskDetails.toLowerCase().includes(searchTerm.toLowerCase()) ||
                item.diagnosis.toLowerCase().includes(searchTerm.toLowerCase());

            // Dropdowns
            const matchesFleet = filterFleet === 'all' ? true : item.Fleet === filterFleet;
            const matchesSeverity = filterSeverity === 'all' ? true : item.severity === filterSeverity;
            const matchesComponent = filterComponent === 'all' ? true :
                (filterComponent === 'ssd' ? item.component === 'SSD/HDD' :
                    filterComponent === 'sd' ? item.component === 'SD/Firebox' :
                        item.component === 'Otros');
            const matchesPv = filterPv === 'all' ? true : item.pvName === filterPv;
            const matchesModel = filterModel === 'all' ? true : item.model === filterModel;

            // Filtro por rango de fechas
            if (dateRange.start) {
                const start = parseDateLocal(dateRange.start); // Timestamp
                const itemTime = parseDateLocal(item.Date);
                if (itemTime < start) return false;
            }
            if (dateRange.end) {
                // End date should be inclusive of the whole day, so we compare strictly or add 1 day
                // Simplest: Check timestamp. parseDateLocal returns 00:00 of date.
                // If we want inclusive end date: itemTime <= end
                const end = parseDateLocal(dateRange.end) + (24 * 60 * 60 * 1000) - 1; // End of day
                const itemTime = parseDateLocal(item.Date);
                if (itemTime > end) return false;
            }

            return matchesSearch && matchesFleet && matchesSeverity && matchesComponent && matchesPv && matchesModel;
        });
    }, [scopedData, searchTerm, filterFleet, filterSeverity, filterComponent, dateRange, filterPv, filterModel, hasSearched]);

    // Lógica de Agrupación por Equipo (GLOBAL para Tracking y Tabla)
    const groupedData = useMemo(() => {
        // ALWAYS COMPUTE (needed for Tracking tab)
        // if (viewMode !== 'devices') return [];

        const groups = new Map<string, DeviceGroup>();

        // Detectar fuente: si hay búsqueda activa, agrupamos los resultados filtrados.
        // Si no (ej. carga inicial para Tracking), usamos todos los datos.
        const source = hasSearched ? filteredData : scopedData;

        source.forEach(item => {
            const key = item.ID || item.DeviceName; // Agrupar por ID si existe, sino por nombre (igual que Dashboard)

            if (!groups.has(key)) {
                groups.set(key, {
                    id: item.ID || '',
                    equipment: item.DeviceName,
                    fleet: item.Fleet,
                    model: item.model,
                    pv: item.pvName,
                    totalAlerts: 0,
                    highSeverityCount: 0,
                    maxSeverity: 'Baja',
                    worstDiagnosis: '',
                    suggestedAction: '',
                    component: item.component,
                    diskType: item.DiskType
                });
            }

            const group = groups.get(key)!;
            group.totalAlerts++;

            // Determinar severidad máxima
            const severityOrder = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
            if (severityOrder[item.severity] > severityOrder[group.maxSeverity]) {
                group.maxSeverity = item.severity;
                group.worstDiagnosis = item.diagnosis;
                group.suggestedAction = item.action;
            } else if (severityOrder[item.severity] === severityOrder[group.maxSeverity]) {
                // Si es la misma severidad, concatenar diagnóstico si es diferente y no es muy largo
                if (!group.worstDiagnosis.includes(item.diagnosis) && group.worstDiagnosis.length < 100) {
                    group.worstDiagnosis += " | " + item.diagnosis;
                }
            }

            if (item.severity === 'Alta') group.highSeverityCount++;
        });

        return Array.from(groups.values()).sort((a, b) => {
            // Ordenar: primero críticos, luego por cantidad de alertas
            const sevOrder = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
            if (sevOrder[b.maxSeverity] !== sevOrder[a.maxSeverity]) {
                return sevOrder[b.maxSeverity] - sevOrder[a.maxSeverity];
            }
            return b.totalAlerts - a.totalAlerts;
        });

    }, [filteredData, viewMode, scopedData, hasSearched]);

    // Paginación (Dinámica según el modo)
    const currentDataSource = viewMode === 'devices' ? groupedData : filteredData;
    const totalPages = Math.ceil(currentDataSource.length / RECORDS_PER_PAGE);

    const paginatedData = useMemo(() => {
        const start = (currentPage - 1) * RECORDS_PER_PAGE;
        // @ts-ignore - TypeScript puede quejarse por tipos union, pero es seguro
        return currentDataSource.slice(start, start + RECORDS_PER_PAGE);
    }, [currentDataSource, currentPage]);

    // Handler de búsqueda
    const handleSearch = () => {
        setHasSearched(true);
        setCurrentPage(1);
    };

    // Reset filtros
    const resetFilters = () => {
        setSearchTerm('');
        setFilterFleet('all');
        setFilterSeverity('all');
        setFilterComponent('all');
        setDateRange({ start: '', end: '' });
        setFilterPv('all');
        setFilterModel('all');
        setHasSearched(false);
        setCurrentPage(1);
    };

    return (
        <div className="min-h-screen bg-slate-50 font-sans text-slate-900">

            {/* HEADER DE GESTIÓN */}
            <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-6 py-4">
                    <div className="flex justify-between items-center">

                        {/* Logo & Status */}
                        <div className="flex items-center gap-3">
                            <div className="bg-blue-600 p-2 rounded-lg shadow-sm">
                                <Database className="w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-slate-900 tracking-tight leading-none">TRACKLOG DISK MANAGER</h1>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className="text-xs font-medium text-slate-500">Gestión de Almacenamiento MDVR</span>
                                    {lastUpdate && (
                                        <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200">
                                            Actualizado: {lastUpdate}
                                        </span>
                                    )}
                                    <div className="flex bg-slate-200 rounded-lg p-0.5 mr-2">
                                        <button
                                            onClick={() => setScopeFilter('customer')}
                                            className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${scopeFilter === 'customer' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            Clientes
                                        </button>
                                        <button
                                            onClick={() => setScopeFilter('internal')}
                                            className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${scopeFilter === 'internal' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            Tracklog
                                        </button>
                                        <button
                                            onClick={() => setScopeFilter('all')}
                                            className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${scopeFilter === 'all' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            Todos
                                        </button>
                                    </div>
                                    {/* ACTION AREA: MONTH SELECTOR & REFRESH */}
                                    <div className="flex items-center gap-4">
                                        <div className="flex items-center gap-2 bg-slate-100 rounded-lg p-1">
                                            {availableMonths.map(month => (
                                                <button
                                                    key={month.id}
                                                    onClick={() => {
                                                        const newSelection = selectedMonths.includes(month.id)
                                                            ? selectedMonths.filter(m => m !== month.id)
                                                            : [...selectedMonths, month.id];
                                                        setSelectedMonths(newSelection);
                                                        // Trigger reload effectively? Ideally we call loadData, but state update is async.
                                                        // Better to have a explicit "Apply" or "Reload" button, or auto-reload in useEffect (dangerous with file fetching).
                                                        // Let's rely on the Update button.
                                                    }}
                                                    className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${selectedMonths.includes(month.id)
                                                        ? 'bg-white text-blue-600 shadow-sm'
                                                        : 'text-slate-400 hover:text-slate-600'
                                                        }`}
                                                >
                                                    {month.label}
                                                </button>
                                            ))}
                                        </div>

                                        <button
                                            onClick={() => loadData(true)}
                                            disabled={isLoading}
                                            className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
                                        >
                                            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                                            {isLoading ? 'Cargando...' : 'Actualizar Data'}
                                        </button>
                                    </div>
                                    <div className="h-6 w-px bg-slate-300 mx-2"></div>

                                    <div className="flex items-center gap-1 bg-slate-100 rounded p-0.5 border border-slate-300">
                                        <button
                                            onClick={handleExportBackup}
                                            className="flex items-center gap-1 bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2 py-0.5 rounded shadow-sm transition-colors text-[10px] font-bold uppercase tracking-wider"
                                            title="Guardar respaldo (Descargar JSON)"
                                        >
                                            <Download className="w-3 h-3" /> Guardar
                                        </button>
                                        <label
                                            className="flex items-center gap-1 bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2 py-0.5 rounded shadow-sm transition-colors text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                                            title="Cargar respaldo (Subir JSON)"
                                        >
                                            <Upload className="w-3 h-3" /> Cargar
                                            <input
                                                type="file"
                                                accept=".json"
                                                className="hidden"
                                                onChange={handleImportBackup}
                                            />
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* TABS NAVIGATION */}
            {!isLoading && data.length > 0 && (
                <>
                    <div className="bg-slate-100 border-b border-slate-200">
                        <div className="max-w-7xl mx-auto px-6 py-3">
                            <div className="flex gap-2">
                                <TabButton
                                    active={activeTab === 'dashboard'}
                                    onClick={() => setActiveTab('dashboard')}
                                    icon={<LayoutDashboard className="w-4 h-4" />}
                                    label="Dashboard"
                                />
                                <TabButton
                                    active={activeTab === 'records'}
                                    onClick={() => setActiveTab('records')}
                                    icon={<Table className="w-4 h-4" />}
                                    label="Registros"
                                />
                                <TabButton
                                    active={activeTab === 'tracking'}
                                    onClick={() => setActiveTab('tracking')}
                                    icon={<Hammer className="w-4 h-4" />}
                                    label="Seguimiento Correctivo"
                                />
                                <TabButton
                                    active={activeTab === 'general-tracking'}
                                    onClick={() => setActiveTab('general-tracking')}
                                    icon={<Activity className="w-4 h-4" />}
                                    label="Seguimiento General"
                                />
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* BODY */}
            <main className="max-w-7xl mx-auto px-6 py-8">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-[60vh]">
                        <div className="relative">
                            {/* Spinner animado */}
                            <div className="w-20 h-20 border-4 border-slate-200 rounded-full"></div>
                            <div className="w-20 h-20 border-4 border-blue-600 rounded-full absolute top-0 left-0 animate-spin border-t-transparent"></div>
                        </div>
                        <div className="mt-8 text-center">
                            <h2 className="text-xl font-bold text-slate-800 mb-2">Cargando Datos...</h2>
                            <p className="text-slate-500">Procesando información de almacenamiento MDVR</p>
                        </div>
                    </div>
                ) : data.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-[60vh] border-2 border-dashed border-slate-300 rounded-2xl bg-white text-center p-12">
                        <div className="bg-red-50 p-6 rounded-full mb-6 ring-8 ring-red-50/50">
                            <AlertTriangle className="w-16 h-16 text-red-400" />
                        </div>
                        <h2 className="text-2xl font-bold text-slate-800 mb-2">Error al Cargar Datos</h2>
                        <p className="text-slate-500 max-w-md mb-8">
                            No se pudo cargar la base de datos. Verifique que el archivo CSV esté disponible.
                        </p>
                        <button
                            onClick={() => window.location.reload()}
                            className="px-8 py-4 bg-blue-600 text-white rounded-xl hover:bg-blue-500 font-bold shadow-lg shadow-blue-200 transition-all"
                        >
                            Reintentar
                        </button>
                    </div>
                ) : (
                    <>
                        {/* TAB: DASHBOARD */}
                        {activeTab === 'dashboard' && (
                            <div className="space-y-8">
                                {/* SECCIÓN KPIS */}
                                <section>

                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center gap-2 group relative">
                                            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Resumen de Estado</h3>
                                            <div className="cursor-help text-slate-400 hover:text-blue-500 transition-colors">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-info"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                                            </div>

                                            {/* TOOLTIP LEYENDA */}
                                            <div className="absolute left-0 top-6 w-72 bg-slate-800 text-white text-xs p-3 rounded-lg shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
                                                <div className="mb-2 font-bold text-slate-200 border-b border-slate-600 pb-1">Leyenda de Errores MDVR</div>
                                                <ul className="space-y-2">
                                                    <li><span className="text-red-400 font-bold">[L1] Crítico:</span> Sectores dañados, fallo S.M.A.R.T. Requiere reemplazo físico.</li>
                                                    <li><span className="text-amber-400 font-bold">[L2] Revisión:</span> Escritura lenta, pausas. Revisar vibración o config.</li>
                                                    <li><span className="text-blue-400 font-bold">[L3] Lógico:</span> Error de sistema de archivos. Se resuelve formateando.</li>
                                                </ul>
                                            </div>
                                        </div>
                                        <div className="flex justify-between items-center mb-6">
                                            <div className="flex items-center gap-4">
                                                {/* Filtro Componente */}
                                                <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg">
                                                    <button
                                                        onClick={() => setDashboardComponent('all')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'all' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                                    >
                                                        Todos
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('ssd')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'ssd' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                                    >
                                                        SSD/HDD
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('sd')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'sd' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                                    >
                                                        SD/Firebox
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('other')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'other' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                                    >
                                                        Otros
                                                    </button>
                                                </div>
                                            </div>

                                            {filterAction && (
                                                <button
                                                    onClick={() => setFilterAction(null)}
                                                    className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1"
                                                >
                                                    Limpiar Selección <span className="text-lg leading-none">×</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                        <KpiCard
                                            title="Total Equipos"
                                            value={stats.totalDevices.toLocaleString()}
                                            subtext={`${stats.totalAlerts.toLocaleString()} alertas`}
                                            icon={<HardDrive />}
                                            color="bg-slate-100 text-slate-600"
                                            isActive={filterAction === null}
                                            onClick={() => setFilterAction(null)}
                                        />
                                        <KpiCard
                                            title="L1 - Reemplazo Físico"
                                            value={stats.critical.toLocaleString()}
                                            subtext={`${stats.criticalAlerts.toLocaleString()} alertas`}
                                            icon={<AlertTriangle />}
                                            color="bg-red-100 text-red-600"
                                            isActive={filterAction === 'Reemplazo Físico'}
                                            onClick={() => setFilterAction('Reemplazo Físico')}
                                        />
                                        <KpiCard
                                            title="L2 - Revisión Config"
                                            value={stats.review.toLocaleString()}
                                            subtext={`${stats.reviewAlerts.toLocaleString()} alertas`}
                                            icon={<Wrench />}
                                            color="bg-amber-100 text-amber-600"
                                            isActive={filterAction === 'Revisión Config/Instalación'}
                                            onClick={() => setFilterAction('Revisión Config/Instalación')}
                                        />
                                        <KpiCard
                                            title="L3 - Mante. Lógico"
                                            value={stats.logical.toLocaleString()}
                                            subtext={`${stats.logicalAlerts.toLocaleString()} alertas`}
                                            icon={<CheckCircle />}
                                            color="bg-blue-100 text-blue-600"
                                            isActive={filterAction === 'Mantenimiento Lógico'}
                                            onClick={() => setFilterAction('Mantenimiento Lógico')}
                                        />
                                    </div>
                                </section>

                                {/* DASHBOARD RESUMIDO */}
                                <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                    {/* Top Flotas */}
                                    <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                                        <h3 className="text-base font-bold text-slate-800 mb-6 flex items-center gap-2">
                                            <Truck className="w-5 h-5 text-slate-400" /> Flotas con Mayor Incidencia
                                        </h3>
                                        <div className="h-64" style={{ minWidth: 0 }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={stats.fleetData} layout="vertical" margin={{ left: 10, right: 30, bottom: 0 }}>
                                                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                                                    <XAxis type="number" hide />
                                                    <YAxis dataKey="name" type="category" width={150} style={{ fontSize: '11px', fontWeight: 600, fill: '#475569' }} />
                                                    <RechartsTooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }} />
                                                    <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={20}>
                                                        {stats.fleetData.map((_, index) => (
                                                            <Cell key={`cell-${index}`} fill={index < 3 ? '#ef4444' : '#cbd5e1'} />
                                                        ))}
                                                        <LabelList
                                                            dataKey="value"
                                                            position="right"
                                                            style={{ fontSize: '11px', fontWeight: 600, fill: '#64748b' }}
                                                        />
                                                    </Bar>
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>

                                    {/* Distribución */}
                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                                        <h3 className="text-base font-bold text-slate-800 mb-6 flex items-center gap-2">
                                            <AlertOctagon className="w-5 h-5 text-slate-400" /> Carga de Trabajo
                                        </h3>
                                        <div className="h-64 flex items-center justify-center" style={{ minWidth: 0 }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <PieChart>
                                                    <Pie
                                                        data={stats.actionData}
                                                        cx="50%"
                                                        cy="50%"
                                                        innerRadius={60}
                                                        outerRadius={80}
                                                        paddingAngle={5}
                                                        dataKey="value"
                                                        label={({ value }) => value}
                                                        labelLine={false}
                                                    >
                                                        {stats.actionData.map((entry, index) => (
                                                            <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />
                                                        ))}
                                                    </Pie>
                                                    <RechartsTooltip />
                                                    <Legend verticalAlign="bottom" height={36} />
                                                </PieChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </section>

                                {/* GRAFICO DE TIEMPO (NUEVO) */}
                                <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                                    <h3 className="text-base font-bold text-slate-800 mb-6 flex items-center gap-2">
                                        <Activity className="w-5 h-5 text-slate-400" /> Tendencia de Fallas (Diario)
                                    </h3>
                                    <div className="h-72 w-full overflow-x-auto pb-4 custom-scrollbar">
                                        <div style={{ minWidth: `${Math.max(100, stats.trendData.length * 50)}px`, height: '100%', minHeight: '288px' }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <AreaChart data={stats.trendData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                                    <defs>
                                                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                                        </linearGradient>
                                                    </defs>
                                                    <XAxis dataKey="date" style={{ fontSize: '11px', fill: '#64748b' }} tickFormatter={(val) => val.slice(5)} /> {/* Mostrar solo MM-DD */}
                                                    <YAxis style={{ fontSize: '11px', fill: '#64748b' }} />
                                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                                    <RechartsTooltip
                                                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                                                        labelStyle={{ color: '#64748b', marginBottom: '0.5rem' }}
                                                    />
                                                    <Area type="monotone" dataKey="count" stroke="#3b82f6" fillOpacity={1} fill="url(#colorCount)" name="Alertas" />
                                                </AreaChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </section>

                                {/* Mensaje para ir a registros */}
                                <section className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
                                    <p className="text-blue-800 mb-3">
                                        Para ver el detalle de los registros, ve a la pestaña <strong>"Registros"</strong>
                                    </p>
                                    <button
                                        onClick={() => setActiveTab('records')}
                                        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium text-sm"
                                    >
                                        <Table className="w-4 h-4" />
                                        Ver Registros
                                    </button>
                                </section>
                            </div>
                        )
                        }

                        {/* TAB: REGISTROS */}
                        {
                            activeTab === 'records' && (
                                <div className="space-y-6">
                                    {/* BARRA DE BÚSQUEDA Y FILTROS */}
                                    <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                                        <div className="flex justify-between items-center mb-4">
                                            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                                                <Search className="w-5 h-5 text-slate-400" /> Buscar Registros
                                            </h3>
                                            <div className="flex bg-slate-100 rounded-lg p-1">
                                                <button
                                                    onClick={() => { setViewMode('alerts'); setCurrentPage(1); }}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'alerts'
                                                        ? 'bg-white text-blue-600 shadow-sm border border-slate-200'
                                                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
                                                        }`}
                                                >
                                                    Por Alerta
                                                </button>
                                                <button
                                                    onClick={() => { setViewMode('devices'); setCurrentPage(1); }}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'devices'
                                                        ? 'bg-white text-blue-600 shadow-sm border border-slate-200'
                                                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
                                                        }`}
                                                >
                                                    Por Equipo
                                                </button>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                                            {/* Filtro de FECHAS (Rango) - CON REACT-DATEPICKER */}
                                            <div className="lg:col-span-2 relative z-50">
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Rango de Fechas</label>
                                                <div className="relative">
                                                    <DatePicker
                                                        selectsRange={true}
                                                        startDate={dateRange.start ? new Date(parseDateLocal(dateRange.start)) : null}
                                                        endDate={dateRange.end ? new Date(parseDateLocal(dateRange.end)) : null}
                                                        onChange={(update) => {
                                                            const [start, end] = update;
                                                            setDateRange({
                                                                start: start ? start.toLocaleDateString() : '',
                                                                end: end ? end.toLocaleDateString() : ''
                                                            });
                                                        }}
                                                        isClearable={true}
                                                        placeholderText="Selecciona un rango de fechas..."
                                                        dateFormat="dd/MM/yyyy"
                                                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                                                        wrapperClassName="w-full"
                                                    />
                                                </div>
                                            </div>

                                            {/* Filtro por Flota */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Flota</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500"
                                                    value={filterFleet}
                                                    onChange={(e) => setFilterFleet(e.target.value)}
                                                    aria-label="Filtrar por flota"
                                                >
                                                    <option value="all">Todas las Flotas</option>
                                                    {uniqueFleets.map(f => (
                                                        <option key={f} value={f}>{f}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Filtro por Severidad */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Severidad</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500"
                                                    value={filterSeverity}
                                                    onChange={(e) => setFilterSeverity(e.target.value)}
                                                    aria-label="Filtrar por severidad"
                                                >
                                                    <option value="all">Cualquier Severidad</option>
                                                    <option value="Alta">Alta (Crítico)</option>
                                                    <option value="Media">Media (Lógico)</option>
                                                    <option value="Baja">Baja (Revisión)</option>
                                                </select>
                                            </div>

                                            {/* Filtro por Componente */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Disco</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500"
                                                    value={filterComponent}
                                                    onChange={(e) => setFilterComponent(e.target.value)}
                                                    aria-label="Filtrar por tipo de disco"
                                                >
                                                    <option value="all">Todos los Discos</option>
                                                    <option value="ssd">SSD / HDD</option>
                                                    <option value="sd">SD / Firebox</option>
                                                    <option value="other">Otros</option>
                                                </select>
                                            </div>

                                            {/* Filtro por Ejecutivo Postventa */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Ejecutivo Postventa</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500"
                                                    value={filterPv}
                                                    onChange={(e) => setFilterPv(e.target.value)}
                                                    aria-label="Filtrar por ejecutivo postventa"
                                                >
                                                    <option value="all">Todos los Ejecutivos</option>
                                                    {uniquePvNames.map(pv => (
                                                        <option key={pv} value={pv}>{pv}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Filtro por Modelo */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Modelo MDVR</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 focus:outline-none focus:border-blue-500"
                                                    value={filterModel}
                                                    onChange={(e) => setFilterModel(e.target.value)}
                                                    aria-label="Filtrar por modelo"
                                                >
                                                    <option value="all">Todos los Modelos</option>
                                                    {uniqueModels.map(model => (
                                                        <option key={model} value={model}>{model}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Buscador de Texto */}
                                            <div className="lg:col-span-3">
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Buscar texto</label>
                                                <input
                                                    type="text"
                                                    placeholder="Buscar placa, error o diagnóstico..."
                                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
                                                    value={searchTerm}
                                                    onChange={(e) => setSearchTerm(e.target.value)}
                                                />
                                            </div>
                                        </div>

                                        {/* Botones de acción */}
                                        <div className="flex gap-3">
                                            <button
                                                onClick={handleSearch}
                                                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
                                            >
                                                <Search className="w-4 h-4" />
                                                Buscar
                                            </button>
                                            <button
                                                onClick={resetFilters}
                                                className="flex items-center gap-2 px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-medium transition-colors"
                                            >
                                                Limpiar Filtros
                                            </button>
                                            {hasSearched && filteredData.length > 0 && (
                                                <button className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors ml-auto">
                                                    <Download className="w-4 h-4" />
                                                    Exportar ({filteredData.length})
                                                </button>
                                            )}
                                        </div>
                                    </section>

                                    {/* RESULTADOS */}
                                    {!hasSearched ? (
                                        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
                                            <div className="bg-slate-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                                                <Filter className="w-10 h-10 text-slate-300" />
                                            </div>
                                            <h3 className="text-xl font-bold text-slate-800 mb-2">Listo para buscar</h3>
                                            <p className="text-slate-500 max-w-md mx-auto">
                                                Utiliza los filtros de arriba y presiona <strong>Buscar</strong> para ver los registros.
                                            </p>
                                        </section>
                                    ) : filteredData.length === 0 ? (
                                        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
                                            <div className="bg-amber-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                                                <AlertTriangle className="w-10 h-10 text-amber-400" />
                                            </div>
                                            <h3 className="text-xl font-bold text-slate-800 mb-2">Sin resultados</h3>
                                            <p className="text-slate-500 max-w-md mx-auto">
                                                No se encontraron registros que coincidan con los filtros seleccionados.
                                            </p>
                                        </section>
                                    ) : (
                                        <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                                            {/* Info de resultados */}
                                            <div className="bg-slate-50 px-6 py-3 border-b border-slate-200 flex justify-between items-center">
                                                <span className="text-sm text-slate-600">
                                                    Mostrando <strong>{((currentPage - 1) * RECORDS_PER_PAGE) + 1}</strong> - <strong>{Math.min(currentPage * RECORDS_PER_PAGE, currentDataSource.length)}</strong> de <strong>{currentDataSource.length.toLocaleString()}</strong> {viewMode === 'devices' ? 'equipos' : 'registros'}
                                                </span>
                                                <span className="text-sm text-slate-500">
                                                    Rango: <strong>{dateRange.start || 'Inicio'}</strong> - <strong>{dateRange.end || 'Fin'}</strong>
                                                </span>


                                            </div>

                                            {/* Tabla */}
                                            <div className="overflow-x-auto">
                                                {viewMode === 'alerts' ? (
                                                    <table className="w-full text-sm text-left">
                                                        <thead className="bg-slate-50 text-slate-500 font-semibold uppercase text-xs">
                                                            <tr>
                                                                <th className="px-6 py-4">Dispositivo</th>
                                                                <th className="px-6 py-4">Detalle Error</th>
                                                                <th className="px-6 py-4">Diagnóstico</th>
                                                                <th className="px-6 py-4 text-center">Severidad</th>
                                                                <th className="px-6 py-4 text-right">Acción</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-100">
                                                            {(paginatedData as ProcessedData[]).map((row) => (
                                                                <tr key={row.id} className="hover:bg-slate-50 transition-colors group">
                                                                    <td className="px-6 py-4">
                                                                        <div className="font-bold text-slate-900">{row.DeviceName}</div>
                                                                        <div className="text-xs text-slate-500 flex flex-col gap-0.5 mt-0.5">
                                                                            <span className="flex items-center gap-1"><Truck className="w-3 h-3" /> {row.Fleet}</span>
                                                                            <span className="font-mono text-slate-400">{row.ID}</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 max-w-xs">
                                                                        <div className="flex items-center gap-2 mb-1">
                                                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${row.component === 'SSD/HDD' ? 'bg-purple-50 text-purple-700 border-purple-100' :
                                                                                row.component === 'SD/Firebox' ? 'bg-cyan-50 text-cyan-700 border-cyan-100' :
                                                                                    'bg-slate-100 text-slate-600 border-slate-200'
                                                                                }`}>
                                                                                {row.component}
                                                                            </span>
                                                                            <span className="text-xs font-mono text-slate-500">{row.DiskType}</span>
                                                                        </div>
                                                                        <div className="text-slate-600 truncate group-hover:whitespace-normal group-hover:overflow-visible text-xs leading-relaxed" title={row.DiskDetails}>
                                                                            {row.DiskDetails.replace(/State:/g, '')}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className={`text-sm font-medium ${row.diagnosis.includes("ALERTA") ? 'text-red-600' : 'text-slate-700'}`}>
                                                                            {row.diagnosis}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${row.severity === 'Alta' ? 'bg-red-100 text-red-700' :
                                                                            row.severity === 'Media' ? 'bg-amber-100 text-amber-700' :
                                                                                'bg-blue-100 text-blue-700'
                                                                            }`}>
                                                                            {row.severity}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-right">
                                                                        <span className="font-bold text-slate-800 text-xs">
                                                                            {row.action}
                                                                        </span>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                ) : (
                                                    <table className="w-full text-sm text-left">
                                                        <thead className="bg-slate-50 text-slate-500 font-semibold uppercase text-xs">
                                                            <tr>
                                                                <th className="px-4 py-4 w-10">
                                                                    <input
                                                                        type="checkbox"
                                                                        aria-label="Seleccionar todos los equipos"
                                                                        title="Seleccionar todo"
                                                                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                                                        onChange={toggleSelectAll}
                                                                        checked={(paginatedData as DeviceGroup[]).length > 0 && (paginatedData as DeviceGroup[]).every(g => selectedIds.has(g.equipment))}
                                                                    />
                                                                </th>
                                                                <th className="px-6 py-4">Equipo / Flota</th>
                                                                <th className="px-6 py-4 text-center">Total Alertas</th>
                                                                <th className="px-6 py-4">Diagnóstico Principal (Peor Caso)</th>
                                                                <th className="px-6 py-4 text-center">Severidad Max</th>
                                                                <th className="px-6 py-4 text-right">Acción Sugerida</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-100">
                                                            {(paginatedData as DeviceGroup[]).map((group, idx) => (
                                                                <tr key={idx} className={`hover:bg-slate-50 transition-colors ${selectedIds.has(group.equipment) ? 'bg-blue-50/30' : ''}`}>
                                                                    <td className="px-4 py-4">
                                                                        <input
                                                                            type="checkbox"
                                                                            aria-label={"Seleccionar equipo " + group.equipment}
                                                                            title={"Seleccionar " + group.equipment}
                                                                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                                                            checked={selectedIds.has(group.equipment)}
                                                                            onChange={() => toggleSelection(group.equipment)}
                                                                        />
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className="font-bold text-slate-900">{group.equipment}</div>
                                                                        <div className="text-xs text-slate-500 flex flex-col gap-0.5 mt-0.5">
                                                                            <span className="flex items-center gap-1"><Truck className="w-3 h-3" /> {group.fleet}</span>
                                                                            <span className="text-slate-400">{group.model}</span>

                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <div className="inline-flex flex-col items-center">
                                                                            <span className="text-lg font-bold text-slate-700">{group.totalAlerts}</span>
                                                                            {group.highSeverityCount > 0 && (
                                                                                <span className="text-[10px] text-red-600 font-bold bg-red-50 px-1.5 rounded">
                                                                                    {group.highSeverityCount} Críticas
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className={`text-sm font-medium ${group.maxSeverity === 'Alta' ? 'text-red-700' : 'text-slate-700'}`}>
                                                                            {group.worstDiagnosis}
                                                                        </div>
                                                                        <div className="text-xs text-slate-400 mt-1">
                                                                            {group.component} - {group.diskType}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${group.maxSeverity === 'Alta' ? 'bg-red-100 text-red-700' :
                                                                            group.maxSeverity === 'Media' ? 'bg-amber-100 text-amber-700' :
                                                                                'bg-blue-100 text-blue-700'
                                                                            }`}>
                                                                            {group.maxSeverity}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-right">
                                                                        <span className="font-bold text-slate-800 text-xs block">
                                                                            {group.suggestedAction}
                                                                        </span>
                                                                        {group.pv && group.pv !== 'Sin Asignar' && (
                                                                            <span className="text-[10px] text-slate-400 block mt-1">
                                                                                PV: {group.pv}
                                                                            </span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                )}
                                            </div>

                                            {/* Paginación */}
                                            {totalPages > 1 && (
                                                <div className="bg-slate-50 p-4 border-t border-slate-200 flex justify-center items-center gap-2">
                                                    <button
                                                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                                        disabled={currentPage === 1}
                                                        className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        aria-label="Página anterior"
                                                    >
                                                        <ChevronLeft className="w-4 h-4" />
                                                    </button>

                                                    <div className="flex gap-1">
                                                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                                            let pageNum;
                                                            if (totalPages <= 5) {
                                                                pageNum = i + 1;
                                                            } else if (currentPage <= 3) {
                                                                pageNum = i + 1;
                                                            } else if (currentPage >= totalPages - 2) {
                                                                pageNum = totalPages - 4 + i;
                                                            } else {
                                                                pageNum = currentPage - 2 + i;
                                                            }
                                                            return (
                                                                <button
                                                                    key={pageNum}
                                                                    onClick={() => setCurrentPage(pageNum)}
                                                                    className={`w-10 h-10 rounded-lg font-medium text-sm transition-colors ${currentPage === pageNum
                                                                        ? 'bg-blue-600 text-white'
                                                                        : 'bg-white border border-slate-200 hover:bg-slate-100 text-slate-600'
                                                                        }`}
                                                                >
                                                                    {pageNum}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>

                                                    <button
                                                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                                        disabled={currentPage === totalPages}
                                                        className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        aria-label="Página siguiente"
                                                    >
                                                        <ChevronRight className="w-4 h-4" />
                                                    </button>

                                                    <span className="text-sm text-slate-500 ml-4">
                                                        Página {currentPage} de {totalPages}
                                                    </span>
                                                </div>
                                            )}
                                        </section>
                                    )}

                                </div>
                            )}

                        {/* TAB: SEGUIMIENTO CORRECTIVO */}
                        {activeTab === 'tracking' && (
                            <div className="space-y-8">
                                <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 mb-6">
                                    <h3 className="text-xl font-bold text-blue-900 mb-2">Campaña de Reparación Correctiva</h3>
                                    <p className="text-blue-700">
                                        Seguimiento de los 10 equipos más críticos (Top 5 por Macro-grupo) que requieren cambio urgente de unidad de almacenamiento.
                                        Estos equipos presentan fallas L1 recurrentes.
                                    </p>
                                    {hasSearched && (
                                        <div className="mt-4 flex items-center justify-between bg-white/60 p-3 rounded-lg border border-blue-200">
                                            <span className="text-sm text-blue-800 font-bold flex items-center gap-2">
                                                <Filter className="w-4 h-4" /> Filtros activos (Registros) afectando resultados
                                            </span>
                                            <button
                                                onClick={resetFilters}
                                                className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-1.5 rounded-md hover:bg-blue-50 font-bold shadow-sm"
                                            >
                                                Limpiar Filtros Globales
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* Selector de Macro-grupo */}
                                <div className="flex justify-center mb-6">
                                    <div className="flex bg-slate-200 rounded-lg p-1">
                                        <button
                                            onClick={() => setTrackingFilter('all')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'all'
                                                ? 'bg-white text-blue-600 shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                        >
                                            Ver Todo
                                        </button>
                                        <button
                                            onClick={() => setTrackingFilter('yanacocha')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'yanacocha'
                                                ? 'bg-white text-blue-600 shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                        >
                                            Yanacocha
                                        </button>
                                        <button
                                            onClick={() => setTrackingFilter('repsol')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'repsol'
                                                ? 'bg-white text-blue-600 shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                        >
                                            Repsol
                                        </button>
                                    </div>
                                </div>

                                {/* GRAFICOS DE SEGUIMIENTO (Solo si se selecciona una flota específica) */}
                                {trackingFilter !== 'all' && (
                                    <div className="mb-8 bg-white rounded-xl border border-slate-200 shadow-sm p-6 animate-in fade-in slide-in-from-bottom-4">
                                        <h4 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-6">
                                            Progreso de Reparación - {trackingFilter === 'yanacocha' ? 'Yanacocha' : 'Repsol'}
                                        </h4>

                                        {(() => {
                                            // 1. Recalcular los datos Top 5 para la flota seleccionada
                                            const fleetSet = trackingFilter === 'yanacocha' ? YANACOCHA_FLEETS : REPSOL_FLEETS;
                                            const fleetKeyword = trackingFilter === 'yanacocha' ? 'yanacocha' : 'repsol';

                                            const filtered = groupedData.filter(d =>
                                                fleetSet.has(d.fleet.toUpperCase()) || d.fleet.toLowerCase().includes(fleetKeyword)
                                            );

                                            // Top 5 Críticos
                                            const top5 = filtered
                                                .filter(d => d.highSeverityCount > 1)
                                                .sort((a, b) => b.highSeverityCount - a.highSeverityCount)
                                                .slice(0, 5);

                                            // Calcular estadísticas sobre estos 5
                                            const stats = {
                                                pendiente: 0,
                                                proceso: 0,
                                                reparado: 0
                                            };

                                            top5.forEach(d => {
                                                const status = repairData[d.equipment]?.status || 'Pendiente';
                                                if (status === 'Pendiente') stats.pendiente++;
                                                else if (status === 'Reparado') stats.reparado++;
                                                else stats.proceso++; // En Proceso / Validando
                                            });

                                            const chartData = [
                                                { name: 'Pendiente', value: stats.pendiente, color: '#94a3b8' },
                                                { name: 'En Proceso', value: stats.proceso, color: '#f59e0b' },
                                                { name: 'Reparado', value: stats.reparado, color: '#10b981' },
                                            ].filter(d => d.value > 0);

                                            // Tendencia (con relleno de huecos y ordenamiento correcto)
                                            // Crear Set de equipos del Top 5 para filtrar
                                            const top5EquipmentSet = new Set(top5.map(d => d.equipment));

                                            const filteredAlarms = scopedData.filter(d => {
                                                // Si hay un dispositivo seleccionado, mostrar solo ese
                                                if (selectedTrackingDevice) {
                                                    return d.DeviceName === selectedTrackingDevice && d.severity === 'Alta';
                                                }
                                                // Si no, mostrar solo los del Top 5
                                                return top5EquipmentSet.has(d.DeviceName) && d.severity === 'Alta';
                                            });

                                            const totalAlarmsCount = filteredAlarms.length; // Total real de alarmas

                                            const dailyTrend = filteredAlarms.reduce((acc: any, curr) => {
                                                const dateStr = curr.Date.split(' ')[0]; // DD/MM/YYYY
                                                acc[dateStr] = (acc[dateStr] || 0) + 1;
                                                return acc;
                                            }, {});

                                            let trendPoints = Object.entries(dailyTrend).map(([date, count]) => {
                                                const [d, m, y] = date.split('/');
                                                return {
                                                    date,
                                                    ts: new Date(Number(y), Number(m) - 1, Number(d)).getTime(),
                                                    count: Number(count)
                                                };
                                            }).filter(p => !isNaN(p.ts)); // Filtrar invalidos

                                            // Rellenar huecos de fechas con 0
                                            if (trendPoints.length > 0) {
                                                trendPoints.sort((a, b) => a.ts - b.ts);
                                                const minTs = trendPoints[0].ts;

                                                // Extender hasta la última fecha del reporte global (uniqueDates[0] es la más reciente)
                                                const latestGlobalStr = uniqueDates[0];
                                                const globalMaxTs = latestGlobalStr ? parseDateLocal(latestGlobalStr) : 0;
                                                // Usamos la mayor entre la última de este set o la global
                                                const maxTs = Math.max(trendPoints[trendPoints.length - 1].ts, globalMaxTs);

                                                const oneDay = 24 * 60 * 60 * 1000;

                                                const fullSeries = [];
                                                const lookup = new Map(trendPoints.map(p => [p.ts, p.count]));

                                                for (let t = minTs; t <= maxTs; t += oneDay) {
                                                    const dObj = new Date(t);
                                                    const display = `${String(dObj.getDate()).padStart(2, '0')}/${String(dObj.getMonth() + 1).padStart(2, '0')}/${dObj.getFullYear()}`;
                                                    fullSeries.push({
                                                        date: display,
                                                        count: lookup.get(t) || 0
                                                    });
                                                }
                                                trendPoints = fullSeries as any;
                                            }

                                            const trendChartData = trendPoints;

                                            if (top5.length === 0) return (
                                                <div className="text-center text-slate-400 py-4 italic">No hay datos suficientes para gráficos</div>
                                            );

                                            return (
                                                <div className="flex flex-col gap-8">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                                                        {/* Pie Chart */}
                                                        <div className="h-48 relative">
                                                            <ResponsiveContainer width="100%" height="100%">
                                                                <PieChart>
                                                                    <Pie data={chartData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                                                                        {chartData.map((entry, index) => (
                                                                            <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />
                                                                        ))}
                                                                    </Pie>
                                                                    <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                                                </PieChart>
                                                            </ResponsiveContainer>
                                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                                <div className="text-center">
                                                                    <span className="block text-3xl font-bold text-slate-800">{top5.length}</span>
                                                                    <span className="text-[10px] text-slate-500 font-bold uppercase">Equipos</span>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Status Boxes */}
                                                        <div className="grid grid-cols-3 gap-4">
                                                            <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-100">
                                                                <div className="text-2xl font-bold text-slate-700">{stats.pendiente}</div>
                                                                <div className="text-xs text-slate-500 font-bold mt-1">Pendientes</div>
                                                            </div>
                                                            <div className="bg-amber-50 rounded-lg p-4 text-center border border-amber-100">
                                                                <div className="text-2xl font-bold text-amber-600">{stats.proceso}</div>
                                                                <div className="text-xs text-amber-600/80 font-bold mt-1">En Gestión</div>
                                                            </div>
                                                            <div className="bg-emerald-50 rounded-lg p-4 text-center border border-emerald-100">
                                                                <div className="text-2xl font-bold text-emerald-600">{stats.reparado}</div>
                                                                <div className="text-xs text-emerald-600/80 font-bold mt-1">Reparados</div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Trend Chart */}
                                                    <div className="pt-6 border-t border-slate-100">
                                                        <div className="flex justify-between items-center mb-4 px-2">
                                                            <h5 className="text-xs font-bold text-slate-400 uppercase">Tendencia de Fallas Críticas (L1)</h5>
                                                            <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${selectedTrackingDevice ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                                                                {selectedTrackingDevice ? `${selectedTrackingDevice}: ` : 'Total: '}
                                                                {totalAlarmsCount} {totalAlarmsCount === 1 ? 'Alarma' : 'Alarmas'}
                                                            </span>
                                                        </div>
                                                        <div className="h-48 w-full">
                                                            <ResponsiveContainer width="100%" height="100%">
                                                                <AreaChart data={trendChartData}>
                                                                    <defs>
                                                                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                                                                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.1} />
                                                                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                                                                        </linearGradient>
                                                                    </defs>
                                                                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                                                    <XAxis dataKey="date" tickFormatter={(v) => v.substring(0, 5)} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={10} interval="preserveStartEnd" />
                                                                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                                                                    <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                                                    <Area type="monotone" dataKey="count" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#colorCount)" />
                                                                </AreaChart>
                                                            </ResponsiveContainer>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}

                                <div className={`grid grid-cols-1 ${trackingFilter === 'all' ? 'lg:grid-cols-2' : 'lg:grid-cols-1 max-w-4xl mx-auto'} gap-8`}>
                                    {/* COLUMNA YANACOCHA */}
                                    {(trackingFilter === 'all' || trackingFilter === 'yanacocha') && (
                                        <TrackingColumn
                                            title="Macro-grupo YANACOCHA"
                                            color="blue"
                                            data={groupedData.filter(d =>
                                                // Normalizamos para comparar con el Set
                                                YANACOCHA_FLEETS.has(d.fleet.toUpperCase()) ||
                                                // Fallback por si acaso:
                                                d.fleet.toLowerCase().includes('yanacocha')
                                            )}
                                            repairData={repairData}
                                            onUpdateStatus={(id: string, status: any, alerts: number) => updateRepairStatus(id, status, 'Yanacocha', alerts)}
                                            onAddComment={addComment}
                                            selectedDevice={selectedTrackingDevice}
                                            onSelectDevice={setSelectedTrackingDevice}
                                            onViewDetails={setViewingDeviceDetails}
                                        />
                                    )}

                                    {/* COLUMNA REPSOL */}
                                    {(trackingFilter === 'all' || trackingFilter === 'repsol') && (
                                        <TrackingColumn
                                            title="Macro-grupo REPSOL"
                                            color="orange"
                                            data={groupedData.filter(d =>
                                                REPSOL_FLEETS.has(d.fleet.toUpperCase()) ||
                                                d.fleet.toLowerCase().includes('repsol')
                                            )}
                                            repairData={repairData}
                                            onUpdateStatus={(id: string, status: any, alerts: number) => updateRepairStatus(id, status, 'Repsol', alerts)}
                                            onAddComment={addComment}
                                            selectedDevice={selectedTrackingDevice}
                                            onSelectDevice={setSelectedTrackingDevice}
                                            onViewDetails={setViewingDeviceDetails}
                                            showAll={trackingFilter === 'repsol'}
                                        />
                                    )}
                                </div>
                            </div>
                        )}


                        {/* TAB: SEGUIMIENTO GENERAL */}
                        {activeTab === 'general-tracking' && (
                            <div className="space-y-8">
                                <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 mb-6">
                                    <h3 className="text-xl font-bold text-slate-900 mb-2">Seguimiento General - Todos los Equipos</h3>
                                    <p className="text-slate-700 mb-4">
                                        Vista global de todos los equipos ordenados por cantidad de fallas (de mayor a menor).
                                        Ideal para priorizar reparaciones urgentes independientemente de la flota.
                                    </p>

                                    {/* Filtro de Nivel */}
                                    <div className="flex items-center gap-3 mt-4 relative z-10">
                                        <span className="text-sm font-bold text-slate-600">Filtrar por nivel:</span>
                                        <div className="flex bg-white rounded-lg border border-slate-200 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Todas
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L1')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L1'
                                                    ? 'bg-red-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                L1 (Críticas)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L2')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L2'
                                                    ? 'bg-amber-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                L2 (Config)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L3')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L3'
                                                    ? 'bg-blue-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                L3 (Lógicas)
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filtro de Estado de Reparación */}
                                    <div className="flex items-center gap-3 mt-3 relative z-10">
                                        <span className="text-sm font-bold text-slate-600">Filtrar por estado:</span>
                                        <div className="flex bg-white rounded-lg border border-slate-200 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Todos
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Pendiente')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Pendiente'
                                                    ? 'bg-slate-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Pendiente
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('En Proceso')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'En Proceso'
                                                    ? 'bg-amber-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                En Proceso
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Validando')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Validando'
                                                    ? 'bg-blue-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Validando
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Reparado')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Reparado'
                                                    ? 'bg-emerald-500 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Reparado
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filtro de Tipo de Disco */}
                                    <div className="flex items-center gap-3 mt-3 relative z-10">
                                        <span className="text-sm font-bold text-slate-600">Filtrar por disco:</span>
                                        <div className="flex bg-white rounded-lg border border-slate-200 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Todos
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('ssd')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'ssd'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                SSD / HDD
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('sd')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'sd'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                SD / Firebox
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('other')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'other'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                                    }`}
                                            >
                                                Otros
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* GRAFICOS DE SEGUIMIENTO GENERAL */}
                                <div className="mb-8 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                                    <h4 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-6">
                                        Progreso de Reparación - General
                                    </h4>

                                    {(() => {
                                        // TODOS los equipos ordenados por cantidad total de fallas
                                        const allEquipment = groupedData
                                            .filter(d => d.totalAlerts > 0) // Solo equipos con al menos 1 alarma
                                            .sort((a, b) => b.totalAlerts - a.totalAlerts); // Ordenar por total de alarmas

                                        // Filtrar equipos según el nivel seleccionado
                                        let filteredEquipment = generalSeverityFilter === 'all'
                                            ? allEquipment
                                            : allEquipment.filter(d => {
                                                // Verificar si el equipo tiene alarmas del nivel seleccionado
                                                const hasMatchingLevel = scopedData.some(alarm =>
                                                    alarm.DeviceName === d.equipment && alarm.level === generalSeverityFilter
                                                );
                                                return hasMatchingLevel;
                                            });

                                        // Filtrar equipos según el estado de reparación seleccionado
                                        if (generalStatusFilter !== 'all') {
                                            filteredEquipment = filteredEquipment.filter(d => {
                                                const status = repairData[d.equipment]?.status || 'Pendiente';
                                                return status === generalStatusFilter;
                                            });
                                        }

                                        // Filtrar equipos según el TIPO DE DISCO seleccionado
                                        if (generalComponentFilter !== 'all') {
                                            filteredEquipment = filteredEquipment.filter(d => {
                                                if (generalComponentFilter === 'ssd') return d.component === 'SSD/HDD';
                                                if (generalComponentFilter === 'sd') return d.component === 'SD/Firebox';
                                                return d.component === 'Otros';
                                            });
                                        }



                                        // Calcular estadísticas sobre los equipos filtrados
                                        const stats = {
                                            pendiente: 0,
                                            proceso: 0,
                                            reparado: 0
                                        };

                                        filteredEquipment.forEach(d => {
                                            const status = repairData[d.equipment]?.status || 'Pendiente';
                                            if (status === 'Pendiente') stats.pendiente++;
                                            else if (status === 'Reparado') stats.reparado++;
                                            else stats.proceso++; // En Proceso / Validando
                                        });

                                        const chartData = [
                                            { name: 'Pendiente', value: stats.pendiente, color: '#94a3b8' },
                                            { name: 'En Proceso', value: stats.proceso, color: '#f59e0b' },
                                            { name: 'Reparado', value: stats.reparado, color: '#10b981' },
                                        ].filter(d => d.value > 0);

                                        // Tendencia - usar todos los equipos (sin filtrar por severidad en el set, el filtro se aplica en filteredAlarms)
                                        const allEquipmentSet = new Set(allEquipment.map(d => d.equipment));

                                        const filteredAlarms = scopedData.filter(d => {
                                            // Filtro por dispositivo
                                            const matchesDevice = selectedTrackingDevice
                                                ? d.DeviceName === selectedTrackingDevice
                                                : allEquipmentSet.has(d.DeviceName);

                                            // Filtro por nivel
                                            const matchesLevel = generalSeverityFilter === 'all'
                                                ? true
                                                : d.level === generalSeverityFilter;

                                            // Filtro por tipo de disco
                                            const matchesDisk = generalComponentFilter === 'all'
                                                ? true
                                                : (generalComponentFilter === 'ssd' ? d.component === 'SSD/HDD' :
                                                    generalComponentFilter === 'sd' ? d.component === 'SD/Firebox' :
                                                        d.component === 'Otros');

                                            return matchesDevice && matchesLevel && matchesDisk;
                                        });

                                        const totalAlarmsCount = filteredAlarms.length;

                                        const dailyTrend = filteredAlarms.reduce((acc: any, curr) => {
                                            const dateStr = curr.Date.split(' ')[0];
                                            acc[dateStr] = (acc[dateStr] || 0) + 1;
                                            return acc;
                                        }, {});

                                        let trendPoints = Object.entries(dailyTrend).map(([date, count]) => {
                                            const [d, m, y] = date.split('/');
                                            return {
                                                date,
                                                ts: new Date(Number(y), Number(m) - 1, Number(d)).getTime(),
                                                count: Number(count)
                                            };
                                        }).filter(p => !isNaN(p.ts));

                                        // Rellenar huecos
                                        if (trendPoints.length > 0) {
                                            trendPoints.sort((a, b) => a.ts - b.ts);
                                            const minTs = trendPoints[0].ts;
                                            const maxTs = trendPoints[trendPoints.length - 1].ts;
                                            const oneDay = 24 * 60 * 60 * 1000;

                                            const fullSeries = [];
                                            const lookup = new Map(trendPoints.map(p => [p.ts, p.count]));

                                            for (let t = minTs; t <= maxTs; t += oneDay) {
                                                const dObj = new Date(t);
                                                const display = `${String(dObj.getDate()).padStart(2, '0')}/${String(dObj.getMonth() + 1).padStart(2, '0')}/${dObj.getFullYear()}`;
                                                fullSeries.push({
                                                    date: display,
                                                    count: lookup.get(t) || 0
                                                });
                                            }
                                            trendPoints = fullSeries as any;
                                        }

                                        const trendChartData = trendPoints;

                                        if (allEquipment.length === 0) return (
                                            <div className="text-center text-slate-400 py-4 italic">No hay datos suficientes para gráficos</div>
                                        );

                                        return (
                                            <div className="flex flex-col gap-8">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                                                    {/* Pie Chart */}
                                                    <div className="h-48 relative">
                                                        <ResponsiveContainer width="100%" height="100%">
                                                            <PieChart>
                                                                <Pie data={chartData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                                                                    {chartData.map((entry, index) => (
                                                                        <Cell key={`cell-${index}`} fill={entry.color} strokeWidth={0} />
                                                                    ))}
                                                                </Pie>
                                                                <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                                            </PieChart>
                                                        </ResponsiveContainer>
                                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                            <div className="text-center">
                                                                <span className="block text-3xl font-bold text-slate-800">{filteredEquipment.length}</span>
                                                                <span className="text-[10px] text-slate-500 font-bold uppercase">Equipos</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Status Boxes */}
                                                    <div className="grid grid-cols-3 gap-4">
                                                        <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-100">
                                                            <div className="text-2xl font-bold text-slate-700">{stats.pendiente}</div>
                                                            <div className="text-xs text-slate-500 font-bold mt-1">Pendientes</div>
                                                        </div>
                                                        <div className="bg-amber-50 rounded-lg p-4 text-center border border-amber-100">
                                                            <div className="text-2xl font-bold text-amber-600">{stats.proceso}</div>
                                                            <div className="text-xs text-amber-600/80 font-bold mt-1">En Gestión</div>
                                                        </div>
                                                        <div className="bg-emerald-50 rounded-lg p-4 text-center border border-emerald-100">
                                                            <div className="text-2xl font-bold text-emerald-600">{stats.reparado}</div>
                                                            <div className="text-xs text-emerald-600/80 font-bold mt-1">Reparados</div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Trend Chart */}
                                                <div className="pt-6 border-t border-slate-100">
                                                    <div className="flex justify-between items-center mb-4 px-2">
                                                        <h5 className="text-xs font-bold text-slate-400 uppercase">
                                                            Tendencia de Fallas {generalSeverityFilter === 'all' ? '' : `- Severidad ${generalSeverityFilter}`}
                                                        </h5>
                                                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${selectedTrackingDevice ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                                                            {selectedTrackingDevice ? `${selectedTrackingDevice}: ` : 'Total: '}
                                                            {totalAlarmsCount} {totalAlarmsCount === 1 ? 'Alarma' : 'Alarmas'}
                                                        </span>
                                                    </div>
                                                    <div className="h-48 w-full">
                                                        <ResponsiveContainer width="100%" height="100%">
                                                            <AreaChart data={trendChartData}>
                                                                <defs>
                                                                    <linearGradient id="colorCountGeneral" x1="0" y1="0" x2="0" y2="1">
                                                                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1} />
                                                                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                                                    </linearGradient>
                                                                </defs>
                                                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                                                <XAxis dataKey="date" tickFormatter={(v) => v.substring(0, 5)} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={10} interval="preserveStartEnd" />
                                                                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                                                                <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                                                <Area type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorCountGeneral)" />
                                                            </AreaChart>
                                                        </ResponsiveContainer>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>

                                {/* COLUMNA DE SEGUIMIENTO GENERAL */}
                                <div className="max-w-4xl mx-auto">
                                    <TrackingColumn
                                        title="Todos los Equipos (Ordenados por Fallas)"
                                        color="blue"
                                        data={groupedData.sort((a, b) => b.highSeverityCount - a.highSeverityCount)}
                                        repairData={repairData}
                                        onUpdateStatus={(id: string, status: any, alerts: number) => updateRepairStatus(id, status, 'General', alerts)}
                                        onAddComment={addComment}
                                        selectedDevice={selectedTrackingDevice}
                                        onSelectDevice={setSelectedTrackingDevice}
                                        showAll={true}
                                        statusFilter={generalStatusFilter}
                                    />
                                </div>
                            </div>
                        )}


                        {/* FLOATING ACTION BAR (Selección) */}
                        {
                            selectedIds.size > 0 && (
                                <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900/90 backdrop-blur-md text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-6 z-50 animate-in fade-in slide-in-from-bottom-4">
                                    <div className="flex flex-col">
                                        <span className="font-bold text-sm">{selectedIds.size} equipos seleccionados</span>
                                        <span className="text-[10px] text-slate-400">Listos para orden de trabajo</span>
                                    </div>

                                    <div className="h-8 w-px bg-slate-700 mx-2"></div>

                                    <button
                                        onClick={handleGeneratePDF}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 transition-transform active:scale-95 shadow-lg shadow-blue-500/30"
                                    >
                                        <FileText className="w-4 h-4" />
                                        Generar Orden PDF
                                    </button>

                                    <button
                                        onClick={() => setSelectedIds(new Set())}
                                        className="bg-transparent hover:bg-slate-800 text-slate-300 p-2 rounded-full transition-colors"
                                        title="Cancelar selección"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            )
                        }

                    </>
                )}
                {/* Modal de Detalles del Equipo */}
                {viewingDeviceDetails && (
                    <DeviceDetailsModal
                        isOpen={!!viewingDeviceDetails}
                        onClose={() => setViewingDeviceDetails(null)}
                        equipment={viewingDeviceDetails}
                        fleet={data.find(d => d.DeviceName === viewingDeviceDetails)?.Fleet || 'Desconocida'}
                        repairData={repairData[viewingDeviceDetails]}
                        alarms={data.filter(d => d.DeviceName === viewingDeviceDetails)}
                        onAddComment={(text) => addComment(viewingDeviceDetails, text)}
                    />
                )}
            </main >
        </div >
    );
}
