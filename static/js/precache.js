import { state } from './state.js';
import { dom } from './dom.js';
import { parseLinkArray } from './utils.js';
import { openModal, closeModal } from './navigation.js';
import { isHttpLink } from './player-state.js';

const QUEUE_POLL_MS = 1500;

let queuePollTimer = null;
let movieStatusReqId = 0;

const ICON_BOLT_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
`;
const ICON_CHECK_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
`;
const ICON_CLOCK_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"></circle>
        <polyline points="12 7 12 12 15 14"></polyline>
    </svg>
`;

function buildTitlesMap() {
    const map = {};
    state.moviesDatabase.forEach((m) => {
        map[String(m.movie_id)] = m.title || `Movie #${m.movie_id}`;
    });
    return map;
}

function includeMobileBurnSelected() {
    return dom.cacheIncludeMobileBurn ? Boolean(dom.cacheIncludeMobileBurn.checked) : true;
}

function setMovieButtonVisual(cacheState, progress = 0) {
    const btn = dom.precacheMovieBtn;
    if (!btn) return;

    btn.classList.remove('is-cached', 'is-caching', 'is-queued');
    btn.dataset.cacheState = cacheState;

    if (cacheState === 'cached') {
        btn.classList.add('is-cached');
        btn.innerHTML = ICON_CHECK_SVG;
        btn.title = 'Cached on server (click to view queue)';
        btn.setAttribute('aria-label', btn.title);
    } else if (cacheState === 'caching') {
        btn.classList.add('is-caching');
        btn.innerHTML = ICON_CLOCK_SVG;
        const pct = Math.round(Number(progress) || 0);
        btn.title = `Pre-caching on server (${pct}%) — click to view queue`;
        btn.setAttribute('aria-label', btn.title);
    } else if (cacheState === 'queued') {
        btn.classList.add('is-queued');
        btn.innerHTML = ICON_CLOCK_SVG;
        btn.title = 'Queued for server pre-caching — click to view queue';
        btn.setAttribute('aria-label', btn.title);
    } else {
        btn.innerHTML = ICON_BOLT_SVG;
        btn.title = 'Pre-cache video on server for instant playback';
        btn.setAttribute('aria-label', btn.title);
    }
}

export async function refreshMoviePrecacheButton(movie) {
    const btn = dom.precacheMovieBtn;
    if (!btn) return;

    if (!state.isAdmin || state.isDemoMode || !movie) {
        btn.classList.add('hidden');
        return;
    }

    const localPaths = parseLinkArray(movie.link).filter((entry) => !isHttpLink(entry));
    if (localPaths.length === 0) {
        btn.classList.add('hidden');
        return;
    }

    btn.classList.remove('hidden');
    setMovieButtonVisual('uncached');

    const reqId = ++movieStatusReqId;
    const burnParam = `?include_mobile_burn=${includeMobileBurnSelected() ? 1 : 0}`;
    try {
        const res = await fetch(
            `/api/admin/precache/movie-status/${encodeURIComponent(movie.movie_id)}${burnParam}`,
            { headers: { 'x-api-token': state.serverApiToken } }
        );
        if (!res.ok || reqId !== movieStatusReqId) return;
        const data = await res.json();
        if (reqId !== movieStatusReqId) return;
        if (data.state === 'no_local') {
            btn.classList.add('hidden');
            return;
        }
        setMovieButtonVisual(data.state || 'uncached', data.progress || 0);
    } catch {
        // Keep default uncached icon on network hiccup
    }
}

export async function handlePrecacheCurrentMovie() {
    if (!state.isAdmin || state.isDemoMode || !state.currentMovieId) return;

    const currentState = dom.precacheMovieBtn?.dataset.cacheState || 'uncached';
    if (currentState === 'cached' || currentState === 'caching' || currentState === 'queued') {
        openPrecacheQueueModal();
        return;
    }

    const targetId = String(state.currentMovieId);
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === targetId);
    if (!movie) return;

    if (dom.precacheMovieBtn) dom.precacheMovieBtn.disabled = true;

    try {
        const res = await fetch(`/api/admin/precache/movie/${encodeURIComponent(targetId)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                titles: { [targetId]: movie.title || `Movie #${targetId}` },
                include_mobile_burn: includeMobileBurnSelected()
            })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.detail || 'Could not queue movie for pre-caching.');
        }

        if (data.queue_status) renderQueueStatus(data.queue_status);
        await refreshMoviePrecacheButton(movie);
        openPrecacheQueueModal();
    } catch (error) {
        console.error('Pre-cache movie error:', error);
        alert(error.message || 'Could not queue movie for pre-caching.');
    } finally {
        if (dom.precacheMovieBtn) dom.precacheMovieBtn.disabled = false;
    }
}

