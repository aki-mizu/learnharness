/**
 * Exercise the final Docker image through the Portainer Compose file. Uses a
 * unique project/volume, a random loopback port, and a dummy key that is never
 * sent to a provider. Recreates the container to verify durable storage.
 *
 * docker build -t learnharness:local . && node scripts/smoke-docker.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const project = `lh-docker-smoke-${randomUUID()}`;
const env = {
	...process.env,
	BIND_IP: "127.0.0.1", HOST_PORT: "0",
	LEARNHARNESS_IMAGE: "learnharness:local", LEARNHARNESS_PULL_POLICY: "never",
};

function compose(args, input) {
	const result = spawnSync("docker", ["compose", "--file", path.join(ROOT, "compose.yaml"), "--project-name", project, ...args], {
		cwd: ROOT, env, input, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0 || result.error) {
		throw new Error(`docker compose ${args.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
	return result.stdout.trim();
}

const common = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
const title = 'Docker persistence smoke';
const dummyKey = 'docker-smoke-not-a-real-provider-key';
async function request(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:3000' + route, {
    method, signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, method + ' ' + route);
  return response;
}
assert.notEqual(process.getuid(), 0, 'server must run as a non-root user');
`;

function probe(code) {
	console.log(compose(["exec", "-T", "learnharness", "node", "--input-type=module"], common + code));
}

try {
	compose(["up", "--detach", "--wait", "--wait-timeout", "90"]);
	const address = compose(["port", "learnharness", "3000"]);
	const response = await fetch(`http://${address}/api/graph`, { signal: AbortSignal.timeout(10000) });
	assert.equal(response.status, 200, "API reachable through the published port");
	await response.arrayBuffer();

	probe(String.raw`
const html = await (await request('/')).text();
const asset = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).find(url => url.startsWith('/_next/static/'));
assert.ok(asset, 'page references a bundled static asset');
await (await request(asset)).arrayBuffer();
await (await request('/api/models')).arrayBuffer();
await (await request('/api/graph')).arrayBuffer();
const chat = await (await request('/api/chats', 'POST', {title})).json();
assert.ok(chat.id);
const stream = await request('/api/chats/' + chat.id + '/stream');
assert.match(stream.headers.get('Content-Type'), /text\/event-stream/);
assert.match(await stream.text(), /\[DONE\]/);
await (await request('/api/settings/graph', 'PUT', {enabled: false})).arrayBuffer();
await (await request('/api/keys/OPENAI_API_KEY', 'PUT', {value: dummyKey})).arrayBuffer();
assert.equal(JSON.parse(fs.readFileSync('/state/auth.json', 'utf8')).OPENAI_API_KEY, dummyKey);
assert.equal(fs.statSync('/state/auth.json').mode & 0o777, 0o600, 'key file permissions');
console.log('[smoke-docker] non-root startup, static assets, APIs, SSE and writes passed');
`);

	const pdf = readFileSync(path.join(ROOT, "tests/fixtures/sample-3page.pdf")).toString("base64");
	probe(String.raw`
const { createCanvas } = await import('@napi-rs/canvas');
const { Resvg } = await import('@resvg/resvg-js');
const svg = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>').render().asPng();
assert.equal(svg.readUInt32BE(16), 32);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const loading = pdfjs.getDocument({
  data: new Uint8Array(Buffer.from(${JSON.stringify(pdf)}, 'base64')),
  standardFontDataUrl: '/app/node_modules/pdfjs-dist/standard_fonts/', verbosity: 0,
});
try {
  const doc = await loading.promise;
  assert.equal(doc.numPages, 3);
  const page = await doc.getPage(1);
  const viewport = page.getViewport({scale: 1});
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
  assert.ok(canvas.toBuffer('image/png').length > 100);
} finally { await loading.destroy(); }
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH, headless: true,
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setContent('<body><script>document.body.dataset.answer = 6 * 7</script></body>');
  assert.equal(await page.evaluate(() => document.body.dataset.answer), '42');
} finally { await browser.close(); }
console.log('[smoke-docker] native SVG/PDF rendering and Chromium execution passed');
`);

	// Keep the named volume, replace the container, and check through the API.
	compose(["down", "--timeout", "10"]);
	compose(["up", "--detach", "--wait", "--wait-timeout", "90"]);
	probe(String.raw`
const chats = await (await request('/api/chats')).json();
const chat = chats.chats.find(c => c.title === title);
assert.ok(chat, 'session survives container replacement');
await (await request('/api/chats/' + chat.id)).arrayBuffer();
const { settings } = await (await request('/api/settings')).json();
assert.equal(settings.graph.enabled, false, 'settings survive container replacement');
assert.equal(JSON.parse(fs.readFileSync('/state/auth.json', 'utf8')).OPENAI_API_KEY, dummyKey, 'saved key survives container replacement');
console.log('[smoke-docker] sessions, settings and keys survived container replacement');
`);
	console.log("[smoke-docker] passed; no model or provider requests made");
} catch (error) {
	try { console.error(compose(["logs", "--no-color", "--tail", "80"])); } catch { /* original error wins */ }
	console.error(`[smoke-docker] FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	try { compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"]); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
