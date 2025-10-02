import request from 'supertest';
import { createApp } from '../app.js';

let server;
beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
});

afterAll(async () => {
  if (server && server.close) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /ready returns 200 or 503 depending on readiness', async () => {
  const res = await request(server).get('/ready');
  expect([200, 503]).toContain(res.status);
});
