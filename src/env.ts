export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/evensplit',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  seedDemo: process.env.SEED_DEMO !== 'false',
  baseUrl: (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
};
