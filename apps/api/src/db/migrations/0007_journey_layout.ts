import { sql, type Kysely } from 'kysely';

// Canvas positions for the visual journey builder: { "<step id>" | "__trigger": { x, y } }. Presentation only; the
// engine never reads it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('journeys').addColumn('layout', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`)).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('journeys').dropColumn('layout').execute();
}
