import { pool, query } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await query('TRUNCATE groups, members, expenses, expense_shares, settlements CASCADE');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
