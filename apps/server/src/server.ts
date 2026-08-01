import Fastify from 'fastify';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'ok' };
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`Server listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
