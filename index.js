/**
 * Cache Stats — per-message prompt-cache read/write for Claude, OpenAI-style,
 * and Gemini (Google AI Studio / Vertex AI) replies.
 *
 * SillyTavern does not persist provider usage. This extension tees the generate
 * stream, reads the usage the provider reports (Anthropic message_start /
 * message_delta, OpenAI usage, Gemini usageMetadata), stores it on the message
 * extra, and adds a database icon to the message-actions row.
 *
 * Each generation owns its capture: usage from a quiet/background generation
 * can never land on a visible reply, and usage that arrives after SillyTavern
 * has already ended the generation is still attached to it.
 */

const BTN = 'cache_stats_button';
const EXTRA_KEY = 'cache_usage';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const SKIPPED_TYPES = new Set(['quiet', 'impersonate']);

/** The generation currently in flight (or the last one), see beginGeneration(). */
let activeGen = null;
let genSeq = 0;
let fetchHooked = false;

function ctx() {
    return SillyTavern.getContext();
}

function fmt(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString();
}

function pct(part, whole) {
    if (!whole) return 0;
    return (part / whole) * 100;
}

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function finish(provider, { uncached, output, write, read, write5m = 0, write1h = 0, reported }) {
    const totalIn = uncached + write + read;
    return {
        provider,
        input_tokens: uncached,
        output_tokens: output,
        cache_write: write,
        cache_read: read,
        cache_write_5m: write5m,
        cache_write_1h: write1h,
        total_input: totalIn,
        hit_rate: pct(read, totalIn),
        cache_reported: reported,
        captured_at: Date.now(),
    };
}

/**
 * Gemini usageMetadata. promptTokenCount INCLUDES cached tokens, and Vertex /
 * AI Studio omit cachedContentTokenCount when it is zero, so absence is a miss.
 * Implicit caching has no write step.
 */
function normalizeGemini(meta) {
    const prompt = num(meta.promptTokenCount);
    const candidates = num(meta.candidatesTokenCount);
    const thoughts = num(meta.thoughtsTokenCount);
    if (prompt == null && candidates == null && thoughts == null) return null;
    const read = num(meta.cachedContentTokenCount) ?? 0;
    return finish('gemini', {
        uncached: Math.max(0, (prompt ?? 0) - read),
        output: (candidates ?? 0) + (thoughts ?? 0),
        write: 0,
        read,
        reported: prompt != null,
    });
}

/**
 * Anthropic usage: input_tokens EXCLUDES cache reads and writes.
 * OpenAI usage: prompt_tokens INCLUDES cached_tokens (and any reported writes).
 */
function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
        ? raw.prompt_tokens_details
        : null;
    const write5m = num(raw.cache_creation?.ephemeral_5m_input_tokens);
    const write1h = num(raw.cache_creation?.ephemeral_1h_input_tokens);
    const write = num(
        raw.cache_creation_input_tokens
        ?? (write5m != null || write1h != null ? (write5m ?? 0) + (write1h ?? 0) : null)
        ?? details?.cache_write_tokens,
    );
    const read = num(
        raw.cache_read_input_tokens
        ?? details?.cached_tokens
        ?? details?.cache_read_tokens,
    );
    const reported = has(raw, 'cache_read_input_tokens') || has(raw, 'cache_creation_input_tokens')
        || has(details, 'cached_tokens') || has(details, 'cache_read_tokens');

    // Anthropic unless OpenAI field names are present (message_delta carries
    // only output_tokens and must merge into message_start, not replace it).
    if (has(raw, 'input_tokens') || (!has(raw, 'prompt_tokens') && !has(raw, 'completion_tokens'))) {
        const input = num(raw.input_tokens);
        const output = num(raw.output_tokens);
        if (input == null && output == null && write == null && read == null) return null;
        return finish('anthropic', {
            uncached: input ?? 0,
            output: output ?? 0,
            write: write ?? 0,
            read: read ?? 0,
            write5m: write5m ?? 0,
            write1h: write1h ?? 0,
            reported,
        });
    }

    const prompt = num(raw.prompt_tokens);
    const output = num(raw.completion_tokens ?? raw.output_tokens);
    if (prompt == null && output == null && write == null && read == null) return null;
    return finish('openai', {
        uncached: Math.max(0, (prompt ?? 0) - (read ?? 0) - (write ?? 0)),
        output: output ?? 0,
        write: write ?? 0,
        read: read ?? 0,
        reported,
    });
}

/**
 * Anthropic splits usage across message_start (input side) and message_delta
 * (final output), so later non-zero fields fill in earlier ones. Every other
 * provider reports cumulative usage, so the latest report wins.
 */
