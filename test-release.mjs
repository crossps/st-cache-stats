import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [source, css, readme, manifestText] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
    readFile(new URL('./README.md', import.meta.url), 'utf8'),
    readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.version, '1.2.3', 'release version should be 1.2.3');
assert.match(source, /cache_read_input_tokens/, 'Anthropic cache-read capture must remain');
assert.match(source, /cache_creation_input_tokens/, 'Anthropic cache-write capture must remain');
assert.match(source, /parseSseStream/, 'stream usage capture must remain');
assert.match(source, /cachedContentTokenCount/, 'Gemini cache-read capture must remain');

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
assert.match(css, /#chat \.mes \.cache_stats_button\.cache-stats-hit/, 'state colours must out-rank theme button styles');
assert.ok(source.indexOf("return 'cache-stats-write'") < source.indexOf("return 'cache-stats-hit'"), 'a reply that wrote must show as a write (green) even when it also read');
assert.ok(!/proxy URL|synchroniz|prompt-cache policy/i.test(readme), 'README must not claim to control proxy cache policy');

assert.ok(!/drop-shadow/.test(css), 'state icons are colour only, no glow');

console.log('Cache Stats 1.2.3 release checks passed.');
