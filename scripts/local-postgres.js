const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

async function start() {
  const dataDir = path.join(__dirname, '..', '.local-pglite');
  const port = Number(process.env.PGPORT || 55432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PGPORT must be a valid TCP port.');
  const db = await PGlite.create(dataDir);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 5 });
  await server.start();
  console.log(`Local PostgreSQL-compatible database listening on 127.0.0.1:${port}`);
  console.log(`Persistent local database files are in ${dataDir}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.stop();
    await db.close();
  };
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
}

start().catch((error) => {
  console.error(`Local database startup failed: ${error.message}`);
  process.exit(1);
});