function mergeUsage(into, next) {
    if (!next) return into;
    if (!into || into.provider !== next.provider || next.provider !== 'anthropic') return next;
    const merged = {
        ...into,
        input_tokens: next.input_tokens || into.input_tokens,
        output_tokens: next.output_tokens || into.output_tokens,
        cache_write: next.cache_write || into.cache_write,
        cache_read: next.cache_read || into.cache_read,
        cache_write_5m: next.cache_write_5m || into.cache_write_5m,
        cache_write_1h: next.cache_write_1h || into.cache_write_1h,
        cache_reported: into.cache_reported || next.cache_reported,
        captured_at: next.captured_at,
    };
    merged.total_input = merged.input_tokens + merged.cache_write + merged.cache_read;
    merged.hit_rate = pct(merged.cache_read, merged.total_input);
    return merged;
}

function extractUsageFromPayload(obj, capture) {
    if (!obj || typeof obj !== 'object') return;
    const take = usage => { if (usage) capture.usage = mergeUsage(capture.usage, usage); };
    if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
        take(normalizeGemini(obj.usageMetadata));
        return;
    }
    if (obj.type === 'message_start' && obj.message?.usage) {
        take(normalizeUsage(obj.message.usage));
        return;
    }
    if (obj.usage) take(normalizeUsage(obj.usage));
    else if (obj.message?.usage) take(normalizeUsage(obj.message.usage));
}

async function parseSseStream(stream, capture) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const handleBlock = (block) => {
        for (const line of block.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                extractUsageFromPayload(JSON.parse(data), capture);
            } catch {
                // ignore partial/non-JSON chunks
            }
        }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split(/\r?\n\r?\n/);
            buf = parts.pop() ?? '';
            parts.forEach(handleBlock);
        }
        buf += decoder.decode();
        if (buf.trim()) handleBlock(buf);
    } catch (err) {
        console.debug('[cache-stats] stream parse stopped', err);
    }
}

function beginGeneration(type) {
    activeGen = {
        seq: ++genSeq,
        capture: !SKIPPED_TYPES.has(type),
        usage: null,
        pending: 0,
        ended: false,
        attached: false,
    };
}

function captureFinished(gen, capture) {
    gen.pending = Math.max(0, gen.pending - 1);
    if (capture.usage) gen.usage = capture.usage;
    if (gen.ended) attachToLatestAssistant(gen);
}

function hookFetch() {
    if (fetchHooked) return;
    fetchHooked = true;
    const original = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        const isGeneration = !!url && String(url).includes(GENERATE_PATH);
        // Bind the request to the generation that issued it, before awaiting.
        const gen = isGeneration ? activeGen : null;
        const response = await original(input, init);
        if (!gen || !gen.capture || gen.ended || !response.ok) {
            return response;
        }
        try {
            const capture = { usage: null };
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
                gen.pending++;
                response.clone().json()
                    .then(obj => extractUsageFromPayload(obj, capture))
                    .catch(() => { /* ignore */ })
                    .finally(() => captureFinished(gen, capture));
                return response;
            }
            if (!response.body) return response;
            const [forUs, forSt] = response.body.tee();
            gen.pending++;
            parseSseStream(forUs, capture).finally(() => captureFinished(gen, capture));
            return new Response(forSt, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (err) {
            console.debug('[cache-stats] fetch hook failed', err);
            return response;
        }
    };
}

function getMessage(mesId) {
    const { chat } = ctx();
    return chat?.[mesId];
}

function getUsageForMessage(mesId) {
    const mes = getMessage(mesId);
    if (!mes) return null;
    const swipeId = mes.swipe_id;
    const swipeExtra = mes.swipe_info?.[swipeId]?.extra;
    return swipeExtra?.[EXTRA_KEY] || mes.extra?.[EXTRA_KEY] || null;
}

function storeUsage(mesId, usage) {
    const { chat, saveChat } = ctx();
    const mes = chat?.[mesId];
    if (!mes || !usage) return;
    mes.extra = mes.extra || {};
    mes.extra[EXTRA_KEY] = usage;
    const swipeId = mes.swipe_id;
    if (Array.isArray(mes.swipe_info) && swipeId != null) {
        mes.swipe_info[swipeId] = mes.swipe_info[swipeId] || {};
        mes.swipe_info[swipeId].extra = mes.swipe_info[swipeId].extra || {};
        mes.swipe_info[swipeId].extra[EXTRA_KEY] = usage;
    }
    try { saveChat(); } catch (err) {
        console.debug('[cache-stats] saveChat failed', err);
    }
}

function attachToLatestAssistant(gen) {
    if (!gen || !gen.capture || gen.attached || !gen.usage) return;
    // A newer generation (or a chat switch) owns the latest message now.
    if (!activeGen || activeGen.seq !== gen.seq) return;
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            gen.attached = true;
            storeUsage(i, gen.usage);
            paintButton(i);
            return;
        }
    }
}

function onGenerationEnded() {
    const gen = activeGen;
    if (!gen) return;
    gen.ended = true;
    // Streams still being parsed attach themselves when they finish.
    if (gen.pending === 0) attachToLatestAssistant(gen);
}

function buttonClass(usage) {
    if (!usage) return '';
    if (usage.cache_read > 0) return 'cache-stats-hit';
    if (usage.cache_write > 0) return 'cache-stats-write';
    if (usage.cache_reported === false) return 'cache-stats-unknown';
    return 'cache-stats-miss';
}

