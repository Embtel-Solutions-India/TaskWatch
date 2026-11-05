import { createApp } from './app.js';
import * as clock from './clock.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startScheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  const applied = await migrate();
  if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

  if (config.demoTools) {
    const { rows } = await pool.query(`select value from app_state where key = 'clock_offset_ms'`);
    if (rows[0]) clock.setOffsetMs(Number(rows[0].value));
  }

  const app = createApp();
  startScheduler();
  app.listen(config.port, () => {
    const on = (b: boolean) => (b ? 'live' : 'simulated (no keys in .env)');
    console.log(`TaskWatch API listening on http://localhost:${config.port}`);
    console.log(`  Google sign-in: ${config.google.enabled ? 'on' : 'off'}${config.devLogin ? ' · directory sign-in (dev) on' : ''}`);
    console.log(`  WhatsApp: ${on(config.whatsapp.enabled)} · Email: ${on(config.smtp.enabled)}`);
    if (clock.getOffsetMs()) console.log(`  Simulated clock: +${clock.getOffsetMs() / 3_600_000} h`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
