import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [source, css, readme, manifestText] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
    readFile(new URL('./README.md', import.meta.url), 'utf8'),
    readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.version, '1.3.0', 'release version should be 1.3.0');
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
assert.ok(!source.includes("return 'cache-stats-write'"), 'writes never decide the icon colour: any read is green, no read is yellow');
assert.match(css, /--cache-stats-read: #4fd18b;[\s\S]*--cache-stats-write: #f2c94c;/, 'read is green, write is yellow');
assert.match(css, /\.cache-stats-miss \{\s*color: var\(--cache-stats-write\)/, 'a reply with no cache read shows yellow');
assert.ok(!/proxy URL|synchroniz|prompt-cache policy/i.test(readme), 'README must not claim to control proxy cache policy');

assert.ok(!/drop-shadow/.test(css), 'state icons are colour only, no glow');

console.log('Cache Stats 1.3.0 release checks passed.');
