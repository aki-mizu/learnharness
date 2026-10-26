/** Exercise the multiuser Compose stack without calling any model provider.
 * Uses a unique project and removes only its own temporary volumes/files.
 * Run after building learnharness:local and running smoke-docker.mjs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const project = `lh-multiuser-smoke-${randomUUID()}`;
const temporary = mkdtempSync(path.join(os.tmpdir(), "lh-multiuser-smoke-"));
const override = path.join(temporary, "web-selection.yaml");
const secrets = [];
function newKey() {
	const key = randomBytes(32).toString("hex");
	secrets.push(key);
	return key;
}
const env = {
	...process.env,
	BIND_IP: "127.0.0.1", HOST_PORT: "0",
	API_BIND_IP: "127.0.0.1", API_PORT: "0",
	LH_SERVER_API_KEY: newKey(), LH_SECONDARY_API_KEY: newKey(),
	LEARNHARNESS_IMAGE: "learnharness:local", LEARNHARNESS_PULL_POLICY: "never",
};
let selectedKey;
let webOrigin;
let apiOrigin;
const users = [
	{ id: "primary", key: env.LH_SERVER_API_KEY, title: "Primary private session", enabled: false, providerKey: "multiuser-dummy-provider-primary-1111" },
	{ id: "secondary", key: env.LH_SECONDARY_API_KEY, title: "Secondary private session", enabled: true, providerKey: "multiuser-dummy-provider-secondary-2222" },
];
secrets.push(...users.map((user) => user.providerKey));

function redact(value) {
	let result = String(value);
	for (const secret of secrets) result = result.split(secret).join("[redacted]");
	return result;
}

function command(args, input) {
	const result = spawnSync("docker", args, {
		cwd: ROOT, env, input, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0 || result.error) {
		throw new Error(redact(`docker ${args.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`));
	}
	return result.stdout.trim();
}

function compose(args, input) {
	return command([
		"compose", "--file", path.join(ROOT, "compose.multiuser.yaml"),
		...(selectedKey ? ["--file", override] : []), "--project-name", project, ...args,
	], input);
}

function legacyCompose(args) {
	return command(["compose", "--file", path.join(ROOT, "compose.yaml"), "--project-name", project, ...args]);
}

function selectWebUser(key) {
	selectedKey = key;
	writeFileSync(override, `services:\n  gateway:\n    environment:\n      LH_WEB_API_KEY: ${JSON.stringify(key)}\n`, { mode: 0o600 });
}

function refreshOrigins() {
	webOrigin = `http://${compose(["port", "gateway", "8080"])}`;
	apiOrigin = `http://${compose(["port", "gateway", "8081"])}`;
}

function probe(service, code) {
	const output = compose(["exec", "-T", service, "node", "--input-type=module"], code);
	if (output) console.log(redact(output));
}

async function request(origin, route, { key, method = "GET", body, headers = {}, status = 200 } = {}) {
	const response = await fetch(`${origin}${route}`, {
		method, redirect: "manual", signal: AbortSignal.timeout(15_000),
		headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	assert.equal(response.status, status, `${method} ${route}`);
	return response;
}

async function json(origin, route, options) {
	return (await request(origin, route, options)).json();
}

async function assertState(user) {
	const api = (route, options = {}) => json(apiOrigin, route, { key: user.key, ...options });
	const chats = (await api("/api/chats")).chats;
	assert.deepEqual(chats.map((chat) => chat.id), [user.chat.id], `${user.id} session list`);
	const record = await api(`/api/chats/${user.chat.id}`);
	assert.equal(record.messages[0].content, `${user.id} private history`);
	assert.equal((await api("/api/settings")).settings.graph.enabled, user.enabled);
	assert.equal((await api("/api/keys")).keys.find((key) => key.id === "OPENAI_API_KEY").masked.includes(user.providerKey.slice(-4)), true);
	assert.deepEqual((await api("/api/graph")).nodes.map((node) => node.id), [`n_smoke_${user.id}`]);
	assert.deepEqual((await api(`/api/jobs?chatId=${user.chat.id}`)).jobs.map((job) => job.id), [`job_smoke_${user.id}`]);
	for (const other of users.filter((candidate) => candidate !== user)) {
		for (const method of ["GET", "PUT", "DELETE"]) {
			const response = await request(apiOrigin, `/api/chats/${other.chat.id}?mode=preserve-graph`, {
				key: user.key, method, status: 404, ...(method === "PUT" ? { body: { title: "must not change another user" } } : {}),
			});
			await response.arrayBuffer();
		}
		await (await request(apiOrigin, `/api/chats/${other.chat.id}/stream`, { key: user.key, status: 404 })).arrayBuffer();
		assert.deepEqual((await api(`/api/jobs?chatId=${other.chat.id}`)).jobs, []);
	}
	const stream = await request(apiOrigin, `/api/chats/${user.chat.id}/stream`, { key: user.key });
	assert.match(stream.headers.get("content-type"), /text\/event-stream/);
	assert.match(await stream.text(), /\[DONE\]/);
}

try {
	// Start from the supported single-user deployment, retaining its volume
	// when switching files under the same Compose project/Portainer stack.
	legacyCompose(["up", "--detach", "--wait", "--wait-timeout", "120"]);
	const legacyOrigin = `http://${legacyCompose(["port", "learnharness", "8081"])}`;
	users[0].chat = await json(legacyOrigin, "/api/chats", {
		key: users[0].key, method: "POST", body: { title: users[0].title },
	});
	legacyCompose(["down", "--timeout", "10"]);
	compose(["up", "--detach", "--wait", "--wait-timeout", "120"]);
	assert.equal(compose(["ps", "--all", "--quiet"]).split(/\r?\n/).filter(Boolean).length, 3);
	refreshOrigins();
	const inspections = JSON.parse(command(["inspect", ...compose(["ps", "--all", "--quiet"]).split(/\r?\n/)]));
	const mountByService = new Map(inspections.map((container) => [container.Config.Labels["com.docker.compose.service"], container.Mounts]));
	assert.equal(mountByService.get("gateway").some((mount) => mount.Destination === "/state"), false);
	const stateMount = (service) => mountByService.get(service).find((mount) => mount.Destination === "/state");
	assert.ok(stateMount("primary"));
	assert.ok(stateMount("secondary"));
	assert.notEqual(stateMount("primary").Name, stateMount("secondary").Name, "users have distinct state volumes");
	for (const container of inspections.filter((entry) => entry.Config.Labels["com.docker.compose.service"] !== "gateway")) {
		assert.equal(Object.values(container.HostConfig.PortBindings ?? {}).some((bindings) => bindings?.length), false, "workers have no published host ports");
	}
	for (const user of users) {
		const initialChats = (await json(apiOrigin, "/api/chats", { key: user.key })).chats;
		assert.deepEqual(initialChats.map((chat) => chat.id), user.chat ? [user.chat.id] : [], "only primary inherits the legacy state volume");
		assert.deepEqual((await json(apiOrigin, "/api/graph", { key: user.key })).nodes, []);
		assert.equal((await json(apiOrigin, "/api/settings", { key: user.key })).settings, null);
		user.chat ??= await json(apiOrigin, "/api/chats", { key: user.key, method: "POST", body: { title: user.title } });
		await (await request(apiOrigin, "/api/settings/graph", { key: user.key, method: "PUT", body: { enabled: user.enabled } })).arrayBuffer();
		await (await request(apiOrigin, "/api/keys/OPENAI_API_KEY", { key: user.key, method: "PUT", body: { value: user.providerKey } })).arrayBuffer();
		// Seed history, graph, and terminal jobs without dispatching paid work.
		probe(user.id, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
const user = ${JSON.stringify({ id: user.id, chatId: user.chat.id })};
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.LH_SERVER_USERS, undefined, 'worker cannot see the routing map');
assert.equal(process.env.LH_WEB_API_KEY, undefined, 'worker cannot see the web selection');
assert.equal(process.env.LH_SECONDARY_API_KEY, undefined, 'worker receives only its own normalized key');
assert.equal(fs.statSync('/state/auth.json').mode & 0o777, 0o600);
const chatFile = '/state/data/chats/' + user.chatId + '.json';
const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
chat.messages = [{id: 'smoke_history_' + user.id, role: 'user', content: user.id + ' private history', timestamp: Date.now()}];
fs.writeFileSync(chatFile, JSON.stringify(chat));
const createdAt = new Date().toISOString();
fs.mkdirSync('/state/data/graph', {recursive: true});
fs.writeFileSync('/state/data/graph/nodes.jsonl', JSON.stringify({
  id: 'n_smoke_' + user.id, name: user.id, statement: user.id + ' private proposition', aliases: [], createdAt, provenance: [],
}) + String.fromCharCode(10));
fs.mkdirSync('/state/data/jobs', {recursive: true});
fs.writeFileSync('/state/data/jobs/job_smoke_' + user.id + '.json', JSON.stringify({
  id: 'job_smoke_' + user.id, chatId: user.chatId, toolCallId: 'smoke_' + user.id,
  kind: 'research', status: 'done', activity: 'offline smoke completed', createdAt, updatedAt: createdAt,
}));
`);
	}
	for (const user of users) await assertState(user);
	for (const key of [undefined, "incorrect-key"]) await (await request(apiOrigin, "/api/chats", { key, status: 401 })).arrayBuffer();
	for (const route of ["/", "/chat/new", "/_next/static/test.js"]) await (await request(apiOrigin, route, { key: users[0].key, status: 404 })).arrayBuffer();
	assert.match(await (await request(webOrigin, "/")).text(), /<html/);
	assert.deepEqual((await json(webOrigin, "/api/chats", {
		key: users[1].key, headers: { "x-learnharness-user": "secondary", Cookie: "user=secondary" },
	})).chats.map((chat) => chat.id), [users[0].chat.id], "client headers cannot change the YAML-selected web user");
	probe("gateway", `
import assert from 'node:assert/strict';
const users = JSON.parse(process.env.LH_SERVER_USERS);
for (const user of users) {
  for (const route of ['/', '/api/chats', '/_next/static/test.js']) {
    const denied = await fetch(user.upstreamUrl + route, {signal: AbortSignal.timeout(5000)});
    assert.equal(denied.status, 401, 'all worker routes require authentication');
    await denied.arrayBuffer();
  }
  const other = users.find(candidate => candidate.id !== user.id);
  const wrong = await fetch(user.upstreamUrl + '/api/chats', {headers: {Authorization: 'Bearer ' + other.apiKey}, signal: AbortSignal.timeout(5000)});
  assert.equal(wrong.status, 401, 'a sibling key cannot authenticate another worker');
  await wrong.arrayBuffer();
  const own = await fetch(user.upstreamUrl + '/', {headers: {Authorization: 'Bearer ' + user.apiKey}, signal: AbortSignal.timeout(10000)});
  assert.equal(own.status, 200, 'authenticated worker serves website pages');
  await own.arrayBuffer();
  for (const port of ['3000', '8080']) {
    const target = new URL(user.upstreamUrl); target.port = port;
    await assert.rejects(fetch(target, {signal: AbortSignal.timeout(3000)}), 'raw Next and unauthenticated web listeners are unreachable');
  }
}
`);
	console.log("[smoke-docker-multiuser] legacy state retention, separate history, graph, jobs, settings, credentials and authenticated worker boundaries passed");

	// Both channels attach before mutations. Each receives only its own events.
	const eventControllers = users.map(() => new AbortController());
	const eventReaders = [];
	const eventText = users.map(() => "");
	const eventPumps = [];
	try {
		for (let index = 0; index < users.length; index++) {
			const response = await fetch(`${apiOrigin}/api/events`, {
				headers: { Authorization: `Bearer ${users[index].key}` }, signal: AbortSignal.any([eventControllers[index].signal, AbortSignal.timeout(20_000)]),
			});
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-type"), /text\/event-stream/);
			const reader = response.body.getReader();
			eventReaders.push(reader);
			eventPumps.push((async () => {
				try { while (true) { const part = await reader.read(); if (part.done) break; eventText[index] += new TextDecoder().decode(part.value); } }
				catch (error) { if (!eventControllers[index].signal.aborted) throw error; }
			})());
		}
		async function renameAndObserve(index) {
			const other = 1 - index;
			const ownBefore = eventText[index].split("event: chats-changed").length;
			const otherBefore = eventText[other].split("event: chats-changed").length;
			await (await request(apiOrigin, `/api/chats/${users[index].chat.id}`, {
				key: users[index].key, method: "PUT", body: { title: users[index].title },
			})).arrayBuffer();
			const deadline = Date.now() + 5000;
			while (eventText[index].split("event: chats-changed").length === ownBefore && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(eventText[index].split("event: chats-changed").length, ownBefore + 1, "own event arrives through both proxies");
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(eventText[other].split("event: chats-changed").length, otherBefore, "sibling stream does not receive another user's event");
		}
		await renameAndObserve(0);
		await renameAndObserve(1);
	} finally {
		for (const controller of eventControllers) controller.abort();
		await Promise.allSettled(eventReaders.map((reader) => reader.cancel()));
		await Promise.all(eventPumps);
	}
	compose(["down", "--timeout", "10"]);
	compose(["up", "--detach", "--wait", "--wait-timeout", "120"]);
	refreshOrigins();
	for (const user of users) await assertState(user);
	console.log("[smoke-docker-multiuser] event-stream isolation and private state survived container replacement");

	selectWebUser(users[1].key);
	compose(["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "60", "gateway"]);
	refreshOrigins();
	assert.deepEqual((await json(webOrigin, "/api/chats")).chats.map((chat) => chat.id), [users[1].chat.id], "YAML selects the secondary web workspace");
	for (const user of users) await assertState(user);
	const oldSecondaryKey = users[1].key;
	users[1].key = newKey();
	env.LH_SECONDARY_API_KEY = users[1].key;
	selectWebUser(users[1].key);
	compose(["up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "120"]);
	refreshOrigins();
	await (await request(apiOrigin, "/api/chats", { key: oldSecondaryKey, status: 401 })).arrayBuffer();
	for (const user of users) await assertState(user);
	assert.deepEqual((await json(webOrigin, "/api/chats")).chats.map((chat) => chat.id), [users[1].chat.id]);
	console.log("[smoke-docker-multiuser] web selection and key rotation preserve each user's existing history; no provider requests made");
} catch (error) {
	try { console.error(redact(compose(["logs", "--no-color", "--tail", "60"]))); } catch { /* Original error wins. */ }
	console.error(redact(`[smoke-docker-multiuser] FAIL: ${error.message}`));
	process.exitCode = 1;
} finally {
	try { compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"]); }
	catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
	rmSync(temporary, { recursive: true, force: true });
}
