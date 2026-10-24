// Recreates the e2e database before the API starts (Playwright webServer command).
import pg from 'pg';

const url = new URL(process.env.PE_DATABASE_URL);
const name = url.pathname.slice(1);
if (!/_e2e$/.test(name)) throw new Error(`Refusing to reset "${name}": e2e database names must end in _e2e`);
url.pathname = '/postgres';
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
await client.query(`drop database if exists ${name} with (force)`);
await client.query(`create database ${name}`);
await client.end();
