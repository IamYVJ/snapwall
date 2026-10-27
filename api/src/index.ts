import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth, me } from './auth';
import { events } from './events';
import { guest } from './guest';
import { media } from './media';
import { HttpError, now, type AppEnv, type Env } from './util';

const app = new Hono<AppEnv>();

app.use('*', (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'X-Admin-Token', 'X-Event-Pin'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Content-Disposition'],
    maxAge: 600,
  })(c, next);
});

app.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.res.headers.get('Content-Type')?.includes('application/json')) c.header('Cache-Control', 'no-store');
});

app.get('/', (c) => c.json({ name: 'snapwall-api', ok: true }));
app.route('/auth', auth);
app.route('/me', me);
app.route('/events', events);
app.route('/g', guest);
app.route('/m', media);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: 'server_error', message: 'Something went wrong' }, 500);
});

export default {
  fetch: app.fetch,
  /** Daily cleanup of expired sessions and uploads that were started but never finished. */
  async scheduled(_event: ScheduledController, env: Env) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
      env.DB.prepare(`DELETE FROM uploads WHERE status = 'pending' AND created_at < ?`).bind(now() - 2 * 86400),
    ]);
  },
} satisfies ExportedHandler<Env>;
