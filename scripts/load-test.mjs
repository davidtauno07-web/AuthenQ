// Load test for critical read/scan workflows against a running API with the seeded demo.
// Rate-limited responses (429) are reported separately: they are the limiter working, not failures.
// Usage: DEMO_PASSWORD=... node scripts/load-test.mjs [baseUrl] [concurrency] [requestsPerWorker]
const base = (process.argv[2] ?? 'http://localhost:4000') + '/api/v1';
const concurrency = Number(process.argv[3] ?? 20);
const perWorker = Number(process.argv[4] ?? 25);

async function login() {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@authenq.demo', password: process.env.DEMO_PASSWORD }) });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('aq_csrf=')).slice(8));
  return { cookie: cookies.join('; '), csrf };
}

const { cookie, csrf } = await login();
const projects = await (await fetch(`${base}/projects`, { headers: { cookie } })).json();
const pid = (Array.isArray(projects) ? projects : projects.items)[0].id;
const scenarios = [
  ['dashboard', () => fetch(`${base}/dashboard`, { headers: { cookie } })],
  ['tasks page', () => fetch(`${base}/projects/${pid}/tasks?limit=100`, { headers: { cookie } })],
  ['quality', () => fetch(`${base}/projects/${pid}/quality`, { headers: { cookie } })],
  ['canary scan', () => fetch(`${base}/canary/scan`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Load test text with jane@example.com and +1 555 0100 '.repeat(50), inputName: 'load-test' }) })],
];

for (const [name, fn] of scenarios) {
  const times = [];
  let errors = 0;
  let limited = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i = 0; i < perWorker; i++) {
      const s = performance.now();
      const r = await fn();
      await r.arrayBuffer();
      if (r.status === 429) limited++;
      else if (!r.ok) errors++;
      times.push(performance.now() - s);
    }
  }));
  const total = (performance.now() - t0) / 1000;
  times.sort((a, b) => a - b);
  const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(0);
  console.log(`${name.padEnd(12)} n=${times.length} errors=${errors} rateLimited=${limited} rps=${(times.length / total).toFixed(1)} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`);
}
