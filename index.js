import { extension_settings } from '../../../extensions.js';

/**
 * Cache Stats — per-message prompt-cache read/write for Claude (and OpenAI-style) replies.
 *
 * SillyTavern does not persist Anthropic usage. This extension tees the generate
 * stream, pulls cache_read / cache_creation out of message_start, stores it on
 * the message extra, and adds a database icon to the message-actions row.
 */

const BTN = 'cache_stats_button';
const EXTRA_KEY = 'cache_usage';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const NAME = 'cache-stats';
const DEFAULTS = { cacheTtl: '1h', proxy: '' };

let pendingUsage = null;
let captureThisGeneration = true;
let fetchHooked = false;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    if (!extension_settings[NAME]) extension_settings[NAME] = { ...DEFAULTS };
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (extension_settings[NAME][key] === undefined) extension_settings[NAME][key] = value;
    }
    if (!['off', '5m', '1h'].includes(extension_settings[NAME].cacheTtl)) {
        extension_settings[NAME].cacheTtl = DEFAULTS.cacheTtl;
    }
    return extension_settings[NAME];
}

function proxyBase(value) {
    return String(value || '').trim()
        .replace(/\/+$/, '')
        .replace(/\/v1\/chat\/completions$/i, '')
        .replace(/\/v1$/i, '');
}

function setSyncStatus(text, state = '') {
    const $status = $('#cache_stats_sync_status');
    if (!$status.length) return;
    $status.text(text).attr('data-state', state);
}

function proxyFromGenerateRequest(init) {
    try {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
        if (!body || typeof body !== 'object') return '';
        return proxyBase(body.reverse_proxy || body.custom_url || body.proxy_url || body.api_url || '');
    } catch {
        return '';
    }
}

async function syncCachePolicy(base, quiet = false) {
    const proxy = proxyBase(base || settings().proxy);
    if (!proxy) {
        setSyncStatus('Waiting for a proxy URL', 'warning');
        if (!quiet) toastr.warning('Set the Claude proxy URL first.', 'Cache Stats');
        return false;
    }
    setSyncStatus('Synchronizing…', 'pending');
    const response = await fetch(`${proxy}/admin/sillytavern-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cacheTtl: settings().cacheTtl }),
        cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Proxy returned HTTP ${response.status}`);
    setSyncStatus(`Applied: ${settings().cacheTtl === 'off' ? 'Off' : settings().cacheTtl}`, 'success');
    if (!quiet) toastr.success(`Prompt cache: ${settings().cacheTtl === 'off' ? 'off' : settings().cacheTtl}`, 'Cache Stats');
    return true;
}

function fmt(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString();
}

function pct(part, whole) {
    if (!whole) return 0;
    return (part / whole) * 100;
}

function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const input = num(raw.input_tokens ?? raw.prompt_tokens);
    const output = num(raw.output_tokens ?? raw.completion_tokens);
    const cacheWrite = num(
        raw.cache_creation_input_tokens
        ?? raw.cache_creation?.ephemeral_5m_input_tokens
        ?? raw.prompt_tokens_details?.cache_write_tokens,
    );
    const cacheRead = num(
        raw.cache_read_input_tokens
        ?? raw.prompt_tokens_details?.cached_tokens
        ?? raw.prompt_tokens_details?.cache_read_tokens,
    );
    const write5m = num(raw.cache_creation?.ephemeral_5m_input_tokens);
    const write1h = num(raw.cache_creation?.ephemeral_1h_input_tokens);

    if (input == null && output == null && cacheWrite == null && cacheRead == null) {
        return null;
    }

    const uncached = input ?? 0;
    const write = cacheWrite ?? 0;
    const read = cacheRead ?? 0;
    const totalIn = uncached + write + read;

    return {
        input_tokens: uncached,
        output_tokens: output ?? 0,
        cache_write: write,
        cache_read: read,
        cache_write_5m: write5m ?? 0,
        cache_write_1h: write1h ?? 0,
        total_input: totalIn,
        hit_rate: pct(read, totalIn),
        captured_at: Date.now(),
    };
}

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function mergeUsage(into, next) {
    if (!next) return into;
    if (!into) return next;
    return {
        input_tokens: next.input_tokens ?? into.input_tokens,
        output_tokens: next.output_tokens || into.output_tokens,
        cache_write: next.cache_write || into.cache_write,
        cache_read: next.cache_read || into.cache_read,
        cache_write_5m: next.cache_write_5m || into.cache_write_5m,
        cache_write_1h: next.cache_write_1h || into.cache_write_1h,
        total_input: next.total_input || into.total_input,
        hit_rate: next.total_input ? next.hit_rate : into.hit_rate,
        captured_at: next.captured_at || into.captured_at,
    };
}

