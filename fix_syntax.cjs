const fs = require('fs');
const file = 'src/TracklogDashboard.tsx';
let txt = fs.readFileSync(file, 'utf8');

const anchor1 = `                if (error) {
                    console.error("Batch insert error:", error);
    };

    // 1. CARGA INTELIGENTE DE DATOS DESDE POSTGRES`;

const fixedBlock = `                if (error) {
                    console.error("Batch insert error:", error);
                    throw error;
                }
                totalInserted += batch.length;
                await new Promise(r => setTimeout(r, 10)); // Yield repintado DOM
            }

            // Actualizar last_updated global
            await supabase.from('system_metadata').upsert({ id: 1, last_updated: new Date().toISOString() });

            // Solicitar a Supabase que recalcule las Vistas Materializadas para que el Dashboard lea lo más reciente de inmediato
            try {
                await supabase.rpc('refresh_dashboard_views');
            } catch(rpcErr) {
                console.warn("No se pudo refrescar vistas materializadas (tal vez aún no existan):", rpcErr);
            }

            alert(\`¡Carga Incremental Procesada!\\nSe pasaron \${totalInserted} registros estructurados directamente a la Base de Datos PostgreSQL.\\nDuplicados omitidos automáticamente.\`);
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

    // 1. CARGA INTELIGENTE DE DATOS DESDE POSTGRES`;

if (txt.includes(anchor1)) {
    txt = txt.replace(anchor1, fixedBlock);
    fs.writeFileSync(file, txt, 'utf8');
    console.log("Successfully injected missing try/catch payload.");
} else {
    console.log("Anchor block not found! Injection failed.");
}
