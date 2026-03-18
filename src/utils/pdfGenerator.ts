
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Interfaces necesarias para el generador de PDF
interface Comment {
    id: string;
    text: string;
    author: string;
    timestamp: string;
    type: 'user' | 'system';
}

interface RepairTracking {
    deviceId: string;
    status: 'Pendiente' | 'Revisión Remota' | 'En Proceso' | 'Validando' | 'Reparado';
    comments: Comment[];
    priority: 'Baja' | 'Media' | 'Alta' | 'Crítica';
    lastModifiedDate: string;
    createdDate: string;
    [key: string]: any;
}

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

export const generateWorkOrderPDF = (
    selectedItems: DeviceGroup[],
    repairData: Record<string, RepairTracking> = {}
) => {
    const doc = new jsPDF({ orientation: 'landscape' });
    const pageWidth = doc.internal.pageSize.getWidth();

    // --- ENCABEZADO ---
    doc.setFontSize(16);
    doc.setTextColor(40, 40, 40);
    doc.text("INFORME DE SUPERVISIÓN MDVR", pageWidth / 2, 15, { align: 'center' });

    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text(`Fecha de Emisión: ${new Date().toLocaleString()}`, pageWidth / 2, 21, { align: 'center' });

    // Línea separadora
    doc.setDrawColor(200, 200, 200);
    doc.line(14, 24, pageWidth - 14, 24);

    // --- RESUMEN ---
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);

    // Contar por estado
    const statusCounts: Record<string, number> = {};
    selectedItems.forEach(item => {
        const status = repairData[item.equipment]?.status || 'Pendiente';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const statusSummary = Object.entries(statusCounts)
        .map(([status, count]) => `${status}: ${count}`)
        .join('  |  ');

    doc.text(`Equipos Reportados: ${selectedItems.length}     ${statusSummary}`, 14, 30);

    // --- TABLA DE EQUIPOS ---
    const tableColumn = [
        "#",
        "Equipo / ID",
        "Flota",
        "Alertas",
        "Estado",
        "Diagnóstico / Acción",
        "Observación (Último Comentario)"
    ];

    const tableRows: any[] = [];

    selectedItems.forEach((item, index) => {
        const tracking = repairData[item.equipment];
        const status = tracking?.status || 'Pendiente';

        // Obtener último comentario del usuario (no de sistema)
        let lastUserComment = '—';
        if (tracking?.comments && tracking.comments.length > 0) {
            const userComments = tracking.comments.filter(c => c.type === 'user');
            if (userComments.length > 0) {
                const last = userComments[userComments.length - 1];
                const date = new Date(last.timestamp).toLocaleDateString();
                lastUserComment = `${last.text}\n(${last.author} - ${date})`;
            }
        }

        // ID del dispositivo
        const deviceId = item.id || '—';

        const itemData = [
            (index + 1).toString(),
            `${item.equipment}\nID: ${deviceId}\n${item.model || ''}`,
            item.fleet,
            `${item.highSeverityCount} L1\n${item.totalAlerts} Total`,
            status,
            `${item.worstDiagnosis}\n\nAcción: ${item.suggestedAction}\n(${item.component})`,
            lastUserComment
        ];
        tableRows.push(itemData);
    });

    autoTable(doc, {
        head: [tableColumn],
        body: tableRows,
        startY: 34,
        theme: 'grid',
        styles: {
            fontSize: 8,
            cellPadding: 2.5,
            overflow: 'linebreak'
        },
        headStyles: {
            fillColor: [41, 128, 185],
            textColor: 255,
            fontStyle: 'bold',
            fontSize: 8,
            halign: 'center'
        },
        columnStyles: {
            0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },       // #
            1: { cellWidth: 42, fontStyle: 'bold' },                          // Equipo / ID
            2: { cellWidth: 28 },                                              // Flota
            3: { cellWidth: 22, halign: 'center' },                           // Alertas
            4: { cellWidth: 24, halign: 'center', fontStyle: 'bold' },        // Estado
            5: { cellWidth: 75 },                                              // Diagnóstico
            6: { cellWidth: 'auto', fontStyle: 'italic', textColor: [80, 80, 80] }  // Observación
        },
        didParseCell: function (data: any) {
            // Colorear la celda de Estado según el valor
            if (data.column.index === 4 && data.section === 'body') {
                const status = data.cell.raw as string;
                switch (status) {
                    case 'Reparado':
                        data.cell.styles.textColor = [16, 185, 129];
                        break;
                    case 'En Proceso':
                        data.cell.styles.textColor = [245, 158, 11];
                        break;
                    case 'Validando':
                        data.cell.styles.textColor = [59, 130, 246];
                        break;
                    case 'Revisión Remota':
                        data.cell.styles.textColor = [168, 85, 247];
                        break;
                    case 'Pendiente':
                        data.cell.styles.textColor = [148, 163, 184];
                        break;
                }
            }
            // Colorear alertas L1 en rojo
            if (data.column.index === 3 && data.section === 'body') {
                data.cell.styles.textColor = [200, 0, 0];
            }
        },
        margin: { top: 34, left: 14, right: 14 }
    });

    // --- PIE DE PÁGINA ---
    const finalY = (doc as any).lastAutoTable.finalY || 150;

    let footerY = finalY + 20;
    if (footerY > 190) {
        doc.addPage();
        footerY = 30;
    }

    // Nota
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text("Documento generado automáticamente por Tracklog Disk Manager. Los comentarios reflejan la última observación registrada por el usuario.", 14, footerY);



    // Guardar con descarga explícita (compatible con Chrome)
    const fileName = `Informe_MDVR_${new Date().toISOString().slice(0, 10)}.pdf`;
    const pdfDataUri = doc.output('datauristring', { filename: fileName });
    const link = document.createElement('a');
    link.href = pdfDataUri;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};
