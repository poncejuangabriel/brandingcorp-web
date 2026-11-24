// Carga una tanda de vales en la base de datos D1.
//
//   node scripts/cargar-vales.js <campaña> <archivo.csv> [--remote]
//
// El CSV lleva cabecera "codigo,producto"; producto es el id de g/<campaña>/config.json.
// Sin --remote carga en la base de datos local de pruebas (wrangler dev).
// Los códigos que ya existen no se tocan (INSERT OR IGNORE): se puede volver a lanzar sin
// riesgo de "resucitar" vales ya usados.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const [campana, csvPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const remote = process.argv.includes('--remote');
if (!campana || !csvPath || !/^[a-z0-9-]+$/.test(campana)) {
  console.error('Uso: node scripts/cargar-vales.js <campaña> <archivo.csv> [--remote]');
  process.exit(1);
}

const workerDir = path.join(__dirname, '..');
const configPath = path.join(workerDir, '..', 'g', campana, 'config.json');
const productos = new Set(JSON.parse(fs.readFileSync(configPath, 'utf8')).products.map(p => p.id));

const normalizar = c => c.toUpperCase().replace(/[\s-]/g, '');
const sqlStr = s => "'" + s.replace(/'/g, "''") + "'";

const filas = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
if (/^codigo\s*,/i.test(filas[0])) filas.shift();

const vistos = new Set();
const inserts = filas.map((linea, i) => {
  const [visible, producto] = linea.split(',').map(s => s.trim());
  const codigo = normalizar(visible || '');
  if (!/^[A-Z0-9]{4,32}$/.test(codigo)) throw new Error(`Línea ${i + 1}: código no válido «${visible}»`);
  if (!productos.has(producto)) throw new Error(`Línea ${i + 1}: el producto «${producto}» no existe en ${configPath}`);
  if (vistos.has(codigo)) throw new Error(`Línea ${i + 1}: código repetido «${visible}»`);
  vistos.add(codigo);
  return `INSERT OR IGNORE INTO vales (codigo, visible, campana, producto, creado_at) VALUES (${sqlStr(codigo)}, ${sqlStr(visible.toUpperCase())}, ${sqlStr(campana)}, ${sqlStr(producto)}, ${Date.now()});`;
});

const tmp = path.join(os.tmpdir(), `vales-${campana}-${Date.now()}.sql`);
fs.writeFileSync(tmp, inserts.join('\n') + '\n');
try {
  const where = remote ? '--remote' : '--local';
  execSync(`npx wrangler d1 execute brandingcorp-vales ${where} --file="${tmp}" --yes`, { cwd: workerDir, stdio: 'inherit' });
  console.log(`\n${inserts.length} vales de «${campana}» procesados (${remote ? 'PRODUCCIÓN' : 'local'}).`);
} finally {
  fs.unlinkSync(tmp);
}
