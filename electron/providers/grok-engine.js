/**
 * Proxima — Grok Engine v4.1.0
 * Runs inside grok.com BrowserView context. Uses the page's own webpack
 * chatApi middleware to mint fresh x-statsig-id tokens (no reimplementation
 * of the anti-bot crypto), then talks to the /rest/app-chat NDJSON stream.
 *
 * Strategy:
 *  1. Find the page's webpack runtime via the chunk-push trick, locate the
 *     chatApi module, and extract the challenge constants by calling
 *     middleware[0].pre() once with determinism hooks (Math.random=()=>0,
 *     Date.now=()=>1e12, crypto.subtle.digest hook) — same as the community
 *     grok-web-api extraction snippet.
 *  2. Generate x-statsig-id per request using the extracted constants
 *     (header ∥ u32le(counter) ∥ sha256(method!path!counter!suffix)[0..16]
 *     ∥ trailer, XOR'd with one random byte, base64 no-pad).
 *  3. Fall back to a header captured from live app traffic by monkey-patching
 *     fetch at inject time.
 *  4. POST to /rest/app-chat/conversations/new (or .../{id}/responses) and
 *     parse the NDJSON stream.
 */
(function() {
    if (window.__proximaGrok) return;

    var GROK_BASE = 'https://grok.com';
    var TIMEOUT = 360000;
    var EPOCH = 1682924400;

    // ─── State ───────────────────────────────────────
    var _conversationId = '';
    var _parentResponseId = '';

    // ─── Challenge constants + captured header ───────
    var _challenge = null;             // { header: Array<byte> (49), suffix: string, trailer: number }
    var _challengePending = null;      // in-flight extraction promise
    var _capturedStatsig = '';         // fallback captured from live traffic

    // ─── Helpers ─────────────────────────────────────

    function _uuid() {
        var c = crypto.getRandomValues(new Uint8Array(16));
        c[6] = (c[6] & 0x0f) | 0x40;
        c[8] = (c[8] & 0x3f) | 0x80;
        var hex = '';
        for (var i = 0; i < 16; i++) hex += ('0' + c[i].toString(16)).slice(-2);
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    // Locate the webpack runtime require via the chunk-push trick.
    var _wr = null;
    function _getRequire() {
        if (_wr) return _wr;
        var names = ['webpackChunk_N_E', 'webpackChunkgrok', 'webpackChunk', 'webpackJsonp'];
        for (var i = 0; i < names.length; i++) {
            var chunks = window[names[i]];
            if (!chunks || typeof chunks.push !== 'function') continue;
            try {
                var captured = null;
                chunks.push([[Symbol()], {}, function() {
                    captured = arguments[arguments.length - 1];
                }]);
                if (captured && captured.c) { _wr = captured; return _wr; }
            } catch (e) {}
        }
        // Fallback: scan any window key that looks like a webpack chunk array
        for (var key in window) {
            try {
                if (key.indexOf('webpack') !== 0) continue;
                var c = window[key];
                if (c && typeof c.push === 'function' && typeof c.length === 'number') {
                    var cap = null;
                    c.push([[Symbol()], {}, function() { cap = arguments[arguments.length - 1]; }]);
                    if (cap && cap.c) { _wr = cap; return _wr; }
                }
            } catch (e) {}
        }
        return null;
    }

    function _looksLikeChatApi(o) {
        return !!o && typeof o === 'object' && !!o.configuration &&
            Array.isArray(o.configuration.middleware);
    }

    function _deepFindChatApi(obj, depth) {
        if (depth > 3 || !obj || typeof obj !== 'object') return null;
        if (_looksLikeChatApi(obj)) return obj;
        var seen = 0;
        for (var k in obj) {
            if (seen++ > 40) break;
            try {
                var v = obj[k];
                if (v && typeof v === 'object') {
                    var res = _deepFindChatApi(v, depth + 1);
                    if (res) return res;
                }
            } catch (e) {}
        }
        return null;
    }

    function _findChatApi() {
        var r = _getRequire();
        if (!r || !r.c) return null;
        for (var id in r.c) {
            try {
                var ex = r.c[id] && r.c[id].exports;
                if (!ex || typeof ex !== 'object') continue;
                if (ex.chatApi && _looksLikeChatApi(ex.chatApi)) return ex.chatApi;
                if (ex.default && ex.default.chatApi && _looksLikeChatApi(ex.default.chatApi)) return ex.default.chatApi;
                if (_looksLikeChatApi(ex)) return ex;
            } catch (e) {}
        }
        // bounded deep scan as last resort
        for (var id2 in r.c) {
            try {
                var ex2 = r.c[id2] && r.c[id2].exports;
                if (!ex2 || typeof ex2 !== 'object') continue;
                var found = _deepFindChatApi(ex2, 0);
                if (found) return found;
            } catch (e) {}
        }
        return null;
    }

    // Extract challenge constants from the live page's chatApi middleware.
    async function _extractChallenge() {
        if (_challenge) return _challenge;
        if (_challengePending) return _challengePending;

        _challengePending = (async function() {
            try {
                var chatApi = _findChatApi();
                if (!chatApi) throw new Error('Grok chatApi not found');
            var middleware = chatApi.configuration.middleware || [];
            var pre = null;
            for (var i = 0; i < middleware.length; i++) {
                if (middleware[i] && typeof middleware[i].pre === 'function') { pre = middleware[i].pre; break; }
            }
            if (!pre) throw new Error('Grok middleware pre not found');

            var mr = Math.random, dn = Date.now, dig = crypto.subtle.digest.bind(crypto.subtle);
            var h = null;
            Math.random = function() { return 0; };
            Date.now = function() { return 1e12; };
            crypto.subtle.digest = async function(a, b) {
                try { h = new TextDecoder().decode(b); } catch (e) {}
                return dig(a, b);
            };
            var s = null;
            try {
                s = await pre({ url: GROK_BASE + '/rest/app-chat/x', init: { method: 'POST', headers: {} } });
            } catch (e) {
                throw new Error('Grok middleware pre failed: ' + e.message);
            } finally {
                Math.random = mr; Date.now = dn; crypto.subtle.digest = dig;
            }

            var hdr = (s && s.init && s.init.headers && s.init.headers['x-statsig-id']) ||
                      (s && s.headers && s.headers['x-statsig-id']) || '';
            if (!hdr) throw new Error('Grok middleware did not return x-statsig-id');

            var bytes = [];
            try {
                var bin = atob(hdr);
                for (var j = 0; j < bin.length; j++) bytes.push(bin.charCodeAt(j) & 0xff);
            } catch (e) { throw new Error('Grok statsig decode failed'); }
            if (bytes.length < 70) throw new Error('Grok statsig token too short');

            _challenge = {
                header: bytes.slice(0, 49),
                trailer: bytes[69] || 0x03,
                suffix: h ? h.split('!').slice(2).join('!').replace(/^-?\d+/, '') : ''
            };
            console.log('[Proxima Grok] Challenge constants extracted (suffix=' + JSON.stringify(_challenge.suffix) + ')');
            return _challenge;
            } catch (err) {
                _challengePending._err = err.message;
                throw err;
            }
        })();

        return _challengePending;
    }

    // Generate a fresh x-statsig-id for a given path+method.
    async function _generateStatsig(path, method) {
        var c = null;
        try { c = await _extractChallenge(); } catch (e) { return ''; }
        if (!c) return '';

        var counter = Math.max(0, Math.floor(Date.now() / 1000) - EPOCH);
        var counterStr = counter.toString();
        var hashInput = method + '!' + path + '!' + counterStr + c.suffix;

        var hashBuf;
        try {
            hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
        } catch (e) { return ''; }
        var hash = new Uint8Array(hashBuf);

        var raw = new Uint8Array(70);
        for (var i = 0; i < 49; i++) raw[i] = c.header[i] & 0xff;
        raw[49] = counter & 0xff;
        raw[50] = (counter >> 8) & 0xff;
        raw[51] = (counter >> 16) & 0xff;
        raw[52] = (counter >> 24) & 0xff;
        for (var j = 0; j < 16; j++) raw[53 + j] = hash[j];
        raw[69] = c.trailer;

        var xorKey = Math.floor(Math.random() * 256);
        for (var k = 0; k < 70; k++) raw[k] = raw[k] ^ xorKey;

        var bin = '';
        for (var m = 0; m < 70; m++) bin += String.fromCharCode(raw[m]);
        return btoa(bin).replace(/=+$/, '');
    }

    // ─── Payloads ────────────────────────────────────

    function _deviceEnvInfo() {
        return {
            darkModeEnabled: false,
            devicePixelRatio: 2,
            screenWidth: 1800,
            screenHeight: 1169,
            viewportWidth: 1055,
            viewportHeight: 976
        };
    }

    function _baseOptions() {
        return {
            fileAttachments: [],
            imageAttachments: [],
            disableSearch: false,
            enableImageGeneration: true,
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            enableImageStreaming: true,
            imageGenerationCount: 2,
            forceConcise: false,
            enableSideBySide: true,
            sendFinalMetadata: true,
            disableTextFollowUps: false,
            isAsyncChat: false,
            disableSelfHarmShortCircuit: false,
            modeId: 'auto'
        };
    }

    function _newPayload(message) {
        var p = _baseOptions();
        p.temporary = true;
        p.message = message;
        p.responseMetadata = {};
        p.disableMemory = false;
        p.forceSideBySide = false;
        p.deviceEnvInfo = _deviceEnvInfo();
        return p;
    }

    function _continuePayload(message) {
        var p = _baseOptions();
        p.message = message;
        p.metadata = {};
        if (_parentResponseId) p.parentResponseId = _parentResponseId;
        return p;
    }

    // ─── Stream parsing (NDJSON) ─────────────────────

    function _handleLine(line, state) {
        var t = line.trim();
        if (!t) return false;
        if (t === '[DONE]') { state.done = true; return true; }
        if (t.indexOf('data:') === 0) t = t.substring(5).trim();
        if (!t) return false;

        var obj;
        try { obj = JSON.parse(t); } catch (e) { return false; }

        if (obj.error && obj.error.message) {
            state.error = obj.error.message;
            state.done = true;
            return true;
        }

        var result = obj.result;
        if (!result || typeof result !== 'object') return false;

        if (result.conversation && result.conversation.conversationId) {
            state.convId = result.conversation.conversationId;
        }

        var resp = (result.response && typeof result.response === 'object') ? result.response : result;
        if (resp && typeof resp === 'object') {
            if (typeof resp.token === 'string' && resp.messageTag === 'final' && resp.isThinking !== true) {
                state.answer += resp.token;
            }
            if (resp.isSoftStop === true || resp.finalMetadata) {
                if (resp.responseId) state.respId = resp.responseId;
                state.done = true;
                return true;
            }
        }
        return false;
    }

    async function _readStream(res) {
        if (!res.body || !res.body.getReader) {
            // non-streaming body fallback
            var full = await res.text();
            var state0 = { answer: '', done: false, error: '', convId: '', respId: '' };
            var lines0 = full.split('\n');
            for (var li0 = 0; li0 < lines0.length && !state0.done; li0++) _handleLine(lines0[li0], state0);
            return _finishState(state0);
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var state = { answer: '', done: false, error: '', convId: '', respId: '' };

        while (!state.done) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
                if (_handleLine(lines[i], state)) break;
            }
        }
        // flush remaining buffer
        if (buffer.trim() && !state.done) _handleLine(buffer, state);
        return _finishState(state);
    }

    function _finishState(state) {
        if (state.convId) _conversationId = state.convId;
        if (state.respId) _parentResponseId = state.respId;
        if (state.error) throw new Error('Grok stream error: ' + state.error.substring(0, 300));
        if (!state.answer) throw new Error('No response captured from Grok');
        return state.answer;
    }

    // ─── Send Message ───────────────────────────────

    async function send(message) {
        var isNew = !_conversationId;
        var url = isNew
            ? GROK_BASE + '/rest/app-chat/conversations/new'
            : GROK_BASE + '/rest/app-chat/conversations/' + _conversationId + '/responses';
        var path = url.substring(GROK_BASE.length);

        var statsig = await _generateStatsig(path, 'POST');
        if (!statsig && _capturedStatsig) statsig = _capturedStatsig;

        var headers = {
            'content-type': 'application/json',
            'accept': '*/*',
            'x-xai-request-id': _uuid()
        };
        if (statsig) headers['x-statsig-id'] = statsig;

        var payload = isNew ? _newPayload(message) : _continuePayload(message);

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

        var res;
        try {
            res = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }

        // Retry once with a fresh statsig token on 400/401/403
        if ((res.status === 400 || res.status === 401 || res.status === 403) && statsig) {
            var fresh = await _generateStatsig(path, 'POST');
            if (fresh && fresh !== statsig) {
                headers['x-statsig-id'] = fresh;
                try {
                    res = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: headers,
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                } catch (e) {
                    clearTimeout(timeoutId);
                    throw e;
                }
            }
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var err = await res.text().catch(function() { return ''; });
            throw new Error('Grok API error (' + res.status + '): ' + err.substring(0, 300));
        }

        var result = await _readStream(res);
        clearTimeout(timeoutId);
        return result;
    }

    // ─── Fallback: capture a real x-statsig-id from live traffic ───
    (function() {
        var origFetch = window.fetch;
        if (!origFetch) return;
        window.fetch = function(input, init) {
            var p = origFetch.apply(this, arguments);
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                var hdrs = (init && init.headers) ? init.headers : null;
                var h = null;
                if (hdrs) {
                    if (typeof hdrs.get === 'function') h = hdrs.get('x-statsig-id');
                    else h = hdrs['x-statsig-id'];
                }
                if (url.indexOf('grok.com') !== -1 && typeof h === 'string' && h.length > 50) {
                    _capturedStatsig = h;
                }
            } catch (e) {}
            return p;
        };
    })();

    function newConversation() {
        _conversationId = '';
        _parentResponseId = '';
        console.log('[Proxima Grok] Conversation reset');
    }

    function _debug() {
        return {
            challenge: _challenge ? {
                headerLen: _challenge.header ? _challenge.header.length : 0,
                trailer: _challenge.trailer,
                suffix: _challenge.suffix
            } : null,
            challengeError: (_challengePending && _challengePending._err) ? _challengePending._err : null,
            capturedStatsig: _capturedStatsig ? _capturedStatsig.substring(0, 40) + '...' : '',
            conversationId: _conversationId,
            webpack: _getRequire() ? 'found' : 'none'
        };
    }

    window.__proximaGrok = { send: send, newConversation: newConversation, _debug: _debug };
    console.log('[Proxima] Grok engine loaded');
})();
