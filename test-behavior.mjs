// Behavior test: loads index.js against a minimal SillyTavern/jQuery stand-in,
// feeds it real streamed responses, and checks what lands on the chat.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');

function makeHarness() {
    const handlers = {};
    const chat = [];
    const eventTypes = {
        GENERATION_STARTED: 'generation_started',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_SWIPED: 'message_swiped',
        CHAT_CHANGED: 'chat_id_changed',
        MORE_MESSAGES_LOADED: 'more_messages_loaded',
    };
    const eventSource = {
        on(type, fn) { (handlers[type] ||= []).push(fn); },
        emit(type, ...args) { (handlers[type] || []).forEach(fn => fn(...args)); },
    };
    let nextResponse = null;
    const chainable = new Proxy(function () {}, {
        get: (_, key) => (key === 'length' ? 0 : () => chainable),
        apply: () => chainable,
    });
    const $ = Object.assign(() => chainable, {});
    const window = { fetch: async () => nextResponse() };
    const context = {
        window, document: {},
        SillyTavern: {
            getContext: () => ({ chat, saveChat() {}, eventSource, eventTypes, callGenericPopup() {}, POPUP_TYPE: {} }),
        },
        jQuery: fn => fn(),
        $,
        console: { log() {}, debug() {} },
        Response, ReadableStream, TextDecoder, TextEncoder, setTimeout, Promise, Number, Object, Math, Date, Set, String,
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return {
        chat,
        emit: (t, ...a) => eventSource.emit(eventTypes[t], ...a),
        respondWith(fn) { nextResponse = fn; },
        fetch: (url = '/api/backends/chat-completions/generate') => window.fetch(url, {}),
    };
}

function sse(events, { delayMs = 0 } = {}) {
    const enc = new TextEncoder();
    return () => new Response(new ReadableStream({
        async start(controller) {
            for (const ev of events) {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            }
            controller.close();
        },
    }), { headers: { 'content-type': 'text/event-stream' } });
}

async function drain(response) {
    const reader = response.body.getReader();
    while (!(await reader.read()).done) { /* ST consumes its branch */ }
}

const settle = () => new Promise(r => setTimeout(r, 30));
const usageOf = (h, i) => h.chat[i].extra?.cache_usage;

// 1. Gemini (Vertex) stream: cumulative usageMetadata, latest wins; inclusive prompt.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([
        { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }], usageMetadata: { promptTokenCount: 30000, thoughtsTokenCount: 50 } },
        { candidates: [{ content: { parts: [{ text: 'Hi' }] } }], usageMetadata: { promptTokenCount: 30000, cachedContentTokenCount: 22016, candidatesTokenCount: 400, thoughtsTokenCount: 600 } },
    ]));
    await drain(await h.fetch());
    await settle();
    h.emit('GENERATION_ENDED');
    const u = usageOf(h, 0);
    assert.equal(u.provider, 'gemini');
    assert.equal(u.cache_read, 22016);
    assert.equal(u.input_tokens, 30000 - 22016);
    assert.equal(u.total_input, 30000);
    assert.equal(u.output_tokens, 1000, 'output includes thinking tokens');
    assert.equal(u.hit_rate.toFixed(1), '73.4');
}

// 2. Gemini miss: Vertex omits cachedContentTokenCount when zero -> reported miss.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([{ usageMetadata: { promptTokenCount: 27701, candidatesTokenCount: 10 } }]));
    await drain(await h.fetch());
    await settle();
    h.emit('GENERATION_ENDED');
    const u = usageOf(h, 0);
    assert.equal(u.cache_read, 0);
    assert.equal(u.cache_reported, true);
    assert.equal(u.input_tokens, 27701);
}

// 3. OpenAI-style: prompt_tokens includes cached_tokens (no double count).
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([{ choices: [] , usage: { prompt_tokens: 29644, completion_tokens: 508, prompt_tokens_details: { cached_tokens: 22016 } } }]));
    await drain(await h.fetch());
    await settle();
    h.emit('GENERATION_ENDED');
    const u = usageOf(h, 0);
    assert.equal(u.total_input, 29644);
    assert.equal(u.hit_rate.toFixed(1), '74.3');
}

// 4. Anthropic: message_start + message_delta merge; input excludes cache.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([
        { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 300 }, output_tokens: 1 } } },
        { type: 'message_delta', usage: { output_tokens: 250 } },
    ]));
    await drain(await h.fetch());
    await settle();
    h.emit('GENERATION_ENDED');
    const u = usageOf(h, 0);
    assert.equal(u.provider, 'anthropic');
    assert.equal(u.total_input, 9312);
    assert.equal(u.cache_write_5m, 300);
    assert.equal(u.output_tokens, 250);
    assert.equal(u.input_tokens, 12, 'delta without input_tokens keeps the start value');
}

// 5. Race: the usage chunk arrives AFTER SillyTavern ends the generation.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([{ usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4000, candidatesTokenCount: 5 } }], { delayMs: 40 }));
    const res = await h.fetch();
    h.emit('GENERATION_ENDED'); // ST finished before our tee saw usage
    assert.equal(usageOf(h, 0), undefined);
    await drain(res);
    await settle();
    assert.equal(usageOf(h, 0)?.cache_read, 4000, 'late usage still attaches to its reply');
}

// 6. Quiet generations never write to a visible reply.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'quiet');
    h.respondWith(sse([{ usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 90 } }]));
    await drain(await h.fetch());
    await settle();
    h.emit('GENERATION_ENDED');
    await settle();
    assert.equal(usageOf(h, 0), undefined);
}

// 7. Chat switch while a stream is still open: nothing lands in the new chat.
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(sse([{ usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 90 } }], { delayMs: 40 }));
    const res = await h.fetch();
    h.emit('GENERATION_ENDED');
    h.emit('CHAT_CHANGED');
    h.chat.length = 0;
    h.chat.push({ is_user: false, extra: {} });
    await drain(res);
    await settle();
    assert.equal(usageOf(h, 0), undefined);
}

// 8. Non-streaming JSON (SillyTavern Gemini reply with usageMetadata passthrough).
{
    const h = makeHarness();
    h.chat.push({ is_user: false, extra: {} });
    h.emit('GENERATION_STARTED', 'normal');
    h.respondWith(() => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], usageMetadata: { promptTokenCount: 800, cachedContentTokenCount: 512 } }), { headers: { 'content-type': 'application/json' } }));
    await (await h.fetch()).json();
    await settle();
    h.emit('GENERATION_ENDED');
    await settle();
    assert.equal(usageOf(h, 0)?.cache_read, 512);
}

console.log('Cache Stats behavior tests passed (8 scenarios).');
