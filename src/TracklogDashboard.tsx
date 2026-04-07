import React, { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
    PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, LabelList, AreaChart, Area
} from 'recharts';
import {
    AlertTriangle, HardDrive, CheckCircle, Search,
    Wrench, Truck, AlertOctagon, Download, Upload, Filter, Database,
    LayoutDashboard, Table, ChevronLeft, ChevronRight, FileText, X, Activity, Hammer, ExternalLink, Sun, Moon, Menu, Globe,
    Lock, Unlock, RefreshCcw
} from 'lucide-react';
import { supabase } from './lib/supabase';
import { useTranslation } from 'react-i18next';
import { generateWorkOrderPDF } from './utils/pdfGenerator';
import { YANACOCHA_FLEETS, REPSOL_FLEETS, TRACKLOG_INTERNAL_FLEETS } from './utils/fleets';

import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { SpeedInsights } from "@vercel/speed-insights/react";
// Importar estilos personalizados para que coincidan con Tailwind si es necesario, 
// o usar className.


// --- DEFINICIÓN DE TIPOS ---
interface TrendData {
    alarm_date: string;
    fleet: string;
    level: string;
    severity: string;
    total_alerts: number;
}


interface RawData {
    DeviceName: string;
    ID: string;
    Fleet: string;
    DiskType: string;
    DiskDetails: string;
    Speed: string;
    Date: string;
    AlarmStatus: string;
    ReUpload: string;
    RawDetails: string;
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
    _total_alerts?: number;
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
    status: 'Pendiente' | 'Revisión Remota' | 'En Proceso' | 'Validando' | 'Reparado';
    workType: 'Pendiente' | 'Cambio' | 'Formateo' | 'Configuración';
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
    equipment: string; // Ahora es el ID (10 dígitos) como clave principal
    allPlates: string[]; // Todas las placas/nombres de vehículo asociados a este ID
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

    if (rows.length === 0) return [];

    const headers = rows[0].map(h => sanitize(h).toLowerCase());
    
    // Detectar si la primera fila es un encabezado real
    const isHeaderRow = headers.some(h => h.includes('device') || h.includes('time') || h.includes('status') || h.includes('fleet') || h.includes('type'));

    // Si detectamos headers, buscamos el índice correcto. Si no está en el CSV, asignamos -1.
    // Si NO es header (archivo sin encabezados), usamos los índices legacy por defecto.
    const getSafeIndex = (keywords: string[], fallback: number) => {
        if (!isHeaderRow) return fallback;
        const idx = headers.findIndex(h => keywords.some(k => h.includes(k) || h === k));
        return idx !== -1 ? idx : -1;
    };

    const idxName = getSafeIndex(['device', 'plate', 'placa'], 0);
    const idxFleet = getSafeIndex(['fleet', 'flota'], 2);
    const idxStatus = getSafeIndex(['alarm status', 'estado'], 3);
    const idxDate = getSafeIndex(['begin time', 'date', 'fecha', 'time'], 4);
    const idxDetails = getSafeIndex(['start details', 'detalles'], 6);
    const idxSpeed = getSafeIndex(['speed', 'velocidad'], 7);
    const idxReUpload = getSafeIndex(['re-upload', 're upload'], 9);

    const startIndex = isHeaderRow ? 1 : 0;

