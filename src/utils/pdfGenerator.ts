
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Definimos la interfaz aquí para no depender circularmente, o podemos importarla si la exportamos en el otro lado.
// Por simplicidad, re-definimos la forma básica que esperamos.
interface DeviceGroup {
    equipment: string;
    fleet: string;
    model: string;
    pv: string;
    maxSeverity: 'Alta' | 'Media' | 'Baja';
    worstDiagnosis: string;
    suggestedAction: string;
    component: string;
    diskType: string;
}

export const generateWorkOrderPDF = (selectedItems: DeviceGroup[]) => {
    const doc = new jsPDF();

    // --- ENCABEZADO ---
    doc.setFontSize(18);
    doc.setTextColor(40, 40, 40);
    doc.text("ORDEN DE SERVICIO TÉCNICO - MDVR", 105, 15, { align: 'center' });

    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Fecha de Emisión: ${new Date().toLocaleString()}`, 105, 22, { align: 'center' });

    // Línea separadora
    doc.setDrawColor(200, 200, 200);
    doc.line(14, 25, 196, 25);

    // --- CONTEXTO ---
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(`Equipos Reportados: ${selectedItems.length}`, 14, 32);

    // --- TABLA DE EQUIPOS ---
    const tableColumn = ["Vehículo / Placa", "Ubicación / Flota", "Falla Detectada / Diagnóstico", "ACCIÓN REQUERIDA"];
    const tableRows: any[] = [];

    selectedItems.forEach(item => {
        const itemData = [
            item.equipment + "\n" + (item.model || ''),
            item.fleet,
            item.worstDiagnosis,
            item.suggestedAction + "\n(" + item.component + ")"
        ];
        tableRows.push(itemData);
    });

    autoTable(doc, {
        head: [tableColumn],
        body: tableRows,
        startY: 35,
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: 'bold' },
        columnStyles: {
            0: { cellWidth: 35, fontStyle: 'bold' }, // Vehículo
            1: { cellWidth: 30 }, // Flota
            2: { cellWidth: 60 }, // Falla
            3: { cellWidth: 'auto', fontStyle: 'bold', textColor: [200, 0, 0] } // Acción (rojo para resaltar)
        },
        margin: { top: 35 }
    });

    // --- PIE DE PÁGINA (FIRMAS) ---
    // Calculamos posición final de la tabla
    const finalY = (doc as any).lastAutoTable.finalY || 150;

    // Si la tabla es muy larga y queda poco espacio, agregamos nueva página
    let signatureY = finalY + 40;
    if (signatureY > 270) {
        doc.addPage();
        signatureY = 40;
    }

    // Líneas de firma
    //* doc.setDrawColor(0, 0, 0);
    //* doc.line(30, signatureY, 90, signatureY); // Firma 1
    //* doc.line(120, signatureY, 180, signatureY); // Firma 2

    //* doc.setFontSize(10);
    //* doc.setTextColor(0, 0, 0);
    //* doc.text("Firma Técnico Responsable", 60, signatureY + 5, { align: 'center' });
    //* doc.text("Conformidad / V°B° Supervisor", 150, signatureY + 5, { align: 'center' });

    // Guardar
    doc.save(`Orden_Trabajo_MDVR_${new Date().toISOString().slice(0, 10)}.pdf`);
};
