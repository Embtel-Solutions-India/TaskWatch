import fs from 'node:fs';
import path from 'node:path';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { csrfGuard, errorHandler, SESSION_COOKIE, SESSION_MAX_MS, sessionCookieOptions } from './http/middleware.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { notificationsRouter } from './routes/notifications.js';
import { peopleRouter } from './routes/people.js';
import { recurringRouter } from './routes/recurring.js';
import { performanceRouter } from './routes/performance.js';
import { pushRouter } from './routes/push.js';
import { rulesRouter } from './routes/rules.js';
import { attendanceRouter } from './routes/attendance.js';
import { scheduleRouter } from './routes/schedule.js';
import { tasksRouter } from './routes/tasks.js';

export function createApp(): express.Express {
  const app = express();
  if (config.isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Only ask browsers to upgrade to https when TaskWatch is actually served over https.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.appUrl.startsWith('https://') ? [] : null } },
    }),
  );
  app.use(express.json({ limit: '200kb' }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: SESSION_COOKIE,
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: config.isTest ? false : 900 }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { ...sessionCookieOptions(), maxAge: SESSION_MAX_MS },
    }),
  );

  const api = express.Router();
  api.use(csrfGuard);
  api.use(authRouter);
  api.use(tasksRouter);
  api.use(peopleRouter);
  api.use(rulesRouter);
  api.use(scheduleRouter);
  api.use(attendanceRouter); // ADR-0015
  api.use(notificationsRouter);
  api.use(pushRouter); // ADR-0012
  api.use(dashboardRouter);
  api.use(reportsRouter);
  api.use(recurringRouter);
  api.use(performanceRouter);
  api.use(adminRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  // In production the API also serves the built web app.
  const dist = path.resolve(config.serverRoot, '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
