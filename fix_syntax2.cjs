const fs = require('fs');
let txt = fs.readFileSync('src/TracklogDashboard.tsx', 'utf8');

const regex = /                if \(error\) \{\s*console\.error\("Batch insert error:", error\);\s*\};\s*\/\/ 1\. CARGA INTELIGENTE DE DATOS DESDE POSTGRES/m;

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

if (regex.test(txt)) {
    txt = txt.replace(regex, fixedBlock);
    fs.writeFileSync('src/TracklogDashboard.tsx', txt, 'utf8');
    console.log("Success");
} else {
    console.log("Failed. Here is a snippet around the target:");
    const idx = txt.indexOf('console.error("Batch insert error:');
    if (idx > 0) {
        console.log(txt.substring(idx - 100, idx + 200));
    }
}