function setQueueSummary(text = '') {
    if (!dom.cacheQueueSummary) return;
    dom.cacheQueueSummary.textContent = text;
    dom.cacheQueueSummary.classList.toggle('hidden', !text);
}

function renderQueueStatus(status) {
    if (!status) return;

    const isRunning = Boolean(status.running || status.current || status.queued_count > 0);
    dom.navCacheBtn?.classList.toggle('has-active-queue', isRunning);
    dom.cancelPrecacheQueueBtn?.classList.toggle('hidden', !isRunning);

    // Active job card
    if (dom.cacheQueueActive) {
        if (status.current) {
            const pct = Math.max(0, Math.min(100, Math.round(Number(status.current.progress) || 0)));
            dom.cacheQueueActive.classList.remove('hidden');
            if (dom.cacheQueueActiveTitle) {
                dom.cacheQueueActiveTitle.textContent = status.current.title || status.current.filename;
            }
            if (dom.cacheQueueActivePercent) {
                dom.cacheQueueActivePercent.textContent = `${pct}%`;
            }
            if (dom.cacheQueueActiveMeta) {
                const mode = status.current.mode_label || 'Pre-caching...';
                dom.cacheQueueActiveMeta.textContent = `${status.current.variant} • ${mode}`;
            }
            if (dom.cacheQueueActiveBarFill) {
                dom.cacheQueueActiveBarFill.style.width = `${pct}%`;
            }
        } else {
            dom.cacheQueueActive.classList.add('hidden');
        }
    }

    // Pending queue list
    const pending = Array.isArray(status.queued) ? status.queued : [];
    if (dom.cacheQueuePendingSection && dom.cacheQueuePendingList) {
        if (pending.length > 0) {
            dom.cacheQueuePendingSection.classList.remove('hidden');
            if (dom.cacheQueuePendingCount) {
                dom.cacheQueuePendingCount.textContent = String(pending.length);
            }
            dom.cacheQueuePendingList.innerHTML = '';
            pending.forEach((item) => {
                const row = document.createElement('div');
                row.className = 'cache-queue-row';
                row.innerHTML = `
                    <span class="cache-queue-row-title">${item.title}</span>
                    <span class="cache-queue-row-badge">${item.variant}</span>
                `;
                dom.cacheQueuePendingList.appendChild(row);
            });
        } else {
            dom.cacheQueuePendingSection.classList.add('hidden');
            dom.cacheQueuePendingList.innerHTML = '';
        }
    }

    // Recent completed / error items
    const history = Array.isArray(status.history) ? status.history : [];
    if (dom.cacheQueueHistorySection && dom.cacheQueueHistoryList) {
        if (history.length > 0) {
            dom.cacheQueueHistorySection.classList.remove('hidden');
            dom.cacheQueueHistoryList.innerHTML = '';
            history.slice(0, 10).forEach((item) => {
                const row = document.createElement('div');
                row.className = 'cache-queue-row';
                const statusLabel = item.status === 'cached'
                    ? 'Cached'
                    : item.status === 'cancelled'
                        ? 'Cancelled'
                        : 'Error';
                row.innerHTML = `
                    <span class="cache-queue-row-title">${item.title}</span>
                    <span class="cache-queue-row-badge status-${item.status}" title="${item.error || ''}">${statusLabel}</span>
                `;
                dom.cacheQueueHistoryList.appendChild(row);
            });
        } else {
            dom.cacheQueueHistorySection.classList.add('hidden');
            dom.cacheQueueHistoryList.innerHTML = '';
        }
    }

    // Sync Movie Page button if viewing a movie
    if (state.currentPage === 'movie-page' && state.currentMovieId) {
        const activeMovie = state.moviesDatabase.find(
            (m) => String(m.movie_id) === String(state.currentMovieId)
        );
        if (activeMovie) {
            if (status.current && String(status.current.movie_id) === String(activeMovie.movie_id)) {
                setMovieButtonVisual('caching', status.current.progress || 0);
            } else if (pending.some((p) => String(p.movie_id) === String(activeMovie.movie_id))) {
                setMovieButtonVisual('queued');
            }
        }
    }
}