    for (let i = startIndex; i < rows.length; i++) {
        const row = rows[i];
        // Filtrar filas vacías o con muy pocas columnas
        if (row.length < 4) continue;

        const safeGet = (idx: number, fb: string = '') => (idx !== -1 && idx < row.length) ? sanitize(row[idx]) : fb;

        const rawNameId = safeGet(idxName);
        const nameMatch = rawNameId.match(/^(.*)\((\d+)\)$/);
        const deviceName = nameMatch ? nameMatch[1].trim() : rawNameId; // Ya sanitizado
        const deviceID = nameMatch ? nameMatch[2] : '';

        // DETERMINAR FLOTA (Prioridad: Map > CSV)
        let fleet = safeGet(idxFleet);
        if (fleetMap && fleetMap.has(deviceName)) {
            // Usamos el valor del mapa si existe
            fleet = fleetMap.get(deviceName) || fleet;
        } else if (fleetMap) {
            // Fallback si fuera necesario
        }
        if (!fleet) fleet = 'General';

        const rawDetails = safeGet(idxDetails);
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
            AlarmStatus: safeGet(idxStatus),
            Speed: safeGet(idxSpeed, '0'),
            Date: safeGet(idxDate),
            ReUpload: safeGet(idxReUpload, 'No'),
            RawDetails: rawDetails
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

    // DEDUPLICACIÓN: Eliminar registros duplicados (Desactivado temporalmente a petición del usuario)
    // Clave única: DeviceName + Date + DiskType + DiskDetails
    /*
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
    */

    return result; // Retorna el conteo bruto de filas sin limpiar duplicados
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
            <div className="text-center py-4 text-slate-400 dark:text-zinc-500 text-xs">
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
                        ? 'bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800'
                        : 'bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800'
                        }`}
                >
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`font-bold ${comment.type === 'system' ? 'text-blue-700 dark:text-blue-400' : 'text-slate-700 dark:text-zinc-300'
                                    }`}>
                                    {comment.type === 'system' ? '🤖' : '👤'} {comment.author}
                                </span>
                                <span className="text-slate-400 dark:text-zinc-500 text-[10px]">
                                    {formatRelativeTime(comment.timestamp)}
                                </span>
                            </div>
                            <p className="text-slate-600 dark:text-zinc-400 whitespace-pre-wrap">{comment.text}</p>
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
                        className="w-full p-2 text-xs border border-slate-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                        rows={3}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400 dark:text-zinc-500">
                            {commentText.length}/500
                        </span>
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    setCommentText('');
                                    setIsExpanded(false);
                                }}
                                className="px-3 py-1 text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:text-zinc-200 transition-colors"
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
                    className="w-full p-2 text-xs text-left text-slate-400 dark:text-zinc-500 border border-slate-200 dark:border-zinc-800 rounded-lg hover:border-blue-300 dark:border-blue-800 hover:text-blue-600 dark:text-blue-400 transition-colors"
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
        className={`bg-white dark:bg-zinc-900 p-5 rounded-xl shadow-sm border transition-all cursor-pointer flex items-center justify-between
      ${isActive ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/50 dark:bg-zinc-800 border-zinc-700' : 'border-slate-200 dark:border-zinc-800 hover:border-blue-300 dark:border-blue-800 hover:shadow-md'}
    `}
    >
        <div>
            <p className="text-slate-500 dark:text-zinc-400 text-xs font-bold uppercase tracking-wide mb-1">{title}</p>
            <h3 className="text-3xl font-bold text-slate-800 dark:text-zinc-200 dark:text-white">{value}</h3>
            {subtext && <p className="text-xs text-slate-400 dark:text-zinc-500  mt-1">{subtext}</p>}
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

    const categorySummary = React.useMemo(() => {
        const summary: Record<string, { count: number, severity: string, level: string, action: string }> = {};
        alarms.forEach(alarm => {
            const diag = alarm.diagnosis || 'Desconocido';
            if (!summary[diag]) {
                summary[diag] = { count: 0, severity: alarm.severity, level: alarm.level, action: alarm.action };
            }
            summary[diag].count += (alarm._total_alerts || 1);
        });
        return Object.entries(summary).sort((a, b) => b[1].count - a[1].count);
    }, [alarms]);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-start bg-slate-50 dark:bg-zinc-900">
                    <div>
                        <h2 className="text-2xl font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                            {name}
                            {id && <span className="text-lg font-mono text-slate-500 dark:text-zinc-400 bg-slate-200 dark:bg-zinc-800 px-2 py-0.5 rounded">ID: {id}</span>}
                        </h2>
                        <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 dark:text-zinc-400 font-bold uppercase">
                            <span>{fleet}</span>
                            <span className="text-slate-300">•</span>
                            <span>{alarms.length} Alarmas Totales</span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        title="Cerrar"
                        aria-label="Cerrar"
                        className="text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:text-zinc-400 p-2 hover:bg-slate-200 dark:bg-zinc-800 rounded-full transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
                    {/* Left Column: Alarms History & Status */}
                    <div className="flex-1 overflow-y-auto p-6 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">

                        {/* Status Summary */}
                        <div className="bg-slate-50 dark:bg-zinc-900 rounded-lg p-4 border border-slate-200 dark:border-zinc-800 mb-6 flex gap-8">
                            <div>
                                <div className="text-xs text-slate-400 dark:text-zinc-500 uppercase font-bold mb-1">Estado de Reparación</div>
                                <div className={`inline-flex px-3 py-1 rounded text-sm font-bold border
                                    ${repairData?.status === 'Pendiente' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-300 dark:border-zinc-700' :
                                        repairData?.status === 'Revisión Remota' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-400 border-purple-300 dark:border-purple-800' :
                                            repairData?.status === 'En Proceso' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800' :
                                                repairData?.status === 'Validando' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-800' :
                                                    'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800'}`}>
                                    {repairData?.status || 'Pendiente'}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-slate-400 dark:text-zinc-500 uppercase font-bold mb-1">Prioridad</div>
                                <div className={`text-sm font-bold ${repairData?.priority === 'Crítica' ? 'text-red-600 dark:text-red-400' :
                                    repairData?.priority === 'Alta' ? 'text-orange-600 dark:text-orange-400' :
                                        'text-blue-600 dark:text-blue-400'
                                    }`}>
                                    {repairData?.priority || 'Media'}
                                </div>
                            </div>
                        </div>

                        <h3 className="text-sm font-bold text-slate-800 dark:text-zinc-200 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500"></span>
                            Resumen de Fallas Agrupadas
                        </h3>

                        <div className="flex flex-col gap-3 mb-8">
                            {categorySummary.map(([diag, info], idx) => (
                                <div key={idx} className="bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg p-4 flex items-center justify-between shadow-sm">
                                    <div className="flex-1 pr-4">
                                        <div className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-1 leading-snug">{diag}</div>
                                        <div className="text-xs text-slate-500 dark:text-zinc-400">
                                            Acción principal: <span className="font-semibold">{info.action}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <span className={`text-[10px] font-bold px-2 py-1 rounded uppercase whitespace-nowrap
                                            ${info.severity === 'Alta' ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400' :
                                                info.severity === 'Media' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400' :
                                                    'bg-slate-200 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                                            {info.level}
                                        </span>
                                        <div className="text-right border-l border-slate-200 dark:border-zinc-700 pl-4 min-w-[60px]">
                                            <div className="text-2xl font-black text-slate-700 dark:text-zinc-300 leading-none">{info.count}</div>
                                            <div className="text-[9px] uppercase font-bold text-slate-400 dark:text-zinc-500 mt-1">Alertas</div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <h3 className="text-sm font-bold text-slate-800 dark:text-zinc-200 uppercase tracking-wider mb-4 flex items-center gap-2 border-t border-slate-200 dark:border-zinc-800 pt-6">
                            <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                            Historial Diario de Fallas
                        </h3>

                        <div className="space-y-3 relative">
                            {/* Vertical Line */}
                            <div className="absolute left-[85px] top-2 bottom-2 w-0.5 bg-slate-100 dark:bg-zinc-800"></div>

                            {sortedAlarms.map((alarm, idx) => (
                                <div key={idx} className="flex gap-4 group">
                                    <div className="w-20 pt-1 text-right">
                                        <div className="text-xs font-bold text-slate-500 dark:text-zinc-400">{alarm.Date.split(' ')[0]}</div>
                                        <div className="text-[10px] text-slate-400 dark:text-zinc-500">{alarm.Date.split(' ')[1]}</div>
                                    </div>

                                    <div className="relative z-10 pt-1.5">
                                        <div className={`w-3 h-3 rounded-full border-2 border-white ring-1 
                                            ${alarm.severity === 'Alta' ? 'bg-red-500 ring-red-100 dark:ring-red-900/50' :
                                                alarm.severity === 'Media' ? 'bg-amber-500 ring-amber-100 dark:ring-amber-900/50' :
                                                    'bg-blue-500 ring-blue-100 dark:ring-blue-900/50'}`}></div>
                                    </div>

                                    <div className="flex-1 bg-slate-50 dark:bg-zinc-900 rounded p-3 border border-transparent group-hover:border-slate-200 dark:border-zinc-800 transition-colors">
                                        <div className="flex justify-between items-start gap-2">
                                            <div className="text-sm font-bold text-slate-700 dark:text-zinc-300">
                                                {alarm.diagnosis}
                                                <span className="text-slate-400 dark:text-zinc-500 font-normal ml-2 text-xs">
                                                    ({alarm._total_alerts || 1} alarmas)
                                                </span>
                                            </div>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase whitespace-nowrap
                                                 ${alarm.severity === 'Alta' ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400' :
                                                    alarm.severity === 'Media' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400' :
                                                        'bg-slate-200 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                                                {alarm.level}
                                            </span>
                                        </div>
                                        <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                                            <span className="font-semibold">Acción:</span> {alarm.action}
                                        </div>
                                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-2 font-mono">
                                            Componente: {alarm.component} | Log: {alarm.DiskDetails}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Right Column: Comments (Bitácora) */}
                    <div className="w-full lg:w-96 flex flex-col bg-slate-50 dark:bg-zinc-900 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-zinc-800 h-96 lg:h-auto">
                        <div className="p-4 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm z-10">
                            <h3 className="text-sm font-bold text-slate-700 dark:text-zinc-300 flex items-center gap-2">
                                💬 Bitácora de Seguimiento
                            </h3>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">
                            <CommentTimeline comments={repairData?.comments || []} />
                        </div>
                        <div className="p-4 border-t border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
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
    onUpdateWorkType: (id: string, workType: RepairTracking['workType']) => void;
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
    onUpdateWorkType,
    onAddComment,
    selectedDevice,
    onSelectDevice,
    onViewDetails
}) => {
    const tracking = repairData[item.equipment];
    const status = tracking?.status || 'Pendiente';
    const workType = tracking?.workType || 'Pendiente';
    const [isExpanded, setIsExpanded] = React.useState(false);
    const useId = item.id || item.equipment;

    return (
        <React.Fragment>
            <tr
                className={`hover:bg-slate-50 dark:bg-zinc-900 transition-colors ${selectedDevice === item.equipment ? 'bg-blue-100/50 ring-1 ring-blue-400 dark:ring-blue-700/50' : ''}`}
            >
                <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                        {/* Expand/Collapse Button */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsExpanded(!isExpanded);
                            }}
                            className="text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:text-zinc-400 transition-colors"
                            title={isExpanded ? "Ocultar comentarios" : "Ver comentarios"}
                        >
                            {isExpanded ? '▼' : '▶'}
                        </button>

                        <div
                            className="cursor-pointer flex-1"
                            onClick={() => onSelectDevice && onSelectDevice(item.equipment === selectedDevice ? null : item.equipment)}
                        >
                            <div className="font-bold text-lg text-slate-900 dark:text-zinc-100 font-mono">{useId}</div>
                            {/* Mostrar todas las placas como badges */}
                            {item.allPlates && item.allPlates.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                    {item.allPlates.map((plate: string, idx: number) => (
                                        <span key={idx} className={`inline-flex items-center text-[9px] px-1.5 py-0.5 rounded border ${idx === 0
                                            ? 'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800 font-bold'
                                            : 'bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                                            }`}>
                                            {idx === 0 ? '🚛' : '🔄'} {plate}
                                        </span>
                                    ))}
                                </div>
                            )}
                            <div className="text-xs text-slate-500 dark:text-zinc-400">{item.fleet}</div>
                        </div>
                    </div>
                </td>
                <td className="px-4 py-3 text-center">
                    <span className="font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/40 px-2 py-0.5 rounded">
                        {item.highSeverityCount}
                    </span>
                </td>
                <td className="px-4 py-3 text-center">
                    <select
                        aria-label="Tipo de trabajo"
                        className={`text-xs font-bold py-1 px-2 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer
                            ${workType === 'Pendiente' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-300 dark:border-zinc-700' :
                                workType === 'Cambio' ? 'bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-800' :
                                    workType === 'Formateo' ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-400 border-cyan-300 dark:border-cyan-800' :
                                        'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-800'}
                        `}
                        value={workType}
                        onChange={(e) => onUpdateWorkType(item.equipment, e.target.value as RepairTracking['workType'])}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <option value="Pendiente">Pendiente</option>
                        <option value="Cambio">Cambio</option>
                        <option value="Formateo">Formateo</option>
                        <option value="Configuración">Configuración</option>
                    </select>
                </td>
                <td className="px-4 py-3 text-right">
                    <select
                        aria-label="Estado de reparación"
                        className={`text-xs font-bold py-1 px-2 rounded border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer
                            ${status === 'Pendiente' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-300 dark:border-zinc-700' :
                                status === 'Revisión Remota' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-400 border-purple-300 dark:border-purple-800' :
                                    status === 'En Proceso' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800' :
                                        status === 'Validando' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-800' :
                                            'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800'}
                        `}
                        value={status}
                        onChange={(e) => onUpdateStatus(item.equipment, e.target.value, item.highSeverityCount)}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <option value="Pendiente">Pendiente</option>
                        <option value="Revisión Remota">Revisión Remota</option>
                        <option value="En Proceso">En Proceso</option>
                        <option value="Validando">Validando</option>
                        <option value="Reparado">Reparado</option>
                    </select>
                </td>
            </tr>

            {/* Fila de Comentarios (Expandible) */}
            {isExpanded && (
                <tr className="bg-slate-50 dark:bg-zinc-900/50">
                    <td colSpan={4} className="px-4 py-3 border-b border-slate-100 dark:border-zinc-800">
                        <div className="pl-6 space-y-3">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => onViewDetails && onViewDetails(item.equipment)}
                                    className="text-xs bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 hover:bg-slate-50 dark:bg-zinc-900 px-3 py-1 rounded shadow-sm flex items-center gap-1 text-slate-600 dark:text-zinc-400"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    Ver Detalles Completos
                                </button>
                            </div>
                            <CommentTimeline
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
const TrackingColumn = ({ title, color, data, repairData, onUpdateStatus, onUpdateWorkType, onAddComment, selectedDevice, onSelectDevice, onViewDetails, showAll = false, statusFilter = 'all', workTypeFilter = 'all' }: {
    title: string,
    color: 'blue' | 'orange',
    data: any[],
    repairData: Record<string, RepairTracking>,
    onUpdateStatus: (id: string, status: any, alerts: number) => void,
    onUpdateWorkType: (id: string, workType: RepairTracking['workType']) => void,
    onAddComment: (deviceId: string, commentText: string) => void,
    selectedDevice?: string | null,
    onSelectDevice?: (device: string | null) => void,
    onViewDetails?: (device: string) => void,
    showAll?: boolean,
    statusFilter?: 'all' | 'Pendiente' | 'Revisión Remota' | 'En Proceso' | 'Validando' | 'Reparado',
    workTypeFilter?: 'all' | 'Pendiente' | 'Cambio' | 'Formateo' | 'Configuración'
}) => {
    const { t } = useTranslation();
    // Estado de paginación
    const [currentPage, setCurrentPage] = React.useState(0);

    // Estado de búsqueda por placa o ID
    const [columnSearchTerm, setColumnSearchTerm] = React.useState('');

    // Filtrar y ordenar con useMemo para evitar re-renders
    const items = React.useMemo(() => {
        let filtered = data
            .filter((d: any) => showAll ? d.totalAlerts > 0 : d.highSeverityCount > 1)
            .sort((a: any, b: any) => showAll ? b.totalAlerts - a.totalAlerts : b.highSeverityCount - a.highSeverityCount);

        // Aplicar búsqueda por placa o ID
        if (columnSearchTerm.trim()) {
            const term = columnSearchTerm.toLowerCase().trim();
            filtered = filtered.filter((d: any) => {
                // Buscar por ID (equipment ahora es el ID)
                const matchesId = d.equipment?.toLowerCase().includes(term) || d.id?.toLowerCase().includes(term);
                // Buscar en todas las placas asociadas
                const matchesPlate = d.allPlates?.some((plate: string) => plate.toLowerCase().includes(term));
                return matchesId || matchesPlate;
            });
        }

        // Aplicar filtro de estado si no es 'all'
        if (statusFilter !== 'all') {
            filtered = filtered.filter((d: any) => {
                const status = repairData[d.equipment]?.status || 'Pendiente';
                return status === statusFilter;
            });
        }

        // Aplicar filtro de tipo de trabajo
        if (workTypeFilter !== 'all') {
            filtered = filtered.filter((d: any) => {
                const wt = repairData[d.equipment]?.workType || 'Pendiente';
                return wt === workTypeFilter;
            });
        }

        // Si no es showAll, limitar a Top 5
        if (!showAll) {
            filtered = filtered.slice(0, 5);
        }

        return filtered;
    }, [data, showAll, statusFilter, workTypeFilter, repairData, columnSearchTerm]);

    // Paginación para showAll
    const ITEMS_PER_PAGE = 50;
    const totalPages = showAll ? Math.ceil(items.length / ITEMS_PER_PAGE) : 1;
    const paginatedItems = showAll
        ? items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE)
        : items;

    const top10 = paginatedItems;

    const bgColor = color === 'blue' ? 'bg-blue-50 dark:bg-blue-900/40' : 'bg-orange-50 dark:bg-orange-900/40';
    const borderColor = color === 'blue' ? 'border-blue-200 dark:border-blue-800' : 'border-orange-200 dark:border-orange-800';
    const textColor = color === 'blue' ? 'text-blue-800 dark:text-blue-400' : 'text-orange-800 dark:text-orange-400';

    const handleExportCSV = () => {
        const headers = ['Equipo', 'Fallas L1', 'TRABAJO', 'ESTADO'];
        const csvRows = [headers.join(',')];

        items.forEach((item: any) => {
            const rd = repairData[item.equipment] || {};
            const workType = rd.workType || 'Pendiente';
            const status = rd.status || 'Pendiente';

            const row = [
                `"${item.equipment}"`,
                item.highSeverityCount || 0,
                `"${workType}"`,
                `"${status}"`
            ];
            csvRows.push(row.join(','));
        });

        const csvString = csvRows.join('\n');
        // Usar BOM para que Excel lea los acentos correctamente
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');

        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `Seguimiento_${safeTitle}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div className={`rounded-xl border ${borderColor} shadow-sm overflow-hidden bg-white dark:bg-zinc-900`}>
            {/* Search Bar and Pagination */}
            {showAll && (
                <div className="px-6 py-3 border-b border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 space-y-3">
                    {/* Search Input */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-zinc-500" />
                        <input
                            type="text"
                            value={columnSearchTerm}
                            onChange={(e) => {
                                setColumnSearchTerm(e.target.value);
                                setCurrentPage(0); // Reset pagination on search
                            }}
                            placeholder="Buscar por placa (ej. ABC-123) o ID (ej. 9087654321)..."
                            className="w-full pl-9 pr-8 py-2 text-sm border border-slate-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                        />
                        {columnSearchTerm && (
                            <button
                                onClick={() => setColumnSearchTerm('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500 hover:text-slate-600"
                                title="Limpiar búsqueda"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {/* Pagination Controls */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between text-xs">
                            <div className="text-slate-500 dark:text-zinc-400">
                                {t('showing')} {currentPage * ITEMS_PER_PAGE + 1} - {Math.min((currentPage + 1) * ITEMS_PER_PAGE, items.length)} {t('of')} {items.length} equipos
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setCurrentPage(prev => Math.max(0, prev - 1))}
                                    disabled={currentPage === 0}
                                    className="px-3 py-1.5 font-bold rounded-md border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    ← Anterior
                                </button>
                                <span className="px-3 py-1.5 font-bold text-slate-600 dark:text-zinc-400">
                                    Página {currentPage + 1} de {totalPages}
                                </span>
                                <button
                                    onClick={() => setCurrentPage(prev => Math.min(totalPages - 1, prev + 1))}
                                    disabled={currentPage >= totalPages - 1}
                                    className="px-3 py-1.5 font-bold rounded-md border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Siguiente →
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Title Header */}
            <div className={`px-6 py-4 border-b ${borderColor} ${bgColor} flex justify-between items-center`}>
                <h3 className={`font-bold ${textColor} flex items-center gap-2`}>
                    {title}
                    <span className="bg-white dark:bg-zinc-900 px-2 py-0.5 rounded text-xs border border-slate-200 dark:border-zinc-800 text-slate-500 dark:text-zinc-400 hidden sm:inline-block">
                        {showAll ? `${items.length} Equipos` : 'Top 5 Críticos'}
                    </span>
                </h3>
                <button
                    onClick={handleExportCSV}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded border transition-colors text-xs font-bold shadow-sm ${color === 'blue'
                        ? 'bg-white dark:bg-zinc-900 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                        : 'bg-white dark:bg-zinc-900 border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40'
                        }`}
                    title="Exportar a CSV"
                >
                    <Download className="w-4 h-4" />
                    CSV
                </button>
            </div>

            <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 font-semibold uppercase text-xs">
                    <tr>
                        <th className="px-4 py-3">{t('th_plate')}</th>
                        <th className="px-4 py-3 text-center">{t('th_l1')}</th>
                        <th className="px-4 py-3 text-center">{t('th_work')}</th>
                        <th className="px-4 py-3 text-right">{t('th_status')}</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {top10.map((item: any) => (
                        <TrackingRow
                            key={item.equipment}
                            item={item}
                            repairData={repairData}
                            onUpdateStatus={onUpdateStatus}
                            onUpdateWorkType={onUpdateWorkType}
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
                                <div className="text-slate-400 dark:text-zinc-500 italic">
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
            : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300  hover:bg-slate-100 dark:bg-zinc-800 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800'
            }`}
    >
        {icon}
        {label}
    </button>
);

// Constantes
const RECORDS_PER_PAGE = 50;

const ALL_MONTHS = [
    { id: 'January', label: 'Enero', num: 1 },
    { id: 'February', label: 'Febrero', num: 2 },
    { id: 'March', label: 'Marzo', num: 3 },
    { id: 'April', label: 'Abril', num: 4 },
    { id: 'May', label: 'Mayo', num: 5 },
    { id: 'June', label: 'Junio', num: 6 },
    { id: 'July', label: 'Julio', num: 7 },
    { id: 'August', label: 'Agosto', num: 8 },
    { id: 'September', label: 'Septiembre', num: 9 },
    { id: 'October', label: 'Octubre', num: 10 },
    { id: 'November', label: 'Noviembre', num: 11 },
    { id: 'December', label: 'Diciembre', num: 12 }
];

interface AvailableMonthInfo {
    year: number;
    month: number;
    count: number;
    earliest: string;
    latest: string;
}

export default function TracklogDashboard() {
    const { t, i18n } = useTranslation();

    // --- ESTADOS DE AUTENTICACION Y MODO ADMIN ---
    const [isAdmin, setIsAdmin] = useState(false);
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [loginPassword, setLoginPassword] = useState('');
    const [loginError, setLoginError] = useState('');

    // Check auth session
    useEffect(() => {
        const checkSession = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            setIsAdmin(!!session);
        };
        checkSession();

        const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
            setIsAdmin(!!session);
        });

        return () => {
            authListener.subscription.unsubscribe();
        };
    }, []);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoginError('');
        const { error } = await supabase.auth.signInWithPassword({
            email: 'investigacion@tracklog.pe',
            password: loginPassword,
        });

        if (error) {
            setLoginError('Contraseña incorrecta o hubo un error');
        } else {
            setShowLoginModal(false);
            setLoginPassword('');
        }
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    // --- ESTADOS ---
    const [data, setData] = useState<ProcessedData[]>([]);
    const [trendRows, setTrendRows] = useState<TrendData[]>([]);

    const [isLoading, setIsLoading] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [lastUpdate, setLastUpdate] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabType>('dashboard');

    // --- DATA SELECTOR STATES ---
    const [dataRangeReady, setDataRangeReady] = useState(false);
    const [availableMonthsInfo, setAvailableMonthsInfo] = useState<AvailableMonthInfo[]>([]);
    const [isDiscovering, setIsDiscovering] = useState(true);
    const [discoveryError, setDiscoveryError] = useState<string | null>(null);
    const [selectorYear, setSelectorYear] = useState(new Date().getFullYear());
    const [selectorMode, setSelectorMode] = useState<'months' | 'custom'>('months');
    const [selectorMonths, setSelectorMonths] = useState<{year: number, month: number}[]>([]);
    const [customDateFrom, setCustomDateFrom] = useState<Date | null>(null);
    const [customDateTo, setCustomDateTo] = useState<Date | null>(null);
    // Rango activo que se envía a loadData
    const [activeDateRange, setActiveDateRange] = useState<{from: string, to: string} | null>(null);
    const [activeRangeLabel, setActiveRangeLabel] = useState('');
    const [trackingFilter, setTrackingFilter] = useState<'all' | 'yanacocha' | 'repsol'>('all');

    // Modo Oscuro
    const [isDarkMode, setIsDarkMode] = useState(() => {
        const saved = localStorage.getItem('theme');
        return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
    });

    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark');
            localStorage.setItem('theme', 'light');
        }
    }, [isDarkMode]);

    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    // Estado para Seguimiento Correctivo
    const [repairData, setRepairData] = useState<Record<string, RepairTracking>>({});

    // Estado para filtro de nivel en Seguimiento General
    const [generalSeverityFilter, setGeneralSeverityFilter] = useState<'all' | 'L1' | 'L2' | 'L3'>('all');

    // Estado para filtro de estado de reparación en Seguimiento General
    const [generalStatusFilter, setGeneralStatusFilter] = useState<'all' | 'Pendiente' | 'Revisión Remota' | 'En Proceso' | 'Validando' | 'Reparado'>('all');
    const [generalWorkTypeFilter, setGeneralWorkTypeFilter] = useState<'all' | 'Pendiente' | 'Cambio' | 'Formateo' | 'Configuración'>('all');
    const [generalComponentFilter, setGeneralComponentFilter] = useState<'all' | 'ssd' | 'sd' | 'other'>('all');

    // Cargar datos de reparación persistentes desde Supabase
    useEffect(() => {
        const fetchTrackingData = async () => {
            const { data, error } = await supabase.from('repair_tracking').select('*');
            if (error) {
                console.error("Error cargando tracking DB", error);
                return;
            }
            if (data) {
                const db: Record<string, RepairTracking> = {};
                data.forEach(row => {
                    db[row.device_id] = {
                        deviceId: row.device_id,
                        macroGroup: row.macro_group,
                        initialAlerts: row.initial_alerts,
                        status: row.status,
                        workType: row.work_type,
                        repairDate: row.repair_date,
                        notes: row.notes,
                        comments: row.comments || [],
                        priority: row.priority,
                        assignedTo: row.assigned_to,
                        estimatedCompletionDate: row.estimated_completion_date,
                        actualCompletionDate: row.actual_completion_date,
                        lastModifiedBy: row.last_modified_by,
                        lastModifiedDate: row.last_modified_date,
                        createdDate: row.created_date
                    };
                });
                setRepairData(db);
            }
        };

        fetchTrackingData();

        const subscription = supabase
            .channel('table-db-changes')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'repair_tracking' },
                () => {
                    fetchTrackingData();
                }
            )
            .subscribe();

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    // Migración automática de repairData: claves de placa → ID
    useEffect(() => {
        if (data.length === 0 || Object.keys(repairData).length === 0) return;

        // Construir mapa placa → ID desde los datos procesados
        const plateToId = new Map<string, string>();
        data.forEach(d => {
            if (d.ID && d.DeviceName) {
                plateToId.set(d.DeviceName, d.ID);
            }
        });

        let needsMigration = false;
        const migrated: Record<string, RepairTracking> = {};

        Object.entries(repairData).forEach(([key, value]) => {
            // Si la clave ya parece ser un ID (solo dígitos, ~10 chars), mantenerla
            if (/^\d{8,12}$/.test(key)) {
                migrated[key] = value;
            } else if (plateToId.has(key)) {
                // La clave es un nombre de placa, migrar al ID
                const id = plateToId.get(key)!;
                needsMigration = true;
                // Si ya existe una entrada con ese ID, hacer merge (conservar la más reciente)
                if (migrated[id]) {
                    const existing = migrated[id];
                    const existingDate = new Date(existing.lastModifiedDate).getTime();
                    const newDate = new Date(value.lastModifiedDate).getTime();
                    if (newDate > existingDate) {
                        migrated[id] = { ...value, deviceId: id, comments: [...existing.comments, ...value.comments] };
                    } else {
                        migrated[id] = { ...existing, comments: [...existing.comments, ...value.comments] };
                    }
                } else {
                    migrated[id] = { ...value, deviceId: id };
                }
            } else {
                // Clave desconocida, mantenerla por seguridad
                migrated[key] = value;
            }
        });

        if (needsMigration) {
            console.log('Migrating repairData keys from plate names to IDs...');
            setRepairData(migrated);
            localStorage.setItem('repair_tracking_db', JSON.stringify(migrated));
        }
    }, [data]); // Solo ejecutar cuando data cambie

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
    const updateRepairStatus = async (deviceId: string, status: RepairTracking['status'], macroGroup: 'Yanacocha' | 'Repsol' | 'General', alerts: number) => {
        if (!isAdmin) {
            alert("No tienes permisos para modificar el estado. Debes iniciar como Administrador.");
            setShowLoginModal(true);
            return;
        }

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

        const newEntry = {
            deviceId,
            macroGroup,
            initialAlerts: existing?.initialAlerts || alerts,
            status,
            workType: existing?.workType || 'Pendiente' as const,
            repairDate: status === 'Reparado' ? now : existing?.repairDate,
            notes: existing?.notes,

            comments: newComments,
            priority: existing?.priority || 'Media',
            assignedTo: existing?.assignedTo,
            estimatedCompletionDate: existing?.estimatedCompletionDate,
            actualCompletionDate: status === 'Reparado' ? now : existing?.actualCompletionDate,
            lastModifiedBy: 'Usuario', // TODO: Get from auth system
            lastModifiedDate: now,
            createdDate: existing?.createdDate || now
        };

        const updated = {
            ...repairData,
            [deviceId]: newEntry
        };
        setRepairData(updated);

        // Supabase DB UPSERT
        const { error } = await supabase.from('repair_tracking').upsert({
            device_id: newEntry.deviceId,
            macro_group: newEntry.macroGroup,
            initial_alerts: newEntry.initialAlerts,
            status: newEntry.status,
            work_type: newEntry.workType,
            repair_date: newEntry.repairDate,
            notes: newEntry.notes,
            comments: newEntry.comments,
            priority: newEntry.priority,
            assigned_to: newEntry.assignedTo,
            estimated_completion_date: newEntry.estimatedCompletionDate,
            actual_completion_date: newEntry.actualCompletionDate,
            last_modified_by: newEntry.lastModifiedBy,
            last_modified_date: newEntry.lastModifiedDate,
            created_date: newEntry.createdDate
        });

        if (error) console.error("Error updating status in Supabase:", error);
    };

    // Actualizar tipo de trabajo
    const updateWorkType = async (deviceId: string, workType: RepairTracking['workType']) => {
        if (!isAdmin) {
            alert("No tienes permisos para modificar el tipo de trabajo. Debes iniciar como Administrador.");
            setShowLoginModal(true);
            return;
        }

        const existing = repairData[deviceId];
        const now = new Date().toISOString();

        const newComments = existing?.comments || [];

        if (existing && existing.workType !== workType) {
            newComments.push(createSystemComment(
                `Tipo de trabajo cambiado de "${existing.workType || 'Pendiente'}" a "${workType}"`
            ));
        }

        if (!existing) {
            newComments.push(createSystemComment(
                `Equipo agregado al seguimiento con tipo de trabajo: ${workType}`
            ));
        }

        const newEntry = {
            ...existing,
            deviceId,
            macroGroup: existing?.macroGroup || 'General' as const,
            initialAlerts: existing?.initialAlerts || 0,
            status: existing?.status || 'Pendiente' as const,
            workType,
            comments: newComments,
            priority: existing?.priority || 'Media' as const,
            lastModifiedBy: 'Usuario',
            lastModifiedDate: now,
            createdDate: existing?.createdDate || now
        };

        const updated = {
            ...repairData,
            [deviceId]: newEntry
        };
        setRepairData(updated);

        // Supabase DB UPSERT
        const { error } = await supabase.from('repair_tracking').upsert({
            device_id: newEntry.deviceId,
            macro_group: newEntry.macroGroup,
            initial_alerts: newEntry.initialAlerts,
            status: newEntry.status,
            work_type: newEntry.workType,
            repair_date: newEntry.repairDate,
            notes: newEntry.notes,
            comments: newEntry.comments,
            priority: newEntry.priority,
            assigned_to: newEntry.assignedTo,
            estimated_completion_date: newEntry.estimatedCompletionDate,
            actual_completion_date: newEntry.actualCompletionDate,
            last_modified_by: newEntry.lastModifiedBy,
            last_modified_date: newEntry.lastModifiedDate,
            created_date: newEntry.createdDate
        });

        if (error) console.error("Error updating work type in Supabase:", error);
    };

    // Add user comment to equipment
    const addComment = async (deviceId: string, commentText: string, author: string = 'Usuario') => {
        if (!isAdmin) {
            alert("No tienes permisos para añadir comentarios. Debes iniciar como Administrador.");
            setShowLoginModal(true);
            return;
        }

        const now = new Date().toISOString();
        const existing = repairData[deviceId];

        const newComment: Comment = {
            id: generateCommentId(),
            text: commentText,
            author,
            timestamp: now,
            type: 'user'
        };

        let updatedEntry: RepairTracking;

        if (existing) {
            // Ya existe una entrada, solo agregar el comentario
            updatedEntry = {
                ...existing,
                comments: [...existing.comments, newComment],
                lastModifiedBy: author,
                lastModifiedDate: now
            };
        } else {
            // No existe entrada: crear una nueva con estado "Pendiente"
            updatedEntry = {
                deviceId,
                macroGroup: 'General',
                initialAlerts: 0,
                status: 'Pendiente',
                workType: 'Pendiente',
                notes: undefined,
                comments: [newComment],
                priority: 'Media',
                assignedTo: undefined,
                estimatedCompletionDate: undefined,
                actualCompletionDate: undefined,
                lastModifiedBy: author,
                lastModifiedDate: now,
                createdDate: now
            };
        }

        const updated = {
            ...repairData,
            [deviceId]: updatedEntry
        };

        setRepairData(updated);

        // Supabase DB UPSERT
        const { error } = await supabase.from('repair_tracking').upsert({
            device_id: updatedEntry.deviceId,
            macro_group: updatedEntry.macroGroup,
            initial_alerts: updatedEntry.initialAlerts,
            status: updatedEntry.status,
            work_type: updatedEntry.workType,
            repair_date: updatedEntry.repairDate,
            notes: updatedEntry.notes,
            comments: updatedEntry.comments,
            priority: updatedEntry.priority,
            assigned_to: updatedEntry.assignedTo,
            estimated_completion_date: updatedEntry.estimatedCompletionDate,
            actual_completion_date: updatedEntry.actualCompletionDate,
            last_modified_by: updatedEntry.lastModifiedBy,
            last_modified_date: updatedEntry.lastModifiedDate,
            created_date: updatedEntry.createdDate
        });

        if (error) console.error("Error adding comment to Supabase:", error);
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
    const [selectedMonths, setSelectedMonths] = useState<string[]>([]); // Ya no se usa como trigger principal

    // const [availableMonths, setAvailableMonths] = useState<{ id: string, name: string, file: string }[]>([]);
    const [filterPv, setFilterPv] = useState<string>('all');
    const [filterModel, setFilterModel] = useState<string>('all');
    const [hasSearched, setHasSearched] = useState(false);

    // --- ESTADOS PARA SERVER-SIDE PAGINATION ---
    const [serverRecords, setServerRecords] = useState<ProcessedData[]>([]);
    const [serverTotalCount, setServerTotalCount] = useState(0);
    const [_isSearching, setIsSearching] = useState(false);

    const parseDateParam = (dateStr: string) => {
        if (!dateStr) return null;
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
        }
        return dateStr;
    }

    const fetchDetailedRecords = async (pageToLoad = 1) => {
        setIsSearching(true);
        setHasSearched(true);
        setCurrentPage(pageToLoad);

        try {
            let query = supabase.from('raw_alarms').select('*', { count: 'exact' });

            // 1. Buscador de Texto (Dispositivo, detalles o diagnóstico)
            if (searchTerm) {
                query = query.or(`device_name.ilike.%${searchTerm}%,device_id_code.ilike.%${searchTerm}%,start_details.ilike.%${searchTerm}%,diagnosis.ilike.%${searchTerm}%`);
            }

            // 2. Filtros Simples
            if (filterFleet !== 'all') query = query.eq('fleet', filterFleet);
            if (filterSeverity !== 'all') query = query.eq('severity', filterSeverity);
            if (filterComponent !== 'all') {
                const compMap = { 'ssd': 'SSD/HDD', 'sd': 'SD/Firebox', 'other': 'Otros' };
                query = query.eq('component', compMap[filterComponent as keyof typeof compMap]);
            }

            // 3. Rango de Fechas
            if (dateRange.start) {
                const startDate = parseDateParam(dateRange.start);
                if (startDate) query = query.gte('begin_time', `${startDate} 00:00:00`);
            }
            if (dateRange.end) {
                const endDate = parseDateParam(dateRange.end);
                if (endDate) query = query.lte('begin_time', `${endDate} 23:59:59`);
            }

            // 4. Filtros Locales Avanzados (PV y Modalidad) usando mapeo inverso
            if (filterPv !== 'all' || filterModel !== 'all') {
                const validDevices = data.filter(d =>
                    (filterPv === 'all' || d.pvName === filterPv) &&
                    (filterModel === 'all' || d.model === filterModel)
                ).map(d => d.DeviceName);

                if (validDevices.length === 0) {
                    setServerRecords([]);
                    setServerTotalCount(0);
                    setIsSearching(false);
                    return;
                }

                // Supabase in() restriction: prevent huge arrays
                query = query.in('device_name', validDevices.slice(0, 100));
            }

            // Paginación
            const startIdx = (pageToLoad - 1) * RECORDS_PER_PAGE;
            const endIdx = startIdx + RECORDS_PER_PAGE - 1;

            query = query.range(startIdx, endIdx).order('begin_time', { ascending: false });

            const { data: rawRes, count, error } = await query;

            if (error) throw error;

            if (rawRes && count !== null) {
                setServerTotalCount(count);

                // Map raw db to ProcessedData for rendering
                const mappedRecords = rawRes.map((row, index) => {
                    const d = new Date(row.begin_time);
                    const localeDateStr = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

                    return {
                        id: index,
                        DeviceName: row.device_name,
                        ID: row.device_id_code || '',
                        Fleet: row.fleet || 'General',
                        DiskType: 'From Table',
                        DiskDetails: row.start_details || '',
                        Speed: '0',
                        Date: localeDateStr,
                        ReUpload: 'No',
                        RawDetails: '',
                        AlarmStatus: '',
                        speedVal: 0,
                        component: row.component || 'Otros',
                        action: row.action || '',
                        severity: row.severity || 'Baja',
                        level: row.level || 'NA',
                        diagnosis: row.diagnosis || '',
                        _total_alerts: 1,
                        model: 'Dynamic',
                        pv: 'Dynamic',
                        pvName: 'Dynamic'
                    };
                });

                setServerRecords(mappedRecords);
            }

        } catch (err) {
            console.error('Error fetching paginated records:', err);
            alert('Error al consultar la base de datos.');
        } finally {
            setIsSearching(false);
        }
    };

    const [recordsStatusFilter, setRecordsStatusFilter] = useState<'all' | 'Pendiente' | 'Revisión Remota' | 'En Proceso' | 'Validando' | 'Reparado'>('all');

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

    // Handler para "Seleccionar Todo" (de todos los resultados filtrados en todas las páginas)
    const toggleSelectAll = () => {
        const newSet = new Set(selectedIds);
        const allSelected = groupedData.every(item => newSet.has(item.equipment));

        if (allSelected) {
            groupedData.forEach(item => newSet.delete(item.equipment));
        } else {
            groupedData.forEach(item => newSet.add(item.equipment));
        }
        setSelectedIds(newSet);
    };

    // Handler Generar PDF
    const handleGeneratePDF = () => {
        const selectedItems = groupedData.filter(g => selectedIds.has(g.equipment));
        generateWorkOrderPDF(selectedItems, repairData);
    };






    // Funciones de Respaldo eliminadas (ya no son necesarias por Supabase)

    const parseDateToISO = (dateStr: string) => {
        if (!dateStr) return new Date().toISOString();

        // Normalizar separadores y casos donde venga con T o puntos
        const normalized = dateStr.replace(/\./g, '/').trim();
        const parts = normalized.split(/[ \/:\-T]/);
        
        if (parts.length >= 3) {
            let y, m, d, h = 0, min = 0, s = 0;
            if (parts[0].length === 4) {
                y = parts[0]; m = parts[1]; d = parts[2];
            } else {
                d = parts[0]; m = parts[1]; y = parts[2];
            }
            if (parts[3]) h = parseInt(parts[3], 10);
            if (parts[4]) min = parseInt(parts[4], 10);
            if (parts[5]) s = parseInt(parts[5], 10);

            // Validar que los números extraídos tengan sentido antes de formatear
            if (!isNaN(Number(y)) && !isNaN(Number(m)) && !isNaN(Number(d))) {
                return `${y.padStart(4, '20')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}Z`;
            }
        }
        
        // Fallback Javascript nativo
        const fallback = new Date(dateStr);
        if (!isNaN(fallback.getTime())) {
            return fallback.toISOString();
        }

        // Si es irreconocible, retorna hoy
        return new Date().toISOString();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        // Permitir que React re-renderice la pantalla de carga antes de procesar el archivo
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            if (!isAdmin) {
                alert("Debes ser administrador para subir archivos.");
                return;
            }

            const text = await file.text();

            // Cargar diccionarios auxiliares para enriquecer data (Flotas y MDVRs)
            const [mdvrRes, fleetRes] = await Promise.all([
                fetch('/mdvrDetailsPvModel.csv'),
                fetch('/mdvrVideotracklogAll.csv')
            ]);
            let mdvrMap;
            const fleetMap = new Map();
            if (mdvrRes.ok) mdvrMap = parseMdvrDetails(await mdvrRes.text());
            if (fleetRes.ok) {
                const lines = (await fleetRes.text()).split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    const parts = line.split(';');
                    if (parts.length > 3) {
                        const rawDevName = parts[0].trim();
                        const nameMatch = rawDevName.match(/^(.*)\((\d+)\)$/);
                        const devName = nameMatch ? nameMatch[1].trim() : rawDevName;
                        if (devName && parts[3]) fleetMap.set(devName, parts[3].trim());
                    }
                }
            }

            // Usar nuestra misma lógica perfecta para mapear y clasificar L1/L2
            const processedArray = processCSV(text, mdvrMap, fleetMap);

            if (processedArray.length === 0) {
                alert("El archivo no contiene filas válidas.");
                return;
            }

            // --- PROTECCIÓN CONTRA CORRUPCIÓN DE FECHAS ---
            // Revisar si la primera fecha extraída está cayendo al "fallback" de hoy por problemas de formato
            const sampleRawDate = processedArray[0].Date;
            const sampleISO = parseDateToISO(sampleRawDate);
            const isTodayFallback = sampleISO.startsWith(new Date().toISOString().split('T')[0]);
            
            // Si el conversor aplicó "hoy" agresivamente pero la fila original claramente tiene otra información
            if (isTodayFallback && sampleRawDate && !sampleRawDate.includes(new Date().getDate().toString())) {
                const proceed = window.confirm(`⚠️ ¡ALERTA DE FORMATO DE FECHA!\n\nLa aplicación no pudo reconocer el formato de la fecha: "${sampleRawDate}". \nSi continúas, las gráficas quedarán agrupadas erróneamente en el día de HOY.\n\n¿Deseas cancelar la subida para revisar el CSV?`);
                if (proceed) return; // return if user clicks OK to "cancel the upload" (proceed to cancel)
            }

            // Formatear masivamente a objetos SQL
            const rawPayload = processedArray.map(item => ({
                device_name: item.DeviceName || 'Unknown',
                device_id_code: item.ID || '',
                alarm_type: 'Disk Status', // Marcador por defecto para diferenciar
                fleet: item.Fleet,
                alarm_status: item.AlarmStatus || '',
                begin_time: parseDateToISO(item.Date),
                start_details: item.RawDetails || item.DiskDetails || '',
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
                const uniqueKey = `${item.device_name}_${item.begin_time}_${item.alarm_type}_${item.start_details}_${item.alarm_status}`;
                uniqueMap.set(uniqueKey, item);
            });
            const dbPayload = Array.from(uniqueMap.values());

            // Inserción en bloques (Ya que eliminaremos el Trigger en Supabase, podemos subir lotes más grandes y eficientes)
            const BATCH_SIZE = 500;
            let totalInserted = 0;

            for (let i = 0; i < dbPayload.length; i += BATCH_SIZE) {
                const batch = dbPayload.slice(i, i + BATCH_SIZE);
                let attempt = 0;
                let success = false;
                
                while (attempt < 5 && !success) {
                    const { error } = await supabase.from('raw_alarms').upsert(batch, {
                        onConflict: 'device_name, begin_time, alarm_type, start_details, alarm_status'
                    });

                    if (error) {
                        const isTimeout = error.code === '57014' || error.message?.toLowerCase().includes('timeout');
                        if (isTimeout && attempt < 4) {
                            console.warn(`Timeout en lote ${i}, reintentando... (intento ${attempt + 1})`);
                            attempt++;
                            await new Promise(r => setTimeout(r, 4000)); // Esperar 4s antes de reintentar
                        } else {
                            console.error("Batch insert error:", error);
                            throw error;
                        }
                    } else {
                        success = true;
                    }
                }
                
                totalInserted += batch.length;
                await new Promise(r => setTimeout(r, 10)); // Yield repintado DOM
            }

            // Actualizar last_updated global
            await supabase.from('system_metadata').upsert({ id: 1, last_updated: new Date().toISOString() });

            // Solicitar a Supabase que recalcule las Vistas Materializadas para que el Dashboard lea lo más reciente de inmediato
            try {
                await supabase.rpc('refresh_dashboard_views');
            } catch (rpcErr) {
                console.warn("No se pudo refrescar vistas materializadas (tal vez aún no existan):", rpcErr);
            }

            alert(`¡Carga Incremental Procesada!\nSe pasaron ${totalInserted} registros estructurados directamente a la Base de Datos PostgreSQL.\nDuplicados omitidos automáticamente.`);
            setIsMobileMenuOpen(false);

            await loadData(true);
        } catch (error: any) {
            console.error("Error batch save:", error);
            alert("Error crítico subiendo registros SQL: " + (error?.message || JSON.stringify(error)));
        } finally {
            setIsLoading(false);
            const fileInput = document.getElementById('csv-upload') as HTMLInputElement;
            if (fileInput) fileInput.value = '';
        }
    };

    // Forzar refresh de vistas materializadas en Supabase sin recargar toda la UI
    const handleSyncViews = async () => {
        setIsSyncing(true);
        try {
            await supabase.rpc('refresh_dashboard_views');
            await loadData(true);
        } catch (err: any) {
            console.error('Error al refrescar vistas:', err);
            const isTimeout = err?.code === '57014' || err?.message?.includes('statement timeout');
            if (isTimeout) {
                alert('⏳ La sincronización tardó demasiado.\nLos datos base ya están en PostgreSQL. Las vistas se actualizarán pronto automáticamente vía trigger.\n\nSi el problema persiste, ejecuta el SQL actualizado en el Editor SQL de Supabase.');
            } else {
                alert(`Error al sincronizar con Supabase:\n${err?.message || JSON.stringify(err)}`);
            }
        } finally {
            setIsSyncing(false);
        }
    };

    // 1. CARGA INTELIGENTE DE DATOS DESDE POSTGRES
    // Helper: ejecutar query con un reintento automático si hay timeout
    const queryWithRetry = async <T,>(queryFn: () => Promise<{ data: T | null; error: any }>, retries = 1, delayMs = 2000): Promise<{ data: T | null; error: any }> => {
        const result = await queryFn();
        if (result.error && (result.error.code === '57014' || result.error.message?.includes('statement timeout')) && retries > 0) {
            console.warn(`Timeout detectado, reintentando en ${delayMs}ms... (${retries} intento(s) restante(s))`);
            await new Promise(r => setTimeout(r, delayMs));
            return queryWithRetry(queryFn, retries - 1, delayMs * 1.5);
        }
        return result;
    };

    // --- DISCOVERY: Query rápida para saber qué meses/años tienen datos ---
    useEffect(() => {
        const discoverAvailableData = async () => {
            setIsDiscovering(true);
            setDiscoveryError(null);
            try {
                // Intentar vía RPC (si ya se creó la función)
                const { data: rpcData, error: rpcError } = await supabase.rpc('get_available_months');

                if (!rpcError && rpcData && rpcData.length > 0) {
                    const mapped: AvailableMonthInfo[] = rpcData.map((r: any) => ({
                        year: r.alarm_year,
                        month: r.alarm_month,
                        count: Number(r.record_count),
                        earliest: r.earliest_date,
                        latest: r.latest_date
                    }));
                    setAvailableMonthsInfo(mapped);

                    // Auto-seleccionar el año más reciente con datos
                    const latestYear = Math.max(...mapped.map(m => m.year));
                    setSelectorYear(latestYear);
                } else {
                    // Fallback: query directa a view_device_summary (sin año, solo meses)
                    console.warn('RPC get_available_months no disponible, usando fallback:', rpcError?.message);
                    const { data: fallbackData, error: fallbackError } = await supabase
                        .from('view_device_summary')
                        .select('month_number')
                        .limit(1000);

                    if (fallbackError) throw fallbackError;

                    if (fallbackData) {
                        const currentYear = new Date().getFullYear();
                        const monthCounts = new Map<number, number>();
                        fallbackData.forEach((row: any) => {
                            const m = Number(row.month_number);
                            monthCounts.set(m, (monthCounts.get(m) || 0) + 1);
                        });

                        const mapped: AvailableMonthInfo[] = Array.from(monthCounts.entries()).map(([month, count]) => ({
                            year: currentYear,
                            month,
                            count,
                            earliest: `${currentYear}-${String(month).padStart(2, '0')}-01`,
                            latest: `${currentYear}-${String(month).padStart(2, '0')}-28`
                        }));
                        setAvailableMonthsInfo(mapped);
                        setSelectorYear(currentYear);
                    }
                }
            } catch (err: any) {
                console.error('Error descubriendo datos disponibles:', err);
                setDiscoveryError(err?.message || 'No se pudieron descubrir los datos disponibles.');
            } finally {
                setIsDiscovering(false);
            }
        };

        discoverAvailableData();
    }, []);

    // Helper: computar rango de fechas desde selección de meses
    const computeDateRangeFromMonths = (months: {year: number, month: number}[]): {from: string, to: string} | null => {
        if (months.length === 0) return null;
        const sorted = [...months].sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const from = `${first.year}-${String(first.month).padStart(2, '0')}-01`;
        const lastDay = new Date(last.year, last.month, 0).getDate();
        const to = `${last.year}-${String(last.month).padStart(2, '0')}-${lastDay}`;
        return { from, to };
    };

    // Helper: confirmar selección y cargar datos
    const confirmDataSelection = () => {
        let range: {from: string, to: string} | null = null;
        let label = '';

        if (selectorMode === 'months' && selectorMonths.length > 0) {
            range = computeDateRangeFromMonths(selectorMonths);
            const monthNames = selectorMonths.map(sm => {
                const m = ALL_MONTHS.find(am => am.num === sm.month);
                return `${m?.label || sm.month} ${sm.year}`;
            });
            label = monthNames.join(', ');

            // Mantener selectedMonths sincronizado para compatibilidad legacy
            const monthIds = selectorMonths.map(sm => ALL_MONTHS.find(am => am.num === sm.month)?.id).filter(Boolean) as string[];
            setSelectedMonths([...new Set(monthIds)]);
        } else if (selectorMode === 'custom' && customDateFrom && customDateTo) {
            const from = `${customDateFrom.getFullYear()}-${String(customDateFrom.getMonth() + 1).padStart(2, '0')}-${String(customDateFrom.getDate()).padStart(2, '0')}`;
            const to = `${customDateTo.getFullYear()}-${String(customDateTo.getMonth() + 1).padStart(2, '0')}-${String(customDateTo.getDate()).padStart(2, '0')}`;
            range = { from, to };
            label = `${customDateFrom.toLocaleDateString()} — ${customDateTo.toLocaleDateString()}`;
        }

        if (range) {
            setActiveDateRange(range);
            setActiveRangeLabel(label);
            setDataRangeReady(true);
        }
    };

    const loadData = async (_force: boolean = false) => {
        if (!activeDateRange) return;
        setIsLoading(true);
        setLoadError(null);
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            // Usar rango de fechas en vez de month_number para soportar multi-año
            const { from: dateFrom, to: dateTo } = activeDateRange;

            // 1. CARGAR RESUMEN GENERAL desde la vista materializada
            // Filtrar por mes extraído del rango (arreglando offset de timezone)
            const [fromYear, fromMonth, fromDay] = dateFrom.split('-').map(Number);
            const [toYear, toMonth, toDay] = dateTo.split('-').map(Number);
            const fromDate = new Date(fromYear, fromMonth - 1, fromDay);
            const toDate = new Date(toYear, toMonth - 1, toDay);

            // 1. CARGAR RESUMEN GENERAL
            // Consultamos la agrupación parametrizada vía RPC para respetar 100% el rango de fechas incluso custom
            fromDate.setHours(0, 0, 0, 0);
            toDate.setHours(23, 59, 59, 999);

            const { data: summaryData, error: summaryError } = await queryWithRetry(async () =>
                await supabase.rpc('get_device_summary_custom', {
                    p_from: fromDate.toISOString(),
                    p_to: toDate.toISOString()
                })
            );

            if (summaryError) {
                const isTimeout = summaryError.code === '57014' || summaryError.message?.includes('statement timeout');
                if (isTimeout) {
                    setLoadError('La consulta excedió el tiempo límite (Timeout). Intenta con un rango más pequeño.');
                } else if (summaryError.message?.includes('Could not find the function')) {
                    setLoadError('Falta actualizar la Base de Datos. Por favor corre el script SQL upgrade_to_dynamic_summary.sql en Supabase.');
                } else {
                    setLoadError(`Error contactando a Supabase: ${summaryError.message || JSON.stringify(summaryError)}`);
                }
                setIsLoading(false);
                return;
            }

            // 2. CARGAR TENDENCIAS DIARIAS (no-fatal)
            try {
                const { data: trendsData, error: trendsError } = await queryWithRetry(async () =>
                    await supabase
                        .from('view_daily_trends')
                        .select('*')
                        .gte('alarm_date', dateFrom)
                        .lte('alarm_date', dateTo)
                );

                if (trendsError) {
                    console.warn('Tendencias no disponibles:', trendsError.message);
                } else if (trendsData) {
                    setTrendRows(trendsData as any[]);
                }
            } catch (trendErr) {
                console.warn('No se pudieron cargar tendencias:', trendErr);
            }

            if (!summaryData) return;

            // Convertir el resumen SQL a la interfaz ProcessedData legacy
            const mappedProcessed = (summaryData as any[]).map((row: any, index: number) => {
                const dd = new Date(row.latest_alarm || new Date().toISOString());
                const localeDateStr = `${dd.getDate().toString().padStart(2, '0')}/${(dd.getMonth() + 1).toString().padStart(2, '0')}/${dd.getFullYear()} ${dd.getHours().toString().padStart(2, '0')}:${dd.getMinutes().toString().padStart(2, '0')}:${dd.getSeconds().toString().padStart(2, '0')}`;

                return {
                    id: index,
                    DeviceName: row.device_name,
                    ID: row.device_id_code || '',
                    Fleet: row.fleet || 'General',
                    DiskType: 'Aggregated',
                    DiskDetails: row.disk_details || 'Dashboard SQL View',
                    Speed: '0',
                    Date: localeDateStr,
                    ReUpload: 'No',
                    RawDetails: '',
                    AlarmStatus: '',
                    speedVal: 0,
                    component: row.component,
                    action: row.action,
                    severity: row.severity,
                    level: row.level,
                    diagnosis: row.diagnosis || 'Consolidado General',
                    model: '',
                    pv: '',
                    pvName: '',
                    _total_alerts: Number(row.total_alerts)
                };
            });

            setData(mappedProcessed);

            // Validar metadatos
            try {
                const { data: metaData } = await supabase.from('system_metadata').select('last_updated').eq('id', 1).single();
                if (metaData && metaData.last_updated) {
                    setLastUpdate(new Date(metaData.last_updated).toLocaleString());
                } else {
                    setLastUpdate(new Date().toLocaleString());
                }
            } catch (e) {
                console.warn("Metadatos no disponibles.");
            }

            // (Legacy update for availableMonths removed)
            setLoadError(null);

        } catch (err: any) {
            console.error("Error SQL loadData:", err);
            const isTimeout = err?.code === '57014' || err?.message?.includes('statement timeout');
            if (isTimeout) {
                setLoadError('La consulta excedió el tiempo límite. Intenta con un rango más pequeño.');
            } else {
                setLoadError(`Error contactando a Supabase: ${err?.message || JSON.stringify(err)}`);
            }
        } finally {
            setIsLoading(false);
        }
    };

    // Cargar datos cuando cambia el rango activo
    useEffect(() => {
        if (activeDateRange && dataRangeReady) {
            loadData(false);
        }
    }, [activeDateRange]);



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

        const totalAlerts = statsData.reduce((sum, d) => sum + (d._total_alerts || 1), 0);

        // Contar equipos únicos totales
        const uniqueDevices = new Set(statsData.map(d => d.ID || d.DeviceName));
        const totalDevices = uniqueDevices.size;

        // Contar equipos únicos por tipo de acción y alertas totales
        const criticalRows = statsData.filter(d => d.action === 'Reemplazo Físico');
        const criticalDevices = new Set(criticalRows.map(d => d.ID || d.DeviceName));
        const criticalAlerts = criticalRows.reduce((sum, d) => sum + (d._total_alerts || 1), 0);

        const logicalRows = statsData.filter(d => d.action === 'Mantenimiento Lógico');
        const logicalDevices = new Set(logicalRows.map(d => d.ID || d.DeviceName));
        const logicalAlerts = logicalRows.reduce((sum, d) => sum + (d._total_alerts || 1), 0);

        const reviewRows = statsData.filter(d => d.action === 'Revisión Config/Instalación');
        const reviewDevices = new Set(reviewRows.map(d => d.ID || d.DeviceName));
        const reviewAlerts = reviewRows.reduce((sum, d) => sum + (d._total_alerts || 1), 0);

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

        // Agrupación por Día (Tendencia) desde la Vista SQL Optimizada
        const trendMap: Record<string, number> = {};
        trendRows.forEach(row => {
            // Aplicar el mismo filtro Scope
            const inInternalSet = TRACKLOG_INTERNAL_FLEETS.has(row.fleet) || row.fleet === 'TRACKLOG';
            const inScope = scopeFilter === 'all' ? true : (scopeFilter === 'internal' ? inInternalSet : !inInternalSet);

            // Validar filtros del dashboard 
            // (action filter not applicable to trend data from view_daily_trends)

            if (inScope) {
                trendMap[row.alarm_date] = (trendMap[row.alarm_date] || 0) + Number(row.total_alerts);
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
            // Buscador Texto (por placa, ID, detalles o diagnóstico)
            const matchesSearch = !searchTerm ||
                item.DeviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (item.ID && item.ID.toLowerCase().includes(searchTerm.toLowerCase())) ||
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
            // CLAVE: Agrupar por ID (único y permanente) en lugar de DeviceName (placa, que puede cambiar)
            const key = item.ID || item.DeviceName;

            if (!groups.has(key)) {
                groups.set(key, {
                    id: item.ID || '',
                    equipment: key, // Ahora la clave principal es el ID
                    allPlates: [item.DeviceName], // Inicializar con la primera placa
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
            } else {
                // Acumular placas distintas asociadas a este ID
                const group = groups.get(key)!;
                if (!group.allPlates.includes(item.DeviceName)) {
                    group.allPlates.push(item.DeviceName);
                }
            }

            const group = groups.get(key)!;
            group.totalAlerts += (item._total_alerts || 1);

            // Determinar severidad máxima
            const severityOrder = { 'Alta': 3, 'Media': 2, 'Baja': 1, 'Otro': 0 };
            const itemSev = item.severity || 'Baja';
            const groupSev = group.maxSeverity || 'Baja';

            if ((severityOrder[itemSev as keyof typeof severityOrder] || 0) > (severityOrder[groupSev as keyof typeof severityOrder] || 0)) {
                group.maxSeverity = itemSev;
                group.worstDiagnosis = item.diagnosis || '';
                group.suggestedAction = item.action || '';
            } else if ((severityOrder[itemSev as keyof typeof severityOrder] || 0) === (severityOrder[groupSev as keyof typeof severityOrder] || 0)) {
                // Si es la misma severidad, concatenar diagnóstico
                if (item.diagnosis && group.worstDiagnosis && !group.worstDiagnosis.includes(item.diagnosis) && group.worstDiagnosis.length < 100) {
                    group.worstDiagnosis += " | " + item.diagnosis;
                }
            }

            if (item.severity === 'Alta') group.highSeverityCount += (item._total_alerts || 1);
        });

        return Array.from(groups.values()).sort((a, b) => {
            // Ordenar: primero críticos, luego por cantidad de alertas
            const sevOrder = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
            if (sevOrder[b.maxSeverity] !== sevOrder[a.maxSeverity]) {
                return sevOrder[b.maxSeverity] - sevOrder[a.maxSeverity];
            }
            return b.totalAlerts - a.totalAlerts;
        }).filter(group => {
            // Filtro por estado de reparación (solo en vista de equipos)
            if (recordsStatusFilter === 'all') return true;
            const status = repairData[group.equipment]?.status || 'Pendiente';
            return status === recordsStatusFilter;
        });

    }, [filteredData, viewMode, scopedData, hasSearched, recordsStatusFilter, repairData]);

    // Paginación (Dinámica según el modo)
    const currentDataSource = viewMode === 'devices' ? groupedData : filteredData;
    const totalPages = Math.ceil((viewMode === 'devices' ? currentDataSource.length : serverTotalCount) / RECORDS_PER_PAGE);

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

    // Interceptar cambios de página para el modo alertas
    const handlePageChange = (newPage: number) => {
        if (viewMode === 'alerts') {
            fetchDetailedRecords(newPage);
        } else {
            setCurrentPage(newPage);
        }
    };

    const resetFilters = () => {
        setSearchTerm('');
        setFilterFleet('all');
        setFilterSeverity('all');
        setFilterComponent('all');
        setDateRange({ start: '', end: '' });
        setFilterPv('all');
        setFilterModel('all');
        setRecordsStatusFilter('all');
        setHasSearched(false);
        setCurrentPage(1);
    };

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 font-sans text-slate-900 dark:text-zinc-100 transition-colors">

            {/* HEADER DE GESTIÓN */}
            <header className="bg-white dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 sticky top-0 z-50 transition-colors">
                <div className="max-w-7xl mx-auto px-6 py-4">
                    <div className="flex justify-between items-center">

                        {/* Logo & Status */}
                        <div className="flex items-center gap-3">
                            <div className="bg-blue-600 p-2 rounded-lg shadow-sm">
                                <Database className="w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-100 tracking-tight leading-none">{t('title')}</h1>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">{t('subtitle')}</span>
                                    {lastUpdate && (
                                        <span className="text-[10px] bg-emerald-100 dark:bg-zinc-800 text-emerald-700 dark:text-zinc-300 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-zinc-700">
                                            Actualizado: {lastUpdate}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Active Range Badge */}
                            {dataRangeReady && activeRangeLabel && (
                                <button
                                    onClick={() => { setDataRangeReady(false); setIsMobileMenuOpen(false); }}
                                    className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors shadow-sm"
                                    title="Cambiar rango de datos"
                                >
                                    <Filter className="w-3.5 h-3.5" />
                                    {activeRangeLabel.length > 30 ? activeRangeLabel.substring(0, 30) + '...' : activeRangeLabel}
                                </button>
                            )}
                        </div>

                        {/* Contenedor Derecho: Menú Hamburguesa + Idiomas + Dark Mode */}
                        <div className="flex items-center gap-4">
                            {/* Admin Auth Toggle */}
                            {isAdmin ? (
                                <button
                                    onClick={handleLogout}
                                    className="hidden sm:flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-200 dark:hover:bg-emerald-900 transition-colors shadow-sm"
                                    title="Cerrar sesión de Administrador"
                                >
                                    <Unlock className="w-4 h-4" />
                                    Admin Activo
                                </button>
                            ) : (
                                <button
                                    onClick={() => setShowLoginModal(true)}
                                    className="hidden sm:flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors shadow-sm"
                                    title="Desbloquear Modo Administrador"
                                >
                                    <Lock className="w-4 h-4" />
                                    Solo Lectura
                                </button>
                            )}

                            {/* Language Selector */}
                            <div className="hidden sm:flex items-center bg-slate-100 dark:bg-zinc-800 rounded-full p-1 shadow-sm border border-slate-200 dark:border-zinc-700">
                                <Globe className="w-4 h-4 text-slate-500 dark:text-zinc-400 ml-2 mr-1" />
                                {['es', 'en', 'zh'].map((lang) => (
                                    <button
                                        key={lang}
                                        onClick={() => i18n.changeLanguage(lang)}
                                        className={`px-3 py-1 text-xs font-bold rounded-full transition-colors ${i18n.language.startsWith(lang) ? 'bg-white dark:bg-zinc-600 text-blue-600 dark:text-blue-400 shadow' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'}`}
                                    >
                                        {lang.toUpperCase()}
                                    </button>
                                ))}
                            </div>

                            {/* Sync Button */}
                            <button
                                onClick={handleSyncViews}
                                disabled={isSyncing || isLoading}
                                className={`hidden sm:flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shadow-sm ${isSyncing
                                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-400 dark:text-blue-500 border-blue-200 dark:border-blue-800 cursor-wait'
                                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800'
                                    }`}
                                title="Sincronizar datos con Supabase ahora"
                                aria-label="Sincronizar base de datos"
                            >
                                <RefreshCcw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                                {isSyncing ? 'Sincronizando...' : 'Sincronizar BD'}
                            </button>

                            {/* Dark Mode Toggle */}
                            <button
                                onClick={() => setIsDarkMode(!isDarkMode)}
                                className="p-2 rounded-full bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 transition-colors shadow-sm border border-slate-200 dark:border-zinc-700"
                                title={isDarkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
                            >
                                {isDarkMode ? <Sun className="w-5 h-5 text-amber-500 dark:text-amber-400" /> : <Moon className="w-5 h-5 text-slate-600 dark:text-zinc-400" />}
                            </button>

                            {/* Hamburger Menu Toggle */}
                            <div className="relative">
                                <button
                                    onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                                    className="p-2 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 transition-colors border border-slate-200 dark:border-zinc-700"
                                    title="Abrir menú"
                                    aria-label="Menú principal"
                                >
                                    <Menu className="w-5 h-5" />
                                </button>

                                {/* Hamburger Dropdown */}
                                {isMobileMenuOpen && (
                                    <div className="absolute right-0 mt-3 w-80 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col gap-4 p-5 animate-in fade-in slide-in-from-top-2">

                                        {/* Scope Filters */}
                                        <div className="flex flex-col gap-3">
                                            <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Filtros</span>
                                            <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-1">
                                                <button
                                                    onClick={() => setScopeFilter('customer')}
                                                    className={`flex-1 px-3 py-1.5 text-xs font-bold rounded transition-all ${scopeFilter === 'customer' ? 'bg-white dark:bg-zinc-700 text-blue-700 dark:text-white shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}
                                                >
                                                    Clientes
                                                </button>
                                                <button
                                                    onClick={() => setScopeFilter('internal')}
                                                    className={`flex-1 px-3 py-1.5 text-xs font-bold rounded transition-all ${scopeFilter === 'internal' ? 'bg-white dark:bg-zinc-700 text-blue-700 dark:text-white shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}
                                                >
                                                    Tracklog
                                                </button>
                                                <button
                                                    onClick={() => setScopeFilter('all')}
                                                    className={`flex-1 px-3 py-1.5 text-xs font-bold rounded transition-all ${scopeFilter === 'all' ? 'bg-white dark:bg-zinc-700 text-blue-700 dark:text-white shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}
                                                >
                                                    Todos
                                                </button>
                                            </div>
                                        </div>

                                        <div className="h-px w-full bg-slate-100 dark:bg-zinc-800" />

                                        {/* Cambiar Rango de Datos */}
                                        <div className="flex flex-col gap-3">
                                            <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Rango de Datos</span>
                                            <button
                                                onClick={() => {
                                    setDataRangeReady(false);
                                                    setIsMobileMenuOpen(false);
                                                }}
                                                className="w-full flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg text-sm font-bold border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                                            >
                                                <Filter className="w-4 h-4" />
                                                Cambiar Rango de Datos
                                            </button>
                                            {activeRangeLabel && (
                                                <p className="text-[10px] text-slate-400 dark:text-zinc-500 px-1">Actual: {activeRangeLabel}</p>
                                            )}
                                        </div>

                                        {isAdmin && (
                                            <>
                                                <div className="h-px w-full bg-slate-100 dark:bg-zinc-800" />

                                                {/* Upload CSV + Sync Tools */}
                                                <div className="flex flex-col gap-3">
                                                    <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider text-blue-600">Herramientas de Administrador</span>

                                                    {/* Forzar Refresco de Vistas Materializadas */}
                                                    <button
                                                        onClick={async () => {
                                                            setIsSyncing(true);
                                                            try {
                                                                await supabase.rpc('refresh_dashboard_views');
                                                                await loadData(true);
                                                                setIsMobileMenuOpen(false);
                                                                alert('✅ Vistas materializadas refrescadas. Los datos ahora reflejan el estado actual de la base de datos.');
                                                            } catch (err: any) {
                                                                console.error('Error al refrescar vistas:', err);
                                                                alert(`❌ Error al refrescar:\n${err?.message || JSON.stringify(err)}`);
                                                            } finally {
                                                                setIsSyncing(false);
                                                            }
                                                        }}
                                                        disabled={isSyncing}
                                                        className="w-full justify-center flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-lg text-sm font-bold transition-colors cursor-pointer shadow-md shadow-emerald-500/20"
                                                    >
                                                        <RefreshCcw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                                                        {isSyncing ? 'Sincronizando...' : 'Forzar Actualización de Datos'}
                                                    </button>

                                                    <label
                                                        className="w-full justify-center flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold transition-colors cursor-pointer shadow-md shadow-blue-500/20"
                                                    >
                                                        <Upload className="w-4 h-4" /> Cargar Nuevo CSV a la Nube (diskAlarm_...)
                                                        <input
                                                            type="file"
                                                            accept=".csv"
                                                            className="hidden"
                                                            onChange={handleFileUpload}
                                                            disabled={isLoading}
                                                        />
                                                    </label>
                                                </div>
                                            </>
                                        )}

                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* ============================================================ */}
            {/* DATA SELECTOR SCREEN — se muestra antes de cargar el dashboard */}
            {/* ============================================================ */}
            {!dataRangeReady ? (
                <main className="max-w-3xl mx-auto px-6 py-12">
                    <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-slate-200 dark:border-zinc-800 overflow-hidden">

                        {/* Header del selector */}
                        <div className="bg-gradient-to-br from-blue-600 to-indigo-700 px-8 py-8 text-white">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="bg-white/20 p-2.5 rounded-xl backdrop-blur-sm">
                                    <Database className="w-7 h-7" />
                                </div>
                                <div>
                                    <h2 className="text-2xl font-bold">Seleccionar Rango de Datos</h2>
                                    <p className="text-blue-100 text-sm mt-0.5">Elige los meses o rango de fechas a consultar</p>
                                </div>
                            </div>

                            {/* Resumen de datos disponibles */}
                            {availableMonthsInfo.length > 0 && (
                                <div className="mt-4 flex items-center gap-4 text-sm bg-white/10 backdrop-blur-sm rounded-lg px-4 py-2.5">
                                    <span className="text-blue-100">📅 Datos disponibles:</span>
                                    <span className="font-bold">
                                        {ALL_MONTHS.find(m => m.num === Math.min(...availableMonthsInfo.map(a => a.month)))?.label || ''}{' '}
                                        {Math.min(...availableMonthsInfo.map(a => a.year))}
                                        {' — '}
                                        {ALL_MONTHS.find(m => m.num === Math.max(...availableMonthsInfo.map(a => a.month)))?.label || ''}{' '}
                                        {Math.max(...availableMonthsInfo.map(a => a.year))}
                                    </span>
                                    <span className="text-blue-200 text-xs">
                                        ({availableMonthsInfo.reduce((sum, a) => sum + a.count, 0).toLocaleString()} registros)
                                    </span>
                                </div>
                            )}
                        </div>

                        {isDiscovering ? (
                            <div className="flex flex-col items-center justify-center py-20">
                                <div className="relative">
                                    <div className="w-16 h-16 border-4 border-slate-200 dark:border-zinc-800 rounded-full"></div>
                                    <div className="w-16 h-16 border-4 border-blue-600 rounded-full absolute top-0 left-0 animate-spin border-t-transparent"></div>
                                </div>
                                <p className="mt-6 text-slate-500 dark:text-zinc-400 font-medium">Descubriendo datos disponibles...</p>
                            </div>
                        ) : discoveryError ? (
                            <div className="flex flex-col items-center py-16 px-8 text-center">
                                <AlertTriangle className="w-12 h-12 text-amber-500 mb-4" />
                                <h3 className="text-lg font-bold text-slate-700 dark:text-zinc-200 mb-2">Error al descubrir datos</h3>
                                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-6">{discoveryError}</p>
                                <button
                                    onClick={() => window.location.reload()}
                                    className="px-6 py-2.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors"
                                >
                                    Reintentar
                                </button>
                            </div>
                        ) : (
                            <div className="p-6 space-y-6">

                                {/* Modo de selección */}
                                <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-1">
                                    <button
                                        onClick={() => setSelectorMode('months')}
                                        className={`flex-1 px-4 py-2 text-sm font-bold rounded-md transition-all ${selectorMode === 'months' ? 'bg-white dark:bg-zinc-700 text-blue-700 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400'}`}
                                    >
                                        📅 Por Meses
                                    </button>
                                    <button
                                        onClick={() => setSelectorMode('custom')}
                                        className={`flex-1 px-4 py-2 text-sm font-bold rounded-md transition-all ${selectorMode === 'custom' ? 'bg-white dark:bg-zinc-700 text-blue-700 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400'}`}
                                    >
                                        🔍 Rango Personalizado
                                    </button>
                                </div>

                                {selectorMode === 'months' ? (
                                    <>
                                        {/* Year Tabs */}
                                        {(() => {
                                            const availableYears = [...new Set(availableMonthsInfo.map(a => a.year))].sort();
                                            // Si solo hay 1 año, añadir el anterior y siguiente para navegación
                                            const years = availableYears.length > 0
                                                ? [Math.min(...availableYears) - 1, ...availableYears, Math.max(...availableYears) + 1].filter((v, i, arr) => arr.indexOf(v) === i).sort()
                                                : [new Date().getFullYear() - 1, new Date().getFullYear()];

                                            return (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-bold text-slate-400 dark:text-zinc-500 uppercase">Año:</span>
                                                    <div className="flex gap-1.5 flex-wrap">
                                                        {years.map(year => {
                                                            const hasData = availableMonthsInfo.some(a => a.year === year);
                                                            return (
                                                                <button
                                                                    key={year}
                                                                    onClick={() => setSelectorYear(year)}
                                                                    className={`px-4 py-1.5 text-sm font-bold rounded-lg border transition-all ${
                                                                        selectorYear === year
                                                                            ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-200/50 dark:shadow-blue-900/30'
                                                                            : hasData
                                                                                ? 'bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700'
                                                                                : 'bg-slate-50 dark:bg-zinc-900 text-slate-300 dark:text-zinc-600 border-slate-100 dark:border-zinc-800 cursor-default'
                                                                    }`}
                                                                >
                                                                    {year}
                                                                    {hasData && <span className="ml-1 text-[10px] opacity-60">✓</span>}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        {/* 12-Month Grid */}
                                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
                                            {ALL_MONTHS.map(month => {
                                                const info = availableMonthsInfo.find(a => a.year === selectorYear && a.month === month.num);
                                                const isAvailable = !!info;
                                                const isSelected = selectorMonths.some(sm => sm.year === selectorYear && sm.month === month.num);

                                                return (
                                                    <button
                                                        key={`${selectorYear}-${month.num}`}
                                                        disabled={!isAvailable}
                                                        onClick={() => {
                                                            if (!isAvailable) return;
                                                            const key = { year: selectorYear, month: month.num };
                                                            setSelectorMonths(prev => {
                                                                const exists = prev.some(sm => sm.year === key.year && sm.month === key.month);
                                                                return exists
                                                                    ? prev.filter(sm => !(sm.year === key.year && sm.month === key.month))
                                                                    : [...prev, key];
                                                            });
                                                        }}
                                                        className={`relative px-3 py-3.5 rounded-xl border-2 text-left transition-all ${
                                                            isSelected
                                                                ? 'bg-blue-50 dark:bg-blue-900/40 border-blue-500 dark:border-blue-600 ring-1 ring-blue-200 dark:ring-blue-800 shadow-sm'
                                                                : isAvailable
                                                                    ? 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm cursor-pointer'
                                                                    : 'bg-slate-50 dark:bg-zinc-900/50 border-slate-100 dark:border-zinc-800/50 opacity-50 cursor-not-allowed'
                                                        }`}
                                                    >
                                                        <div className={`text-sm font-bold ${isSelected ? 'text-blue-700 dark:text-blue-400' : isAvailable ? 'text-slate-700 dark:text-zinc-300' : 'text-slate-300 dark:text-zinc-600'}`}>
                                                            {month.label}
                                                        </div>
                                                        {isAvailable ? (
                                                            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 font-medium">
                                                                {info.count.toLocaleString()} registros
                                                            </div>
                                                        ) : (
                                                            <div className="text-[10px] text-slate-300 dark:text-zinc-700 mt-0.5">Sin datos</div>
                                                        )}

                                                        {isSelected && (
                                                            <div className="absolute top-1.5 right-1.5">
                                                                <CheckCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                                                            </div>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        {/* Quick select */}
                                        <div className="flex gap-2 flex-wrap">
                                            <button
                                                onClick={() => {
                                                    const yearMonths = availableMonthsInfo
                                                        .filter(a => a.year === selectorYear)
                                                        .map(a => ({ year: a.year, month: a.month }));
                                                    setSelectorMonths(yearMonths);
                                                }}
                                                className="px-3 py-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors border border-blue-100 dark:border-blue-800"
                                            >
                                                Seleccionar todo {selectorYear}
                                            </button>
                                            <button
                                                onClick={() => setSelectorMonths([])}
                                                className="px-3 py-1.5 text-xs font-bold text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 rounded-lg hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                                            >
                                                Limpiar selección
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    /* Custom Date Range */
                                    <div className="space-y-4">
                                        <p className="text-sm text-slate-500 dark:text-zinc-400">Selecciona un rango de fechas personalizado para consultar los datos específicos:</p>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase mb-1.5">Desde</label>
                                                <DatePicker
                                                    selected={customDateFrom}
                                                    onChange={(date: Date | null) => setCustomDateFrom(date)}
                                                    dateFormat="dd/MM/yyyy"
                                                    placeholderText="Fecha inicio"
                                                    className="w-full px-3 py-2.5 border border-slate-300 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase mb-1.5">Hasta</label>
                                                <DatePicker
                                                    selected={customDateTo}
                                                    onChange={(date: Date | null) => setCustomDateTo(date)}
                                                    dateFormat="dd/MM/yyyy"
                                                    placeholderText="Fecha fin"
                                                    className="w-full px-3 py-2.5 border border-slate-300 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                    minDate={customDateFrom || undefined}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Acción principal */}
                                <div className="pt-2 border-t border-slate-100 dark:border-zinc-800">
                                    <button
                                        onClick={confirmDataSelection}
                                        disabled={
                                            (selectorMode === 'months' && selectorMonths.length === 0) ||
                                            (selectorMode === 'custom' && (!customDateFrom || !customDateTo))
                                        }
                                        className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-200/50 dark:shadow-blue-900/30 text-sm flex items-center justify-center gap-2"
                                    >
                                        <LayoutDashboard className="w-5 h-5" />
                                        {selectorMode === 'months'
                                            ? `Cargar Dashboard (${selectorMonths.length} mes${selectorMonths.length !== 1 ? 'es' : ''})`
                                            : 'Cargar Dashboard con Rango'
                                        }
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </main>
            ) : (
            <>

            {/* TABS NAVIGATION */}
            {!isLoading && data.length > 0 && (
                <>
                    <div className="bg-slate-100 dark:bg-zinc-950/50 border-b border-slate-200 dark:border-zinc-800 transition-colors">
                        <div className="max-w-7xl mx-auto px-6 py-3">
                            <div className="flex gap-2">
                                <TabButton
                                    active={activeTab === 'dashboard'}
                                    onClick={() => setActiveTab('dashboard')}
                                    icon={<LayoutDashboard className="w-4 h-4" />}
                                    label={t('tab_dashboard')}
                                />
                                <TabButton
                                    active={activeTab === 'records'}
                                    onClick={() => setActiveTab('records')}
                                    icon={<Table className="w-4 h-4" />}
                                    label={t('tab_records')}
                                />
                                <TabButton
                                    active={activeTab === 'tracking'}
                                    onClick={() => setActiveTab('tracking')}
                                    icon={<Hammer className="w-4 h-4" />}
                                    label={t('tab_corrective')}
                                />
                                <TabButton
                                    active={activeTab === 'general-tracking'}
                                    onClick={() => setActiveTab('general-tracking')}
                                    icon={<Activity className="w-4 h-4" />}
                                    label={t('tab_general')}
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
                            <div className="w-20 h-20 border-4 border-slate-200 dark:border-zinc-800 rounded-full"></div>
                            <div className="w-20 h-20 border-4 border-blue-600 rounded-full absolute top-0 left-0 animate-spin border-t-transparent"></div>
                        </div>
                        <div className="mt-8 text-center">
                            <h2 className="text-xl font-bold text-slate-800 dark:text-zinc-200 mb-2">{t('loading')}</h2>
                            <p className="text-slate-500 dark:text-zinc-400">{t('loading_desc')}</p>
                        </div>
                    </div>
                ) : loadError ? (
                    <div className="flex flex-col items-center justify-center h-[60vh] border-2 border-dashed border-amber-300 dark:border-amber-700 rounded-2xl bg-white dark:bg-zinc-900 text-center p-12">
                        <div className="bg-amber-50 dark:bg-amber-900/40 p-6 rounded-full mb-6 ring-8 ring-amber-50/50 dark:ring-amber-900/20">
                            <AlertTriangle className="w-16 h-16 text-amber-500" />
                        </div>
                        <h2 className="text-2xl font-bold text-slate-800 dark:text-zinc-200 mb-2">Tiempo de espera agotado</h2>
                        <p className="text-slate-500 dark:text-zinc-400 max-w-md mb-4">
                            {loadError}
                        </p>
                        <p className="text-xs text-slate-400 dark:text-zinc-500 max-w-md mb-8">
                            💡 Tip: intenta selecionar menos meses o reintenta en unos segundos.
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => loadData(true)}
                                className="px-8 py-4 bg-blue-600 text-white rounded-xl hover:bg-blue-500 font-bold shadow-lg shadow-blue-200/50 dark:shadow-blue-900/30 transition-all flex items-center gap-2"
                            >
                                <RefreshCcw className="w-5 h-5" />
                                Reintentar
                            </button>
                            <button
                                onClick={() => {
                                    setSelectedMonths(selectedMonths.slice(0, 1));
                                }}
                                className="px-6 py-4 bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 rounded-xl hover:bg-slate-200 dark:hover:bg-zinc-700 font-bold transition-all"
                            >
                                Cargar solo 1 mes
                            </button>
                        </div>
                    </div>
                ) : data.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-[60vh] border-2 border-dashed border-slate-300 dark:border-zinc-700 rounded-2xl bg-white dark:bg-zinc-900 text-center p-12">
                        <div className="bg-red-50 dark:bg-red-900/40 p-6 rounded-full mb-6 ring-8 ring-red-50/50">
                            <AlertTriangle className="w-16 h-16 text-red-400" />
                        </div>
                        <h2 className="text-2xl font-bold text-slate-800 dark:text-zinc-200 mb-2">{t('error_loading')}</h2>
                        <p className="text-slate-500 dark:text-zinc-400 max-w-md mb-8">
                            {t('error_desc')}
                        </p>
                        <button
                            onClick={() => loadData(true)}
                            className="px-8 py-4 bg-blue-600 text-white rounded-xl hover:bg-blue-500 font-bold shadow-lg shadow-blue-200 transition-all"
                        >
                            {t('retry')}
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
                                            <h3 className="text-sm font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Resumen de Estado</h3>
                                            <div className="cursor-help text-slate-400 dark:text-zinc-500 hover:text-blue-500 dark:text-blue-400 transition-colors">
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
                                                <div className="flex items-center gap-2 bg-slate-100 dark:bg-zinc-800 p-1 rounded-lg">
                                                    <button
                                                        onClick={() => setDashboardComponent('all')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'all' ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'}`}
                                                    >
                                                        Todos
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('ssd')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'ssd' ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'}`}
                                                    >
                                                        SSD/HDD
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('sd')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'sd' ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'}`}
                                                    >
                                                        SD/Firebox
                                                    </button>
                                                    <button
                                                        onClick={() => setDashboardComponent('other')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${dashboardComponent === 'other' ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'}`}
                                                    >
                                                        Otros
                                                    </button>
                                                </div>
                                            </div>

                                            {filterAction && (
                                                <button
                                                    onClick={() => setFilterAction(null)}
                                                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:text-blue-400 flex items-center gap-1"
                                                >
                                                    Limpiar Selección <span className="text-lg leading-none">×</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                        <KpiCard
                                            title={t('kpi_total')}
                                            value={stats.totalDevices.toLocaleString()}
                                            subtext={`${stats.totalAlerts.toLocaleString()} ${t('alerts')}`}
                                            icon={<HardDrive />}
                                            color="bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400"
                                            isActive={filterAction === null}
                                            onClick={() => setFilterAction(null)}
                                        />
                                        <KpiCard
                                            title={t('kpi_l1')}
                                            value={stats.critical.toLocaleString()}
                                            subtext={`${stats.criticalAlerts.toLocaleString()} ${t('alerts')}`}
                                            icon={<AlertTriangle />}
                                            color="bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400"
                                            isActive={filterAction === 'Reemplazo Físico'}
                                            onClick={() => setFilterAction('Reemplazo Físico')}
                                        />
                                        <KpiCard
                                            title={t('kpi_l2')}
                                            value={stats.review.toLocaleString()}
                                            subtext={`${stats.reviewAlerts.toLocaleString()} ${t('alerts')}`}
                                            icon={<Wrench />}
                                            color="bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400"
                                            isActive={filterAction === 'Revisión Config/Instalación'}
                                            onClick={() => setFilterAction('Revisión Config/Instalación')}
                                        />
                                        <KpiCard
                                            title={t('kpi_l3')}
                                            value={stats.logical.toLocaleString()}
                                            subtext={`${stats.logicalAlerts.toLocaleString()} ${t('alerts')}`}
                                            icon={<CheckCircle />}
                                            color="bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400"
                                            isActive={filterAction === 'Mantenimiento Lógico'}
                                            onClick={() => setFilterAction('Mantenimiento Lógico')}
                                        />
                                    </div>
                                </section>

                                {/* DASHBOARD RESUMIDO */}
                                <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                    {/* Top Flotas */}
                                    <div className="lg:col-span-2 bg-white dark:bg-zinc-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800">
                                        <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-6 flex items-center gap-2">
                                            <Truck className="w-5 h-5 text-slate-400 dark:text-zinc-500" /> {t('chart_top_fleets')}
                                        </h3>
                                        <div className="h-64" style={{ minWidth: 0 }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={stats.fleetData} layout="vertical" margin={{ left: 10, right: 30, bottom: 0 }}>
                                                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                                                    <XAxis type="number" hide />
                                                    <YAxis dataKey="name" type="category" width={150} style={{ fontSize: '11px', fontWeight: 600, fill: '#475569' }} />
                                                    <RechartsTooltip cursor={{ fill: isDarkMode ? '#27272a' : '#f8fafc' }} contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }} />
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
                                    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800">
                                        <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-6 flex items-center gap-2">
                                            <AlertOctagon className="w-5 h-5 text-slate-400 dark:text-zinc-500" /> Carga de Trabajo
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
                                <section className="bg-white dark:bg-zinc-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800">
                                    <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-6 flex items-center gap-2">
                                        <Activity className="w-5 h-5 text-slate-400 dark:text-zinc-500" /> Tendencia de Fallas (Diario)
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
                                                        contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }}
                                                        labelStyle={{ color: '#64748b', marginBottom: '0.5rem' }}
                                                    />
                                                    <Area type="monotone" dataKey="count" stroke="#3b82f6" fillOpacity={1} fill="url(#colorCount)" name="Alertas" />
                                                </AreaChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </section>

                                {/* Mensaje para ir a registros */}
                                <section className="bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 rounded-xl p-6 text-center">
                                    <p className="text-blue-800 dark:text-blue-400 mb-3">
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
                                    <section className="bg-white dark:bg-zinc-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800">
                                        <div className="flex justify-between items-center mb-4">
                                            <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                                                <Search className="w-5 h-5 text-slate-400 dark:text-zinc-500" /> Buscar Registros
                                            </h3>
                                            <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-1">
                                                <button
                                                    onClick={() => { setViewMode('alerts'); setCurrentPage(1); }}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'alerts'
                                                        ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-zinc-800'
                                                        : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-200 dark:bg-zinc-800'
                                                        }`}
                                                >
                                                    Por Alerta
                                                </button>
                                                <button
                                                    onClick={() => { setViewMode('devices'); setCurrentPage(1); }}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'devices'
                                                        ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-zinc-800'
                                                        : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-200 dark:bg-zinc-800'
                                                        }`}
                                                >
                                                    Por Equipo
                                                </button>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                                            {/* Filtro de FECHAS (Rango) - CON REACT-DATEPICKER */}
                                            <div className="lg:col-span-2 relative z-50">
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">{t('date_range')}</label>
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
                                                        className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500 shadow-sm"
                                                        wrapperClassName="w-full"
                                                    />
                                                </div>
                                            </div>

                                            {/* Filtro por Flota */}
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">{t('fleet')}</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500"
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
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">{t('severity')}</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500"
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
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">Tipo de Disco</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500"
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
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">Ejecutivo Postventa</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500"
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
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">{t('model')} MDVR</label>
                                                <select
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm text-slate-600 dark:text-zinc-400 focus:outline-none focus:border-blue-500"
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
                                                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">Buscar texto</label>
                                                <input
                                                    type="text"
                                                    placeholder={t('search_placeholder')}
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:bg-zinc-900 transition-all"
                                                    value={searchTerm}
                                                    onChange={(e) => setSearchTerm(e.target.value)}
                                                />
                                            </div>
                                        </div>

                                        {/* Filtro por Estado de Reparación (solo en vista de equipos) */}
                                        {viewMode === 'devices' && (
                                            <div className="flex items-center gap-3 mb-4">
                                                <span className="text-sm font-bold text-slate-600 dark:text-zinc-400">Estado:</span>
                                                <div className="flex bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-1 flex-wrap gap-0.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('all')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'all'
                                                            ? 'bg-slate-600 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        Todos
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('Pendiente')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'Pendiente'
                                                            ? 'bg-slate-500 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        Pendiente
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('Revisión Remota')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'Revisión Remota'
                                                            ? 'bg-purple-500 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        Rev. Remota
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('En Proceso')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'En Proceso'
                                                            ? 'bg-amber-500 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        En Proceso
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('Validando')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'Validando'
                                                            ? 'bg-blue-500 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        Validando
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRecordsStatusFilter('Reparado')}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${recordsStatusFilter === 'Reparado'
                                                            ? 'bg-emerald-500 text-white shadow-sm'
                                                            : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                                                            }`}
                                                    >
                                                        Reparado
                                                    </button>
                                                </div>
                                            </div>
                                        )}

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
                                                className="flex items-center gap-2 px-4 py-2.5 bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 text-slate-700 dark:text-zinc-300 rounded-lg font-medium transition-colors"
                                            >
                                                {t('clear_filters')}
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
                                        <section className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800 p-12 text-center">
                                            <div className="bg-slate-50 dark:bg-zinc-900 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                                                <Filter className="w-10 h-10 text-slate-300" />
                                            </div>
                                            <h3 className="text-xl font-bold text-slate-800 dark:text-zinc-200 mb-2">Listo para buscar</h3>
                                            <p className="text-slate-500 dark:text-zinc-400 max-w-md mx-auto">
                                                Utiliza los filtros de arriba y presiona <strong>Buscar</strong> para ver los registros.
                                            </p>
                                        </section>
                                    ) : filteredData.length === 0 ? (
                                        <section className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800 p-12 text-center">
                                            <div className="bg-amber-50 dark:bg-amber-900/40 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                                                <AlertTriangle className="w-10 h-10 text-amber-400" />
                                            </div>
                                            <h3 className="text-xl font-bold text-slate-800 dark:text-zinc-200 mb-2">Sin resultados</h3>
                                            <p className="text-slate-500 dark:text-zinc-400 max-w-md mx-auto">
                                                No se encontraron registros que coincidan con los filtros seleccionados.
                                            </p>
                                        </section>
                                    ) : (
                                        <section className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-800 overflow-hidden">
                                            {/* Info de resultados */}
                                            <div className="bg-slate-50 dark:bg-zinc-900 px-6 py-3 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center">
                                                <span className="text-sm text-slate-600 dark:text-zinc-400">
                                                    {t('showing')} <strong>{((currentPage - 1) * RECORDS_PER_PAGE) + 1}</strong> - <strong>{Math.min(currentPage * RECORDS_PER_PAGE, viewMode === 'devices' ? currentDataSource.length : serverTotalCount)}</strong> {t('of')} <strong>{(viewMode === 'devices' ? currentDataSource.length : serverTotalCount).toLocaleString()}</strong> {viewMode === 'devices' ? 'equipos' : 'registros'}
                                                </span>
                                                <span className="text-sm text-slate-500 dark:text-zinc-400">
                                                    Rango: <strong>{dateRange.start || 'Inicio'}</strong> - <strong>{dateRange.end || 'Fin'}</strong>
                                                </span>


                                            </div>

                                            {/* Tabla */}
                                            <div className="overflow-x-auto">
                                                {viewMode === 'alerts' ? (
                                                    <table className="w-full text-sm text-left">
                                                        <thead className="bg-slate-50 dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 font-semibold uppercase text-xs">
                                                            <tr>
                                                                <th className="px-6 py-4">{t('th_device')}</th>
                                                                <th className="px-6 py-4">{t('th_detail')}</th>
                                                                <th className="px-6 py-4">{t('th_diagnosis')}</th>
                                                                <th className="px-6 py-4 text-center">{t('th_severity')}</th>
                                                                <th className="px-6 py-4 text-right">{t('th_action')}</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-100">
                                                            {serverRecords.map((row) => (
                                                                <tr key={row.id} className="hover:bg-slate-50 dark:bg-zinc-900 transition-colors group">
                                                                    <td className="px-6 py-4">
                                                                        <div className="font-bold text-slate-900 dark:text-zinc-100">{row.DeviceName}</div>
                                                                        <div className="text-xs text-slate-500 dark:text-zinc-400 flex flex-col gap-0.5 mt-0.5">
                                                                            <span className="flex items-center gap-1"><Truck className="w-3 h-3" /> {row.Fleet}</span>
                                                                            <span className="font-mono text-slate-400 dark:text-zinc-500">{row.ID}</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 max-w-xs">
                                                                        <div className="flex items-center gap-2 mb-1">
                                                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${row.component === 'SSD/HDD' ? 'bg-purple-50 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800/50' :
                                                                                row.component === 'SD/Firebox' ? 'bg-cyan-50 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 border-cyan-100 dark:border-cyan-800/50' :
                                                                                    'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-700'
                                                                                }`}>
                                                                                {row.component}
                                                                            </span>
                                                                            <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">{row.DiskType}</span>
                                                                        </div>
                                                                        <div className="text-slate-600 dark:text-zinc-400 truncate group-hover:whitespace-normal group-hover:overflow-visible text-xs leading-relaxed" title={row.DiskDetails}>
                                                                            {row.DiskDetails.replace(/State:/g, '')}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className={`text-sm font-medium ${row.diagnosis.includes("ALERTA") ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-zinc-300'}`}>
                                                                            {row.diagnosis}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${row.severity === 'Alta' ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400' :
                                                                            row.severity === 'Media' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400' :
                                                                                'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400'
                                                                            }`}>
                                                                            {row.severity}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-right">
                                                                        <span className="font-bold text-slate-800 dark:text-zinc-200 text-xs">
                                                                            {row.action}
                                                                        </span>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                ) : (
                                                    <table className="w-full text-sm text-left">
                                                        <thead className="bg-slate-50 dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 font-semibold uppercase text-xs">
                                                            <tr>
                                                                <th className="px-4 py-4 w-10">
                                                                    <input
                                                                        type="checkbox"
                                                                        aria-label="Seleccionar todos los equipos"
                                                                        title="Seleccionar todo"
                                                                        className="w-4 h-4 rounded border-slate-300 dark:border-zinc-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
                                                                        onChange={toggleSelectAll}
                                                                        checked={groupedData.length > 0 && groupedData.every(g => selectedIds.has(g.equipment))}
                                                                    />
                                                                </th>
                                                                <th className="px-6 py-4">{t('th_equipment_fleet')}</th>
                                                                <th className="px-6 py-4 text-center">{t('th_total_alerts')}</th>
                                                                <th className="px-6 py-4">{t('th_main_diagnosis')}</th>
                                                                <th className="px-6 py-4 text-center">{t('th_max_severity')}</th>
                                                                <th className="px-6 py-4 text-right">{t('th_suggested_action')}</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-100">
                                                            {(paginatedData as DeviceGroup[]).map((group, idx) => (
                                                                <tr key={idx} className={`hover:bg-slate-50 dark:bg-zinc-900 transition-colors ${selectedIds.has(group.equipment) ? 'bg-blue-50/30' : ''}`}>
                                                                    <td className="px-4 py-4">
                                                                        <input
                                                                            type="checkbox"
                                                                            aria-label={"Seleccionar equipo " + group.equipment}
                                                                            title={"Seleccionar " + group.equipment}
                                                                            className="w-4 h-4 rounded border-slate-300 dark:border-zinc-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500"
                                                                            checked={selectedIds.has(group.equipment)}
                                                                            onChange={() => toggleSelection(group.equipment)}
                                                                        />
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className="font-bold text-slate-900 dark:text-zinc-100">{group.allPlates?.[0] || group.equipment}</div>
                                                                        {group.id && (
                                                                            <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono mt-0.5">
                                                                                ID: {group.id || group.equipment}
                                                                            </div>
                                                                        )}
                                                                        {group.allPlates && group.allPlates.length > 1 && (
                                                                            <div className="flex flex-wrap gap-1 mt-0.5">
                                                                                {group.allPlates.slice(1).map((plate, pIdx) => (
                                                                                    <span key={pIdx} className="inline-flex items-center text-[9px] bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-800">
                                                                                        🔄 {plate}
                                                                                    </span>
                                                                                ))}
                                                                            </div>
                                                                        )}
                                                                        <div className="text-xs text-slate-500 dark:text-zinc-400 flex flex-col gap-0.5 mt-0.5">
                                                                            <span className="flex items-center gap-1"><Truck className="w-3 h-3" /> {group.fleet}</span>
                                                                            <span className="text-slate-400 dark:text-zinc-500">{group.model}</span>

                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <div className="inline-flex flex-col items-center">
                                                                            <span className="text-lg font-bold text-slate-700 dark:text-zinc-300">{group.totalAlerts}</span>
                                                                            {group.highSeverityCount > 0 && (
                                                                                <span className="text-[10px] text-red-600 dark:text-red-400 font-bold bg-red-50 dark:bg-red-900/40 px-1.5 rounded">
                                                                                    {group.highSeverityCount} Críticas
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4">
                                                                        <div className={`text-sm font-medium ${group.maxSeverity === 'Alta' ? 'text-red-700 dark:text-red-400' : 'text-slate-700 dark:text-zinc-300'}`}>
                                                                            {group.worstDiagnosis}
                                                                        </div>
                                                                        <div className="text-xs text-slate-400 dark:text-zinc-500 mt-1">
                                                                            {group.component} - {group.diskType}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-center">
                                                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${group.maxSeverity === 'Alta' ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400' :
                                                                            group.maxSeverity === 'Media' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400' :
                                                                                'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400'
                                                                            }`}>
                                                                            {group.maxSeverity}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-6 py-4 text-right">
                                                                        <span className="font-bold text-slate-800 dark:text-zinc-200 text-xs block">
                                                                            {group.suggestedAction}
                                                                        </span>
                                                                        {group.pv && group.pv !== 'Sin Asignar' && (
                                                                            <span className="text-[10px] text-slate-400 dark:text-zinc-500 block mt-1">
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
                                                <div className="bg-slate-50 dark:bg-zinc-900 p-4 border-t border-slate-200 dark:border-zinc-800 flex justify-center items-center gap-2">
                                                    <button
                                                        onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                                                        disabled={currentPage === 1}
                                                        className="p-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
                                                                    onClick={() => handlePageChange(pageNum)}
                                                                    className={`w-10 h-10 rounded-lg font-medium text-sm transition-colors ${currentPage === pageNum
                                                                        ? 'bg-blue-600 text-white'
                                                                        : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 hover:bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                                                        }`}
                                                                >
                                                                    {pageNum}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>

                                                    <button
                                                        onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                                                        disabled={currentPage === totalPages}
                                                        className="p-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        aria-label="Página siguiente"
                                                    >
                                                        <ChevronRight className="w-4 h-4" />
                                                    </button>

                                                    <span className="text-sm text-slate-500 dark:text-zinc-400 ml-4">
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
                                <div className="bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 rounded-xl p-6 mb-6">
                                    <h3 className="text-xl font-bold text-blue-900 mb-2">Campaña de Reparación Correctiva</h3>
                                    <p className="text-blue-700 dark:text-blue-400">
                                        Seguimiento de los 10 equipos más críticos (Top 5 por Macro-grupo) que requieren cambio urgente de unidad de almacenamiento.
                                        Estos equipos presentan fallas L1 recurrentes.
                                    </p>
                                    {hasSearched && (
                                        <div className="mt-4 flex items-center justify-between bg-white dark:bg-zinc-900/60 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                                            <span className="text-sm text-blue-800 dark:text-blue-400 font-bold flex items-center gap-2">
                                                <Filter className="w-4 h-4" /> Filtros activos (Registros) afectando resultados
                                            </span>
                                            <button
                                                onClick={resetFilters}
                                                className="text-xs bg-white dark:bg-zinc-900 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 px-3 py-1.5 rounded-md hover:bg-blue-50 dark:bg-blue-900/40 font-bold shadow-sm"
                                            >
                                                {t('clear_filters')}
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* Selector de Macro-grupo */}
                                <div className="flex justify-center mb-6">
                                    <div className="flex bg-slate-200 dark:bg-zinc-800 rounded-lg p-1">
                                        <button
                                            onClick={() => setTrackingFilter('all')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'all'
                                                ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm'
                                                : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'
                                                }`}
                                        >
                                            Ver Todo
                                        </button>
                                        <button
                                            onClick={() => setTrackingFilter('yanacocha')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'yanacocha'
                                                ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm'
                                                : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'
                                                }`}
                                        >
                                            Yanacocha
                                        </button>
                                        <button
                                            onClick={() => setTrackingFilter('repsol')}
                                            className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${trackingFilter === 'repsol'
                                                ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 shadow-sm'
                                                : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300'
                                                }`}
                                        >
                                            Repsol
                                        </button>
                                    </div>
                                </div>

                                {/* GRAFICOS DE SEGUIMIENTO (Solo si se selecciona una flota específica) */}
                                {trackingFilter !== 'all' && (
                                    <div className="mb-8 bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-800 shadow-sm p-6 animate-in fade-in slide-in-from-bottom-4">
                                        <h4 className="text-sm font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-6">
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
                                                revisionRemota: 0,
                                                proceso: 0,
                                                reparado: 0
                                            };

                                            top5.forEach(d => {
                                                const status = repairData[d.equipment]?.status || 'Pendiente';
                                                if (status === 'Pendiente') stats.pendiente++;
                                                else if (status === 'Revisión Remota') stats.revisionRemota++;
                                                else if (status === 'Reparado') stats.reparado++;
                                                else stats.proceso++; // En Proceso / Validando
                                            });

                                            const chartData = [
                                                { name: 'Pendiente', value: stats.pendiente, color: '#94a3b8' },
                                                { name: 'Rev. Remota', value: stats.revisionRemota, color: '#a855f7' },
                                                { name: 'En Proceso', value: stats.proceso, color: '#f59e0b' },
                                                { name: 'Reparado', value: stats.reparado, color: '#10b981' },
                                            ].filter(d => d.value > 0);

                                            // Tendencia (con relleno de huecos y ordenamiento correcto)
                                            // Crear Set de equipos del Top 5 para filtrar
                                            const top5EquipmentSet = new Set(top5.map(d => d.equipment));

                                            const filteredAlarms = scopedData.filter(d => {
                                                // Si hay un dispositivo seleccionado, mostrar solo ese (por ID o por DeviceName)
                                                if (selectedTrackingDevice) {
                                                    return (d.ID === selectedTrackingDevice || d.DeviceName === selectedTrackingDevice) && d.severity === 'Alta';
                                                }
                                                // Si no, mostrar solo los del Top 5 (usando ID como clave)
                                                return (top5EquipmentSet.has(d.ID) || top5EquipmentSet.has(d.DeviceName)) && d.severity === 'Alta';
                                            });

                                            const totalAlarmsCount = filteredAlarms.reduce((sum, curr) => sum + (curr._total_alerts || 1), 0); // Total real de alarmas

                                            const dailyTrend = filteredAlarms.reduce((acc: any, curr) => {
                                                const dateStr = curr.Date.split(' ')[0]; // DD/MM/YYYY
                                                acc[dateStr] = (acc[dateStr] || 0) + (curr._total_alerts || 1);
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
                                                <div className="text-center text-slate-400 dark:text-zinc-500 py-4 italic">No hay datos suficientes para gráficos</div>
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
                                                                    <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }} />
                                                                </PieChart>
                                                            </ResponsiveContainer>
                                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                                <div className="text-center">
                                                                    <span className="block text-3xl font-bold text-slate-800 dark:text-zinc-200">{top5.length}</span>
                                                                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-bold uppercase">Equipos</span>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Status Boxes */}
                                                        <div className="grid grid-cols-4 gap-4">
                                                            <div className="bg-slate-50 dark:bg-zinc-900 rounded-lg p-4 text-center border border-slate-100 dark:border-zinc-800">
                                                                <div className="text-2xl font-bold text-slate-700 dark:text-zinc-300">{stats.pendiente}</div>
                                                                <div className="text-xs text-slate-500 dark:text-zinc-400 font-bold mt-1">Pendientes</div>
                                                            </div>
                                                            <div className="bg-purple-50 dark:bg-purple-900/40 rounded-lg p-4 text-center border border-purple-100">
                                                                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.revisionRemota}</div>
                                                                <div className="text-xs text-purple-600/80 font-bold mt-1">Rev. Remota</div>
                                                            </div>
                                                            <div className="bg-amber-50 dark:bg-amber-900/40 rounded-lg p-4 text-center border border-amber-100">
                                                                <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.proceso}</div>
                                                                <div className="text-xs text-amber-600/80 font-bold mt-1">En Gestión</div>
                                                            </div>
                                                            <div className="bg-emerald-50 dark:bg-emerald-900/40 rounded-lg p-4 text-center border border-emerald-100">
                                                                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.reparado}</div>
                                                                <div className="text-xs text-emerald-600/80 font-bold mt-1">Reparados</div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Trend Chart */}
                                                    <div className="pt-6 border-t border-slate-100 dark:border-zinc-800">
                                                        <div className="flex justify-between items-center mb-4 px-2">
                                                            <h5 className="text-xs font-bold text-slate-400 dark:text-zinc-500 uppercase">Tendencia de Fallas Críticas (L1)</h5>
                                                            <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${selectedTrackingDevice ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400'}`}>
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
                                                                    <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }} />
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
                                            onUpdateWorkType={updateWorkType}
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
                                            onUpdateWorkType={updateWorkType}
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
                                <div className="bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl p-6 mb-6">
                                    <h3 className="text-xl font-bold text-slate-900 dark:text-zinc-100 mb-2">Seguimiento General - Todos los Equipos</h3>
                                    <p className="text-slate-700 dark:text-zinc-300 mb-4">
                                        Vista global de todos los equipos ordenados por cantidad de fallas (de mayor a menor).
                                        Ideal para priorizar reparaciones urgentes independientemente de la flota.
                                    </p>

                                    {/* Filtro de Nivel */}
                                    <div className="flex items-center gap-3 mt-4 relative z-10">
                                        <span className="text-sm font-bold text-slate-600 dark:text-zinc-400">Filtrar por nivel:</span>
                                        <div className="flex bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Todas
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L1')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L1'
                                                    ? 'bg-red-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                L1 (Críticas)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L2')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L2'
                                                    ? 'bg-amber-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                L2 (Config)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralSeverityFilter('L3')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalSeverityFilter === 'L3'
                                                    ? 'bg-blue-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                L3 (Lógicas)
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filtro de Estado de Reparación */}
                                    <div className="flex items-center gap-3 mt-3 relative z-10">
                                        <span className="text-sm font-bold text-slate-600 dark:text-zinc-400">Filtrar por estado:</span>
                                        <div className="flex bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Todos
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Pendiente')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Pendiente'
                                                    ? 'bg-slate-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Pendiente
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Revisión Remota')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Revisión Remota'
                                                    ? 'bg-purple-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Rev. Remota
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('En Proceso')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'En Proceso'
                                                    ? 'bg-amber-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                En Proceso
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Validando')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Validando'
                                                    ? 'bg-blue-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Validando
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralStatusFilter('Reparado')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalStatusFilter === 'Reparado'
                                                    ? 'bg-emerald-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Reparado
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filtro de Tipo de Disco */}
                                    <div className="flex items-center gap-3 mt-3 relative z-10">
                                        <span className="text-sm font-bold text-slate-600 dark:text-zinc-400">Filtrar por disco:</span>
                                        <div className="flex bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Todos
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('ssd')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'ssd'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                SSD / HDD
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('sd')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'sd'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                SD / Firebox
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralComponentFilter('other')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalComponentFilter === 'other'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Otros
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filtro de Tipo de Trabajo */}
                                    <div className="flex items-center gap-3 mt-3 relative z-10">
                                        <span className="text-sm font-bold text-slate-600 dark:text-zinc-400">Filtrar por trabajo:</span>
                                        <div className="flex bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setGeneralWorkTypeFilter('all')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalWorkTypeFilter === 'all'
                                                    ? 'bg-slate-600 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Todos
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralWorkTypeFilter('Pendiente')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalWorkTypeFilter === 'Pendiente'
                                                    ? 'bg-slate-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Pendiente
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralWorkTypeFilter('Cambio')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalWorkTypeFilter === 'Cambio'
                                                    ? 'bg-rose-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Cambio
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralWorkTypeFilter('Formateo')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalWorkTypeFilter === 'Formateo'
                                                    ? 'bg-cyan-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Formateo
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGeneralWorkTypeFilter('Configuración')}
                                                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${generalWorkTypeFilter === 'Configuración'
                                                    ? 'bg-indigo-500 text-white shadow-sm'
                                                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:bg-zinc-900'
                                                    }`}
                                            >
                                                Configuración
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* GRAFICOS DE SEGUIMIENTO GENERAL */}
                                <div className="mb-8 bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-800 shadow-sm p-6">
                                    <h4 className="text-sm font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-6">
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
                                                    (alarm.DeviceName === d.equipment || (alarm.ID && alarm.ID === d.equipment)) && alarm.level === generalSeverityFilter
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
                                            revisionRemota: 0,
                                            proceso: 0,
                                            reparado: 0
                                        };

                                        filteredEquipment.forEach(d => {
                                            const status = repairData[d.equipment]?.status || 'Pendiente';
                                            if (status === 'Pendiente') stats.pendiente++;
                                            else if (status === 'Revisión Remota') stats.revisionRemota++;
                                            else if (status === 'Reparado') stats.reparado++;
                                            else stats.proceso++; // En Proceso / Validando
                                        });

                                        const chartData = [
                                            { name: 'Pendiente', value: stats.pendiente, color: '#94a3b8' },
                                            { name: 'Rev. Remota', value: stats.revisionRemota, color: '#a855f7' },
                                            { name: 'En Proceso', value: stats.proceso, color: '#f59e0b' },
                                            { name: 'Reparado', value: stats.reparado, color: '#10b981' },
                                        ].filter(d => d.value > 0);

                                        // Tendencia - construir set de equipos usando tanto ID como DeviceName para robustez
                                        const allEquipmentNames = new Set(allEquipment.map(d => d.equipment));
                                        const allEquipmentIds = new Set(allEquipment.filter(d => d.id).map(d => d.id));

                                        // Fuente de datos idéntica a groupedData para consistencia
                                        const trendSource = hasSearched ? filteredData : scopedData;

                                        const filteredAlarms = trendSource.filter(d => {
                                            // Filtro por dispositivo (match por nombre O por ID para cubrir agrupación)
                                            const matchesDevice = selectedTrackingDevice
                                                ? (d.ID === selectedTrackingDevice || d.DeviceName === selectedTrackingDevice)
                                                : (allEquipmentNames.has(d.DeviceName) || (d.ID && allEquipmentIds.has(d.ID)));

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

                                        // Total de alarmas: derivado de groupedData para coincidir 1:1 con la tabla
                                        const totalAlarmsCount = selectedTrackingDevice
                                            ? filteredAlarms.reduce((sum, curr) => sum + (curr._total_alerts || 1), 0)
                                            : filteredEquipment.reduce((sum, d) =>
                                                sum + (generalSeverityFilter === 'all' ? d.totalAlerts : d.highSeverityCount), 0);

                                        const dailyTrend = filteredAlarms.reduce((acc: any, curr) => {
                                            const dateStr = curr.Date.split(' ')[0];
                                            acc[dateStr] = (acc[dateStr] || 0) + (curr._total_alerts || 1);
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
                                            <div className="text-center text-slate-400 dark:text-zinc-500 py-4 italic">No hay datos suficientes para gráficos</div>
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
                                                                <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }} />
                                                            </PieChart>
                                                        </ResponsiveContainer>
                                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                            <div className="text-center">
                                                                <span className="block text-3xl font-bold text-slate-800 dark:text-zinc-200">{filteredEquipment.length}</span>
                                                                <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-bold uppercase">Equipos</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Status Boxes */}
                                                    <div className="grid grid-cols-4 gap-4">
                                                        <div className="bg-slate-50 dark:bg-zinc-900 rounded-lg p-4 text-center border border-slate-100 dark:border-zinc-800">
                                                            <div className="text-2xl font-bold text-slate-700 dark:text-zinc-300">{stats.pendiente}</div>
                                                            <div className="text-xs text-slate-500 dark:text-zinc-400 font-bold mt-1">Pendientes</div>
                                                        </div>
                                                        <div className="bg-purple-50 dark:bg-purple-900/40 rounded-lg p-4 text-center border border-purple-100">
                                                            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.revisionRemota}</div>
                                                            <div className="text-xs text-purple-600/80 font-bold mt-1">Rev. Remota</div>
                                                        </div>
                                                        <div className="bg-amber-50 dark:bg-amber-900/40 rounded-lg p-4 text-center border border-amber-100">
                                                            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.proceso}</div>
                                                            <div className="text-xs text-amber-600/80 font-bold mt-1">En Gestión</div>
                                                        </div>
                                                        <div className="bg-emerald-50 dark:bg-emerald-900/40 rounded-lg p-4 text-center border border-emerald-100">
                                                            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.reparado}</div>
                                                            <div className="text-xs text-emerald-600/80 font-bold mt-1">Reparados</div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Trend Chart */}
                                                <div className="pt-6 border-t border-slate-100 dark:border-zinc-800">
                                                    <div className="flex justify-between items-center mb-4 px-2">
                                                        <h5 className="text-xs font-bold text-slate-400 dark:text-zinc-500 uppercase">
                                                            Tendencia de Fallas {generalSeverityFilter === 'all' ? '' : `- Severidad ${generalSeverityFilter}`}
                                                        </h5>
                                                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1.5 ${selectedTrackingDevice ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400'}`}>
                                                            {selectedTrackingDevice ? `${selectedTrackingDevice}: ` : 'Total: '}
                                                            {totalAlarmsCount} {generalSeverityFilter === 'all' ? 'Alarmas' : `Fallas ${generalSeverityFilter}`}
                                                            {selectedTrackingDevice && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setSelectedTrackingDevice(null)}
                                                                    className="ml-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded-full w-4 h-4 flex items-center justify-center text-blue-500 dark:text-blue-300 font-bold"
                                                                    title="Quitar selección de equipo"
                                                                    aria-label="Quitar selección de equipo"
                                                                >×</button>
                                                            )}
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
                                                                <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#18181b' : '#ffffff', borderColor: isDarkMode ? '#27272a' : '#e2e8f0' }} />
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
                                        data={(() => {
                                            let filtered = [...groupedData]
                                                .filter(d => d.totalAlerts > 0);

                                            // Aplicar filtro de nivel (igual que en el gráfico)
                                            if (generalSeverityFilter !== 'all') {
                                                filtered = filtered.filter(d => {
                                                    const hasMatchingLevel = scopedData.some(alarm =>
                                                        (alarm.DeviceName === d.equipment || (alarm.ID && alarm.ID === d.equipment)) && alarm.level === generalSeverityFilter
                                                    );
                                                    return hasMatchingLevel;
                                                });
                                            }

                                            // Aplicar filtro de tipo de disco (igual que en el gráfico)
                                            if (generalComponentFilter !== 'all') {
                                                filtered = filtered.filter(d => {
                                                    const matchesComponent =
                                                        generalComponentFilter === 'ssd' ? d.component === 'SSD/HDD' :
                                                            generalComponentFilter === 'sd' ? d.component === 'SD/Firebox' :
                                                                d.component === 'Otros';
                                                    return matchesComponent;
                                                });
                                            }

                                            return filtered.sort((a, b) => b.highSeverityCount - a.highSeverityCount);
                                        })()}
                                        repairData={repairData}
                                        onUpdateStatus={(id: string, status: any, alerts: number) => updateRepairStatus(id, status, 'General', alerts)}
                                        onUpdateWorkType={updateWorkType}
                                        onAddComment={addComment}
                                        selectedDevice={selectedTrackingDevice}
                                        onSelectDevice={setSelectedTrackingDevice}
                                        onViewDetails={setViewingDeviceDetails}
                                        showAll={true}
                                        statusFilter={generalStatusFilter}
                                        workTypeFilter={generalWorkTypeFilter}
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
                                        <span className="text-[10px] text-slate-400 dark:text-zinc-500">Listos para informe de supervisión</span>
                                    </div>

                                    <div className="h-8 w-px bg-slate-700 mx-2"></div>

                                    <button
                                        onClick={handleGeneratePDF}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 transition-transform active:scale-95 shadow-lg shadow-blue-500/30"
                                    >
                                        <FileText className="w-4 h-4" />
                                        Generar Informe PDF
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
                        equipment={(() => {
                            // Buscar el grupo correspondiente para mostrar placa + ID
                            const group = groupedData.find(g => g.equipment === viewingDeviceDetails);
                            return group ? group.allPlates[0] : viewingDeviceDetails;
                        })()}
                        id={viewingDeviceDetails}
                        fleet={data.find(d => (d.ID || d.DeviceName) === viewingDeviceDetails)?.Fleet || 'Desconocida'}
                        repairData={repairData[viewingDeviceDetails]}
                        alarms={data.filter(d => (d.ID || d.DeviceName) === viewingDeviceDetails)}
                        onAddComment={(text) => addComment(viewingDeviceDetails, text)}
                    />
                )}
            </main >

            {/* Modal de Login de Administrador */}
            {showLoginModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200 dark:border-zinc-800">
                        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center bg-slate-50 dark:bg-zinc-950">
                            <h3 className="font-bold text-lg text-slate-800 dark:text-zinc-100 flex items-center gap-2">
                                <Lock className="w-5 h-5 text-blue-600" />
                                Modo Administrador
                            </h3>
                            <button onClick={() => setShowLoginModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 transition-colors rounded-full p-1 hover:bg-slate-200 dark:hover:bg-zinc-800" title="Cerrar modal">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleLogin} className="p-6">
                            <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">
                                Ingresa la contraseña para habilitar las funciones de edición y subida de archivos de datos a la nube.
                            </p>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 dark:text-zinc-300 mb-1">
                                        Contraseña
                                    </label>
                                    <input
                                        type="password"
                                        value={loginPassword}
                                        onChange={(e) => setLoginPassword(e.target.value)}
                                        className="w-full px-4 py-2 bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-white transition-shadow"
                                        placeholder="••••••••"
                                        autoFocus
                                    />
                                </div>
                                {loginError && (
                                    <p className="text-xs text-red-500 font-medium bg-red-50 dark:bg-red-900/40 p-2 rounded-md">{loginError}</p>
                                )}
                            </div>
                            <div className="mt-6 flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setShowLoginModal(false)}
                                    className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                                >
                                    Cancelar
                                </button>
                                <button
                                    type="submit"
                                    disabled={!loginPassword}
                                    className="px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2 shadow-sm"
                                >
                                    <Unlock className="w-4 h-4" />
                                    Desbloquear
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            </>
            )}

            <SpeedInsights />
        </div >
    );
}
