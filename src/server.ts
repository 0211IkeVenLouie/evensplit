import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { pool } from './db.js';
import { env } from './env.js';
import { AppError, httpStatusFor } from './errors.js';
import {
  addMember,
  createExpense,
  createGroup,
  deleteExpense,
  deleteSettlement,
  getDemoGroup,
  getGroupBySlug,
  loadLedger,
  recordSettlement,
  removeMember,
  type Group,
  type SplitMode,
} from './groups.js';
import { migrate } from './migrate.js';
import { MoneyError, formatAmount, formatMoney, parseMoney } from './money.js';
import { seedDemoGroup } from './seed.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Load the group named in the URL, or 404 — every group route needs this. */
async function requireGroup(req: express.Request, res: express.Response): Promise<Group | undefined> {
  const group = await getGroupBySlug(String(req.params.slug));
  if (!group) {
    res.status(404).render('not-found', { message: 'No group at that link.' });
    return undefined;
  }
  return group;
}

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.locals.formatMoney = formatMoney;
  app.locals.formatAmount = formatAmount;

  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(rootDir, 'public'), { maxAge: '1h' }));

  app.get('/healthz', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.get('/', asyncRoute(async (_req, res) => {
    const demo = await getDemoGroup();
    res.render('index', { demoSlug: demo?.slug ?? null });
  }));

  app.get('/demo', asyncRoute(async (_req, res) => {
    const demo = (await getDemoGroup()) ?? (await seedDemoGroup());
    res.redirect(`/g/${demo.slug}`);
  }));

  app.post('/groups', asyncRoute(async (req, res) => {
    const memberNames = String(req.body?.members ?? '')
      .split(/[\n,]/)
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 30);
    const group = await createGroup({
      name: String(req.body?.name ?? ''),
      currency: String(req.body?.currency ?? 'USD'),
      memberNames,
    });
    res.redirect(`/g/${group.slug}`);
  }));

  /* ------------------------------------------------------------ the group */

  app.get('/g/:slug', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    const ledger = await loadLedger(group);
    res.render('group', {
      group,
      ledger,
      nameOf: nameLookup(ledger.members),
      baseUrl: env.baseUrl,
      error: null,
    });
  }));

  app.post('/g/:slug/members', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    await addMember(group.id, String(req.body?.name ?? ''));
    res.redirect(`/g/${group.slug}`);
  }));

  app.post('/g/:slug/members/:memberId/delete', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    await removeMember(group.id, String(req.params.memberId));
    res.redirect(`/g/${group.slug}`);
  }));

  app.get('/g/:slug/expenses/new', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    const ledger = await loadLedger(group);
    res.render('add-expense', { group, ledger, error: null, values: {} });
  }));

  app.post('/g/:slug/expenses', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    const ledger = await loadLedger(group);
    const body = req.body ?? {};

    const mode = (['equal', 'shares', 'percent', 'exact'].includes(String(body.mode))
      ? String(body.mode)
      : 'equal') as SplitMode;
    const memberIds = ([] as string[])
      .concat(body.participants ?? [])
      .filter((id) => ledger.members.some((member) => member.id === id));

    const values =
      mode === 'equal'
        ? undefined
        : memberIds.map((id) => {
            const raw = String(body[`value_${id}`] ?? '').trim();
            if (mode === 'exact') return raw ? parseMoney(raw) : 0;
            return raw ? Number(raw) : 0;
          });

    const rerender = (message: string) =>
      res.status(400).render('add-expense', {
        group,
        ledger,
        error: message,
        values: {
          description: String(body.description ?? ''),
          amount: String(body.amount ?? ''),
          paidBy: String(body.paidBy ?? ''),
          mode,
          participants: memberIds,
          raw: body as Record<string, string>,
        },
      });

    try {
      const amountCents = parseMoney(String(body.amount ?? ''));
      await createExpense({
        group,
        description: String(body.description ?? ''),
        amountCents,
        paidByMemberId: String(body.paidBy ?? ''),
        spentOn: String(body.spentOn ?? '') || undefined,
        split: { mode, memberIds, values },
      });
      res.redirect(`/g/${group.slug}`);
    } catch (error) {
      if (error instanceof MoneyError || error instanceof AppError) return rerender(error.message);
      throw error;
    }
  }));

  app.post('/g/:slug/expenses/:expenseId/delete', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    await deleteExpense(group.id, String(req.params.expenseId));
    res.redirect(`/g/${group.slug}`);
  }));

  app.get('/g/:slug/balances', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    const ledger = await loadLedger(group);
    res.render('balances', { group, ledger, nameOf: nameLookup(ledger.members), error: null });
  }));

  app.post('/g/:slug/settlements', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    const body = req.body ?? {};
    try {
      await recordSettlement({
        group,
        fromMemberId: String(body.fromMemberId ?? ''),
        toMemberId: String(body.toMemberId ?? ''),
        amountCents: parseMoney(String(body.amount ?? '')),
        note: String(body.note ?? ''),
      });
      res.redirect(`/g/${group.slug}/balances`);
    } catch (error) {
      if (error instanceof MoneyError || error instanceof AppError) {
        const ledger = await loadLedger(group);
        res.status(400).render('balances', {
          group,
          ledger,
          nameOf: nameLookup(ledger.members),
          error: error.message,
        });
        return;
      }
      throw error;
    }
  }));

  app.post('/g/:slug/settlements/:settlementId/delete', asyncRoute(async (req, res) => {
    const group = await requireGroup(req, res);
    if (!group) return;
    await deleteSettlement(group.id, String(req.params.settlementId));
    res.redirect(`/g/${group.slug}/balances`);
  }));

  app.use((_req, res) => res.status(404).render('not-found', { message: 'That page does not exist.' }));

  app.use(((error, _req, res, _next) => {
    if (error instanceof AppError) {
      res.status(httpStatusFor[error.code]).render('not-found', { message: error.message });
      return;
    }
    console.error(error);
    res.status(500).render('not-found', { message: 'Something went wrong on our side.' });
  }) as express.ErrorRequestHandler);

  return app;
}

function nameLookup(members: Array<{ id: string; name: string }>): (id: string) => string {
  const byId = new Map(members.map((member) => [member.id, member.name]));
  return (id: string) => byId.get(id) ?? 'Someone';
}

export async function start(): Promise<void> {
  const applied = await migrate();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (env.seedDemo) await seedDemoGroup();

  const server = createServer(createApp());
  server.listen(env.port, () => console.log(`evensplit listening on http://localhost:${env.port}`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