function ingestRawUsage(raw) {
    const usage = normalizeUsage(raw);
    if (!usage) return;
    pendingUsage = mergeUsage(pendingUsage, usage);
}

function extractUsageFromPayload(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'message_start' && obj.message?.usage) {
        ingestRawUsage(obj.message.usage);
        return;
    }
    if (obj.type === 'message_delta' && obj.usage) {
        ingestRawUsage(obj.usage);
        return;
    }
    if (obj.usage) {
        ingestRawUsage(obj.usage);
    }
    if (obj.message?.usage) {
        ingestRawUsage(obj.message.usage);
    }
}

async function parseSseStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split(/\r?\n\r?\n/);
            buf = parts.pop() ?? '';
            for (const block of parts) {
                for (const line of block.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        extractUsageFromPayload(JSON.parse(data));
                    } catch {
                        // ignore partial/non-JSON chunks
                    }
                }
            }
        }
    } catch (err) {
        console.debug('[cache-stats] stream parse stopped', err);
    }
}

function hookFetch() {
    if (fetchHooked) return;
    fetchHooked = true;
    const original = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        const isGeneration = !!url && String(url).includes(GENERATE_PATH);
        if (isGeneration) {
            const detected = proxyFromGenerateRequest(init);
            if (detected) {
                settings().proxy = detected;
                ctx().saveSettingsDebounced();
                $('#cache_stats_proxy').val(detected);
            }
            try {
                await syncCachePolicy(detected || settings().proxy, true);
            } catch (err) {
                setSyncStatus('Not applied — check proxy URL', 'error');
                console.warn('[cache-stats] cache policy sync failed:', err);
            }
        }
        const response = await original(input, init);
        if (!isGeneration || !response.ok) {
            return response;
        }
        try {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
                const clone = response.clone();
                clone.json().then(extractUsageFromPayload).catch(() => { /* ignore */ });
                return response;
            }
            if (!response.body) return response;
            const [forUs, forSt] = response.body.tee();
            void parseSseStream(forUs);
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

function attachPendingToLatestAssistant() {
    if (!captureThisGeneration || !pendingUsage) return;
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            storeUsage(i, pendingUsage);
            paintButton(i);
            return;
        }
    }
}

function buttonClass(usage) {
    if (!usage) return '';
    if (usage.cache_read > 0) return 'cache-stats-hit';
    if (usage.cache_write > 0) return 'cache-stats-write';
    return 'cache-stats-miss';
}

function buttonTitle(usage) {
    if (!usage) return 'Prompt cache — no data for this reply (generate again to capture)';
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
    $btn.removeClass('cache-stats-hit cache-stats-write cache-stats-miss');
    const klass = buttonClass(usage);
    if (klass) $btn.addClass(klass);
}

function paintAll() {
    $('#chat .mes[is_user="false"]').each(function () {
        const id = Number(this.getAttribute('mesid'));
        if (Number.isFinite(id)) paintButton(id);
    });
}