function buttonTitle(usage) {
    if (!usage) return 'Prompt cache — no data for this reply (generate again to capture)';
    if (usage.cache_reported === false && !usage.cache_read && !usage.cache_write) {
        return 'Prompt cache — not reported by this backend';
    }
    const hit = usage.hit_rate.toFixed(1);
    return `Prompt cache — ${hit}% hit · read ${fmt(usage.cache_read)} · write ${fmt(usage.cache_write)}`;
}

function paintButton(mesId) {
    const $mes = $(`#chat .mes[mesid="${mesId}"]`);
    if (!$mes.length || $mes.attr('is_user') === 'true') return;
    const $row = $mes.find('.extraMesButtons');
    if (!$row.length) return;

    let $btn = $row.find(`.${BTN}`);
    if (!$btn.length) {
        $btn = $(`<div class="mes_button ${BTN} fa-solid fa-database"></div>`);
        $row.prepend($btn);
    }

    const usage = getUsageForMessage(mesId);
    $btn.attr('title', buttonTitle(usage));
    $btn.removeClass('cache-stats-hit cache-stats-write cache-stats-miss cache-stats-unknown');
    const klass = buttonClass(usage);
    if (klass) $btn.addClass(klass);
}

function paintAll() {
    $('#chat .mes[is_user="false"]').each(function () {
        const id = Number(this.getAttribute('mesid'));
        if (Number.isFinite(id)) paintButton(id);
    });
}

const PROVIDER_NOTES = {
    anthropic: 'Read tokens are billed at the cache-hit rate. Write tokens are the new prefix stored for later turns.',
    openai: 'Read tokens are billed at the provider\'s cached-input rate. Not every OpenAI-compatible backend reports writes.',
    gemini: 'Gemini implicit caching is automatic and best-effort: there is no write step or charge, and Google decides how long a prefix stays cached. Read tokens are billed at the cached-input rate.',
};

function showPopup(mesId) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const usage = getUsageForMessage(mesId);
    let html;
    if (!usage) {
        html = `
            <div class="cache-stats-panel">
                <h3>Prompt cache</h3>
                <p>No cache data on this reply.</p>
                <p class="cache-stats-note">SillyTavern does not keep provider usage unless this extension captures it during generation. Send or swipe a new reply to record hit / write numbers here.</p>
            </div>`;
    } else {
        const provider = usage.provider || 'anthropic';
        const unreported = usage.cache_reported === false && !usage.cache_read && !usage.cache_write;
        const writeRows = provider === 'anthropic'
            ? `<tr><th>5m write</th><td>${fmt(usage.cache_write_5m)}</td></tr>
               <tr><th>1h write</th><td>${fmt(usage.cache_write_1h)}</td></tr>`
            : '';
        html = `
            <div class="cache-stats-panel">
                <h3>Prompt cache</h3>
                <div class="cache-stats-hitpct">${unreported ? 'Not reported' : `${usage.hit_rate.toFixed(1)}% hit`}</div>
                <table>
                    <tr><th>Cache read</th><td>${fmt(usage.cache_read)}</td></tr>
                    ${provider === 'gemini' ? '' : `<tr><th>Cache write</th><td>${fmt(usage.cache_write)}</td></tr>`}
                    <tr><th>Uncached input</th><td>${fmt(usage.input_tokens)}</td></tr>
                    <tr><th>Total input</th><td>${fmt(usage.total_input)}</td></tr>
                    <tr><th>Output${provider === 'gemini' ? ' (incl. thinking)' : ''}</th><td>${fmt(usage.output_tokens)}</td></tr>
                    ${writeRows}
                </table>
                <p class="cache-stats-note">${unreported ? 'This backend returned token usage without any cache fields.' : PROVIDER_NOTES[provider] || PROVIDER_NOTES.anthropic}</p>
            </div>`;
    }
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false });
}

jQuery(async () => {
    hookFetch();
    const { eventSource, eventTypes, event_types } = ctx();
    const types = eventTypes || event_types;

    eventSource.on(types.GENERATION_STARTED, beginGeneration);
    eventSource.on(types.GENERATION_ENDED, onGenerationEnded);
    if (types.GENERATION_STOPPED) eventSource.on(types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.on(types.CHARACTER_MESSAGE_RENDERED, paintButton);
    eventSource.on(types.MESSAGE_UPDATED, paintButton);
    eventSource.on(types.MESSAGE_SWIPED, paintButton);
    eventSource.on(types.CHAT_CHANGED, () => {
        activeGen = null;
        setTimeout(paintAll, 50);
    });
    eventSource.on(types.MORE_MESSAGES_LOADED, () => setTimeout(paintAll, 50));

    $(document).on('click', `.${BTN}`, function (e) {
        e.preventDefault();
        e.stopPropagation();
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isFinite(mesId)) showPopup(mesId);
    });

    paintAll();
    console.log('[cache-stats] ready');
});
