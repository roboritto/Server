import { state } from './state.js';
import { dom } from './dom.js';
import { parseLinkArray } from './utils.js';
import {
    WATCH_PROGRESS_STORAGE_KEY,
    RESUME_MIN_SECONDS,
    RESUME_COMPLETE_RATIO,
    PROGRESS_SAVE_INTERVAL_MS,
    RESUME_BANNER_HIDE_MS,
    playerState,
    isHttpLink,
    formatVideoTime,
    normalizeLocalPathKey,
    getCurrentPlaybackSeconds
} from './player-state.js';

let resumeBannerTimer = null;

function getWatchProgressStore() {
    try {
        const raw = localStorage.getItem(WATCH_PROGRESS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveWatchProgressStore(store) {
    try {
        localStorage.setItem(WATCH_PROGRESS_STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
        console.warn('Could not save watch progress to localStorage:', error);
    }
}

function getSavedProgressEntry(movieId, filePath) {
    const store = getWatchProgressStore();
    const movieMap = store[String(movieId)];
    if (!movieMap || typeof movieMap !== 'object') return null;
    const entry = movieMap[normalizeLocalPathKey(filePath)];
    if (!entry || typeof entry.position !== 'number') return null;
    return entry;
}

export function getResumeSecondsForSource(movieId, filePath, knownDuration = 0) {
    const entry = getSavedProgressEntry(movieId, filePath);
    if (!entry) return 0;

    const pos = Number(entry.position) || 0;
    const dur = Number(knownDuration) || Number(entry.duration) || 0;
    if (pos < RESUME_MIN_SECONDS) return 0;
    if (dur > 0 && pos / dur >= RESUME_COMPLETE_RATIO) return 0;
    return dur > 0 ? Math.min(pos, Math.max(0, dur - 5)) : pos;
}

function updateLocalWatchProgressCache(movieId, filePath, position, duration) {
    const store = getWatchProgressStore();
    const mKey = String(movieId);
    const pKey = normalizeLocalPathKey(filePath);
    if (!mKey || !pKey) return;

    const pos = Math.max(0, Number(position) || 0);
    const dur = Math.max(0, Number(duration) || 0);
    const shouldClear = pos < RESUME_MIN_SECONDS || (dur > 0 && pos / dur >= RESUME_COMPLETE_RATIO);

    if (shouldClear) {
        if (store[mKey]) {
            delete store[mKey][pKey];
            if (Object.keys(store[mKey]).length === 0) {
                delete store[mKey];
            }
        }
        saveWatchProgressStore(store);
        return;
    }

    if (!store[mKey]) store[mKey] = {};
    store[mKey][pKey] = {
        position: Math.round(pos * 10) / 10,
        duration: Math.round(dur * 10) / 10,
        updated_at: new Date().toISOString()
    };
    saveWatchProgressStore(store);
}

export function updatePlayButtonForMovie(movie) {
    if (!dom.openPlayModalBtn || !movie) return;
    const localPaths = parseLinkArray(movie.link).filter((entry) => !isHttpLink(entry));
    dom.openPlayModalBtn.classList.toggle('hidden', localPaths.length === 0);
    if (localPaths.length === 0) return;

    const labelEl = dom.openPlayModalBtn.querySelector('span');
    let resumeSec = getResumeSecondsForSource(movie.movie_id, localPaths[0]);
    if (resumeSec <= 0 && localPaths.length > 1) {
        for (let i = 1; i < localPaths.length; i++) {
            const candidate = getResumeSecondsForSource(movie.movie_id, localPaths[i]);
            if (candidate > 0) {
                resumeSec = candidate;
                break;
            }
        }
    }

    if (resumeSec > 0) {
        const formatted = formatVideoTime(resumeSec);
        if (labelEl) labelEl.textContent = `Resume (${formatted})`;
        dom.openPlayModalBtn.title = `Resume from ${formatted}`;
    } else {
        if (labelEl) labelEl.textContent = 'Play';
        dom.openPlayModalBtn.title = 'Play Local Video';
    }
}

export function updatePlayButtonForCurrentMovie() {
    if (!state.currentMovieId) return;
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (movie) updatePlayButtonForMovie(movie);
}

export function persistWatchProgress(movieId, filePath, position, duration, { force = false } = {}) {
    if (state.isDemoMode || !movieId || !filePath) return;

    const pos = Math.max(0, Number(position) || 0);
    const dur = Math.max(0, Number(duration) || 0);
    const now = Date.now();

    if (!force) {
        if (now - playerState.lastProgressSaveAt < PROGRESS_SAVE_INTERVAL_MS) return;
        if (Math.abs(pos - playerState.lastSavedPosition) < 2) return;
    }

    playerState.lastProgressSaveAt = now;
    playerState.lastSavedPosition = pos;
    updateLocalWatchProgressCache(movieId, filePath, pos, dur);
}

export function saveCurrentPlaybackProgress(options = {}) {
    if (
        playerState.isLoadingSource ||
        !playerState.movieId ||
        !playerState.filePath ||
        !dom.localVideoPlayer
    ) {
        return;
    }
    const pos = getCurrentPlaybackSeconds();
    const dur = playerState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    persistWatchProgress(playerState.movieId, playerState.filePath, pos, dur, options);
}

export function hideResumeBanner() {
    if (resumeBannerTimer) {
        clearTimeout(resumeBannerTimer);
        resumeBannerTimer = null;
    }
    dom.videoResumeBanner?.classList.add('hidden');
}

export function showResumeBanner(resumeSeconds) {
    if (!dom.videoResumeBanner || !dom.videoResumeText || resumeSeconds < RESUME_MIN_SECONDS) return;
    hideResumeBanner();
    dom.videoResumeText.textContent = `Resumed from ${formatVideoTime(resumeSeconds)}`;
    dom.videoResumeBanner.classList.remove('hidden');
    resumeBannerTimer = setTimeout(() => {
        hideResumeBanner();
    }, RESUME_BANNER_HIDE_MS);
}