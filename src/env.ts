export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/evensplit',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  seedDemo: process.env.SEED_DEMO !== 'false',
  // Public origin. Hosts that know their own URL hand it over, so a deploy
  // needs no manual configuration: Render sets RENDER_EXTERNAL_URL and Railway
  // sets RAILWAY_PUBLIC_DOMAIN. BASE_URL overrides both when set explicitly.
  baseUrl: (
    process.env.BASE_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined) ??
    'http://localhost:3000'
  ).replace(/\/$/, ''),
};
