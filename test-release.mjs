import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [source, css, readme, manifestText] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
    readFile(new URL('./README.md', import.meta.url), 'utf8'),
    readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.version, '1.1.1', 'release version should be 1.1.1');
assert.match(source, /cache_read_input_tokens/, 'Anthropic cache-read capture must remain');
assert.match(source, /cache_creation_input_tokens/, 'Anthropic cache-write capture must remain');
assert.match(source, /parseSseStream/, 'stream usage capture must remain');

for (const forbidden of [
    'cacheTtl',
    'syncCachePolicy',
    'proxyFromGenerateRequest',
    'cache_stats_ttl',
    'cache_stats_proxy',
    '/admin/sillytavern-cache',
]) {
    assert.ok(!source.includes(forbidden), `index.js must not contain proxy-policy control: ${forbidden}`);
}

assert.ok(!css.includes('cache-stats-sync-status'), 'sync-only CSS should be removed');
assert.ok(!/proxy URL|synchroniz|prompt-cache policy/i.test(readme), 'README must not claim to control proxy cache policy');

console.log('Cache Stats 1.1.1 release checks passed.');