export async function pollPrecacheQueueStatus() {
    if (!state.isAdmin || state.isDemoMode || !state.serverApiToken) return null;
    try {
        const res = await fetch('/api/admin/precache/status', {
            headers: { 'x-api-token': state.serverApiToken }
        });
        if (!res.ok) return null;
        const status = await res.json();
        renderQueueStatus(status);
        return status;
    } catch {
        return null;
    }
}

function stopQueuePolling() {
    if (queuePollTimer) {
        clearInterval(queuePollTimer);
        queuePollTimer = null;
    }
}

function startQueuePolling() {
    stopQueuePolling();
    pollPrecacheQueueStatus();
    queuePollTimer = setInterval(async () => {
        if (!dom.cacheQueueModal || dom.cacheQueueModal.classList.contains('hidden')) {
            stopQueuePolling();
            return;
        }
        await pollPrecacheQueueStatus();
    }, QUEUE_POLL_MS);
}

export function openPrecacheQueueModal() {
    if (!state.isAdmin || state.isDemoMode || !dom.cacheQueueModal) return;
    setQueueSummary('');
    openModal(dom.cacheQueueModal);
    startQueuePolling();
}

export function closePrecacheQueueModal() {
    stopQueuePolling();
    closeModal(dom.cacheQueueModal);
    if (state.currentPage === 'movie-page' && state.currentMovieId) {
        const movie = state.moviesDatabase.find(
            (m) => String(m.movie_id) === String(state.currentMovieId)
        );
        if (movie) refreshMoviePrecacheButton(movie);
    }
}

export async function handleQueueAllUncached() {
    if (!state.isAdmin || state.isDemoMode) return;
    if (dom.queueAllUncachedBtn) {
        dom.queueAllUncachedBtn.disabled = true;
        dom.queueAllUncachedBtn.textContent = 'Scanning...';
    }
    setQueueSummary('Scanning local movie files for uncached videos...');

    try {
        const res = await fetch('/api/admin/precache/queue-all', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                titles: buildTitlesMap(),
                include_mobile_burn: includeMobileBurnSelected()
            })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.detail || 'Could not queue uncached movies.');
        }

        if (data.queue_status) renderQueueStatus(data.queue_status);

        if (data.queued_count > 0) {
            setQueueSummary(
                `Queued ${data.queued_count} uncached video(s). (${data.already_cached_count} already cached/ready)`
            );
        } else if (data.already_queued_count > 0) {
            setQueueSummary(`All uncached videos are already in the queue (${data.already_queued_count}).`);
        } else {
            setQueueSummary(`Everything is already cached or direct-play ready (${data.already_cached_count}).`);
        }
    } catch (error) {
        console.error('Queue all uncached error:', error);
        setQueueSummary(error.message || 'Failed to scan and queue movies.');
    } finally {
        if (dom.queueAllUncachedBtn) {
            dom.queueAllUncachedBtn.disabled = false;
            dom.queueAllUncachedBtn.textContent = 'Queue All Uncached';
        }
    }
}

export async function handleCancelPrecacheQueue() {
    if (!state.isAdmin || state.isDemoMode) return;
    if (dom.cancelPrecacheQueueBtn) dom.cancelPrecacheQueueBtn.disabled = true;

    try {
        const res = await fetch('/api/admin/precache/cancel', {
            method: 'POST',
            headers: { 'x-api-token': state.serverApiToken }
        });
        const data = await res.json().catch(() => ({}));
        if (data.queue_status) renderQueueStatus(data.queue_status);
        setQueueSummary('Pre-cache queue stopped.');
    } catch (error) {
        console.error('Cancel pre-cache queue error:', error);
    } finally {
        if (dom.cancelPrecacheQueueBtn) dom.cancelPrecacheQueueBtn.disabled = false;
    }
}