function showPopup(mesId) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const usage = getUsageForMessage(mesId);
    let html;
    if (!usage) {
        html = `
            <div class="cache-stats-panel">
                <h3>Prompt cache</h3>
                <p>No cache data on this reply.</p>
                <p class="cache-stats-note">SillyTavern does not keep Anthropic usage unless this extension captures it during generation. Send or swipe a new reply to record hit / write numbers here.</p>
            </div>`;
    } else {
        html = `
            <div class="cache-stats-panel">
                <h3>Prompt cache</h3>
                <div class="cache-stats-hitpct">${usage.hit_rate.toFixed(1)}% hit</div>
                <table>
                    <tr><th>Cache read</th><td>${fmt(usage.cache_read)}</td></tr>
                    <tr><th>Cache write</th><td>${fmt(usage.cache_write)}</td></tr>
                    <tr><th>Uncached input</th><td>${fmt(usage.input_tokens)}</td></tr>
                    <tr><th>Total input</th><td>${fmt(usage.total_input)}</td></tr>
                    <tr><th>Output</th><td>${fmt(usage.output_tokens)}</td></tr>
                    <tr><th>5m write</th><td>${fmt(usage.cache_write_5m)}</td></tr>
                    <tr><th>1h write</th><td>${fmt(usage.cache_write_1h)}</td></tr>
                </table>
                <p class="cache-stats-note">Read tokens are billed at the cache-hit rate. Write tokens are the new prefix stored for later turns.</p>
            </div>`;
    }
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false });
}

function onGenerationStarted(type) {
    captureThisGeneration = type !== 'quiet' && type !== 'impersonate';
    if (captureThisGeneration) pendingUsage = null;
}

function onMessageRendered(mesId) {
    paintButton(mesId);
    if (captureThisGeneration && pendingUsage) {
        storeUsage(mesId, pendingUsage);
        paintButton(mesId);
    }
}

function mountSettings() {
    const $host = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!$host.length || $('#cache_stats_settings').length) return;
    const s = settings();
    $host.append(`
      <div id="cache_stats_settings" class="cache-stats-settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>Cache Stats</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <small>Choose the prompt-cache policy for this proxy's normal SillyTavern <code>/v1</code> route. The setting is synchronized before each generation.</small>
            <label for="cache_stats_ttl">Prompt cache</label>
            <select id="cache_stats_ttl" class="text_pole">
              <option value="off">Off</option>
              <option value="5m">5 minutes</option>
              <option value="1h">1 hour</option>
            </select>
            <small><b>Off</b> suits highly dynamic lorebooks. <b>5 minutes</b> is cheaper to write. <b>1 hour</b> suits stable prompts reused after pauses.</small>
            <label for="cache_stats_proxy">Claude proxy URL</label>
            <input id="cache_stats_proxy" class="text_pole" type="text" placeholder="https://your-proxy.example">
            <small>Usually detected from the active custom endpoint on your next generation.</small>
            <div id="cache_stats_sync_status" class="cache-stats-sync-status" data-state="idle">Not synchronized yet</div>
          </div>
        </div>
      </div>`);
    $('#cache_stats_ttl').val(s.cacheTtl);
    $('#cache_stats_proxy').val(s.proxy);
    $('#cache_stats_ttl').on('change', async function () {
        settings().cacheTtl = String($(this).val() || '1h');
        ctx().saveSettingsDebounced();
        try { await syncCachePolicy(); } catch (err) {
            setSyncStatus('Not applied — check proxy URL', 'error');
            toastr.error(err.message, 'Cache Stats');
        }
    });
    $('#cache_stats_proxy').on('change', async function () {
        settings().proxy = proxyBase($(this).val());
        $(this).val(settings().proxy);
        ctx().saveSettingsDebounced();
        try { await syncCachePolicy(); } catch (err) {
            setSyncStatus('Not applied — check proxy URL', 'error');
            toastr.error(err.message, 'Cache Stats');
        }
    });
}

settings();
jQuery(async () => {
    mountSettings();
    hookFetch();
    const { eventSource, eventTypes, event_types } = ctx();
    const types = eventTypes || event_types;

    eventSource.on(types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(types.GENERATION_ENDED, attachPendingToLatestAssistant);
    eventSource.on(types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(types.MESSAGE_UPDATED, paintButton);
    eventSource.on(types.CHAT_CHANGED, () => {
        pendingUsage = null;
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
