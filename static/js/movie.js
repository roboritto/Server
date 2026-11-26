import { state } from './state.js';
import { dom } from './dom.js';
import {
    getHeartSvgMarkup,
    parseCollectionArray,
    parseLinkArray,
    triggerDiceRollAnimation
} from './utils.js';
import { pushCurrentStateToHistory, navigateToPage, openModal, closeModal } from './navigation.js';
import { openPersonPage } from './person.js';

function renderRatingHearts(ratingValue) {
    if (!dom.movieHearts) return;
    dom.movieHearts.innerHTML = '';

    const fullCount = Math.floor(ratingValue);
    const hasHalf = (ratingValue - fullCount) >= 0.5;

    for (let i = 0; i < fullCount; i++) {
        dom.movieHearts.innerHTML += getHeartSvgMarkup('full', `page-full-${i}`);
    }
    if (hasHalf) {
        dom.movieHearts.innerHTML += getHeartSvgMarkup('half', 'page-half');
    }
}

async function handleDownloadCollection(colName, matchingMovies, downloadBtnEl) {
    if (state.isDemoMode) {
        alert('Collection ZIP downloads require the self-hosted Python backend.');
        return;
    }
    if (!colName || !downloadBtnEl) return;

    const btnTextEl = downloadBtnEl.querySelector('.collection-download-btn-text');
    const titlesMap = {};
    const movieOrder = [];

    matchingMovies.forEach((m) => {
        const idStr = String(m.movie_id);
        const yearSuffix = m.release_year ? ` (${m.release_year})` : '';
        titlesMap[idStr] = `${m.title || `Movie_${idStr}`}${yearSuffix}`;
        movieOrder.push(idStr);
    });

    downloadBtnEl.disabled = true;
    if (btnTextEl) btnTextEl.textContent = 'Preparing...';

    try {
        const response = await fetch('/api/collections/download-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                collection: colName,
                titles: titlesMap,
                movie_order: movieOrder
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not prepare collection download.');
        }

        const downloadUrl = `/api/collections/download?ticket=${encodeURIComponent(data.ticket)}`;
        const tempLink = document.createElement('a');
        tempLink.href = downloadUrl;
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();

        if (data.skipped_count > 0) {
            alert(
                `Downloading ${data.downloadable_count} movie(s). ${data.skipped_count} movie(s) could not be direct-downloaded and are listed in _skipped_movies.txt inside the ZIP.`
            );
        }
    } catch (error) {
        console.error('Collection download error:', error);
        alert(error.message || 'Failed to download collection.');
    } finally {
        downloadBtnEl.disabled = false;
        if (btnTextEl) btnTextEl.textContent = 'Download All';
    }
}

export function renderMovieCollections(movie) {
    if (!dom.movieCollectionsContainer) return;
    dom.movieCollectionsContainer.innerHTML = '';

    const collectionNames = parseCollectionArray(movie.collection);
    if (collectionNames.length === 0) return;

    collectionNames.forEach((colName) => {
        const matchingMovies = state.moviesDatabase.filter((m) => {
            const mCols = parseCollectionArray(m.collection).map((c) => c.toLowerCase());
            return mCols.includes(colName.toLowerCase());
        });

        matchingMovies.sort((a, b) => {
            const dateA = a.release_date || '9999-99-99';
            const dateB = b.release_date || '9999-99-99';
            return dateA.localeCompare(dateB);
        });

        const sectionEl = document.createElement('div');
        sectionEl.className = 'movie-collection-block';

        const headerRowEl = document.createElement('div');
        headerRowEl.className = 'collection-header-row';

        const headingEl = document.createElement('h2');
        headingEl.className = 'movie-section-heading';
        headingEl.textContent = colName;
        headerRowEl.appendChild(headingEl);

        const hasAnyLink = matchingMovies.some((m) => (m.link || '').trim().length > 0);
        if (hasAnyLink && state.permissions.download_collection) {
            const downloadAllBtn = document.createElement('button');
            downloadAllBtn.type = 'button';
            downloadAllBtn.className = 'collection-download-btn';
            downloadAllBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span class="collection-download-btn-text">Download All</span>
            `;
            downloadAllBtn.addEventListener('click', () => {
                handleDownloadCollection(colName, matchingMovies, downloadAllBtn);
            });
            headerRowEl.appendChild(downloadAllBtn);
        }

        sectionEl.appendChild(headerRowEl);

        const listEl = document.createElement('div');
        listEl.className = 'collection-list';

        matchingMovies.forEach((colMovie) => {
            const cardEl = document.createElement('div');
            cardEl.className = 'collection-card';
            if (String(colMovie.movie_id) === String(movie.movie_id)) {
                cardEl.classList.add('current-collection-movie');
            }

            const bgImg = colMovie.backdrop_path || colMovie.poster_path;
            if (bgImg) {
                cardEl.style.backgroundImage = `url('${bgImg}')`;
            }

            cardEl.innerHTML = `
                <div class="collection-card-overlay">
                    <div class="collection-card-title">${colMovie.title}</div>
                </div>
            `;

            cardEl.addEventListener('click', () => {
                if (String(colMovie.movie_id) !== String(movie.movie_id)) {
                    openMoviePage(colMovie.movie_id);
                }
            });

            listEl.appendChild(cardEl);
        });

        sectionEl.appendChild(listEl);
        dom.movieCollectionsContainer.appendChild(sectionEl);
    });
}

function isHttpLink(entry) {
    return /^https?:\/\//i.test((entry || '').trim());
}

async function handleDownloadLocalFile(movieId, filePath, btnEl) {
    if (state.isDemoMode) {
        alert('Local file downloads require the self-hosted Python backend.');
        return;
    }

    const labelEl = btnEl?.querySelector('span');
    const originalLabel = labelEl ? labelEl.textContent : '';

    if (btnEl) btnEl.disabled = true;
    if (labelEl) labelEl.textContent = 'Preparing...';

    try {
        const response = await fetch('/api/local-files/download-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: String(movieId),
                path: filePath
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not download local file.');
        }

        const downloadUrl = `/api/local-files/download?ticket=${encodeURIComponent(data.ticket)}`;
        const tempLink = document.createElement('a');
        tempLink.href = downloadUrl;
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();
    } catch (error) {
        console.error('Local file download error:', error);
        alert(error.message || 'Failed to download local file.');
    } finally {
        if (btnEl) btnEl.disabled = false;
        if (labelEl) labelEl.textContent = originalLabel;
    }
}

let activeStreamRequestId = 0;
let activeSubtitleRequestId = 0;
let activeManualSubtitleBlobUrl = null;
let activeHlsInstance = null;
const VIDEO_SEEK_STEP_SECONDS = 10;
const FULLSCREEN_CONTROLS_HIDE_MS = 2500;
const FFMPEG_KEY_SEEK_DEBOUNCE_MS = 350;
const WATCH_PROGRESS_STORAGE_KEY = 'cinema_watch_progress_v1';
const RESUME_MIN_SECONDS = 10;
const RESUME_COMPLETE_RATIO = 0.95;
const PROGRESS_SAVE_INTERVAL_MS = 5000;
const RESUME_BANNER_HIDE_MS = 6000;
let fullscreenControlsTimer = null;
let resumeBannerTimer = null;
let isHoveringVideoControls = false;
let keyboardSeekTimer = null;
let pendingKeyboardSeekTarget = null;
const activeStreamState = {
    movieId: '',
    filePath: '',
    ticket: '',
    mode: 'direct',
    duration: 0,
    seekOffset: 0,
    burnSubTrackIndex: -1,
    selectedSubtitleValue: '',
    audioTracks: [],
    selectedAudioTrackIndex: 0,
    isScrubbing: false,
    isLoadingSource: false,
    lastProgressSaveAt: 0,
    lastSavedPosition: -1,
    serverSubtitles: [],
    manualSubtitles: [] // [{ label, rawText }]
};

const PLAYER_PLAY_SVG = `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <polygon points="6 4 20 12 6 20 6 4"></polygon>
    </svg>
`;
const PLAYER_PAUSE_SVG = `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
    </svg>
`;
const PLAYER_VOL_ON_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    </svg>
`;
const PLAYER_VOL_OFF_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <line x1="23" y1="9" x2="17" y2="15"></line>
        <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
`;

function formatVideoTime(totalSeconds) {
    const secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

function normalizeLocalPathKey(rawPath) {
    let cleaned = String(rawPath || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    while (cleaned.startsWith('./')) {
        cleaned = cleaned.slice(2);
    }
    return cleaned.replace(/^\/+/, '').toLowerCase();
}

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

function getResumeSecondsForSource(movieId, filePath, knownDuration = 0) {
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

function updatePlayButtonForMovie(movie) {
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

function updatePlayButtonForCurrentMovie() {
    if (!state.currentMovieId) return;
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (movie) updatePlayButtonForMovie(movie);
}

function persistWatchProgress(
    movieId,
    filePath,
    position,
    duration,
    { force = false } = {}
) {
    if (state.isDemoMode || !movieId || !filePath) return;

    const pos = Math.max(0, Number(position) || 0);
    const dur = Math.max(0, Number(duration) || 0);
    const now = Date.now();

    if (!force) {
        if (now - activeStreamState.lastProgressSaveAt < PROGRESS_SAVE_INTERVAL_MS) return;
        if (Math.abs(pos - activeStreamState.lastSavedPosition) < 2) return;
    }

    activeStreamState.lastProgressSaveAt = now;
    activeStreamState.lastSavedPosition = pos;
    updateLocalWatchProgressCache(movieId, filePath, pos, dur);
}

function saveCurrentPlaybackProgress(options = {}) {
    if (
        activeStreamState.isLoadingSource ||
        !activeStreamState.movieId ||
        !activeStreamState.filePath ||
        !dom.localVideoPlayer
    ) {
        return;
    }
    const pos = getCurrentPlaybackSeconds();
    const dur = activeStreamState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    persistWatchProgress(activeStreamState.movieId, activeStreamState.filePath, pos, dur, options);
}

function hideResumeBanner() {
    if (resumeBannerTimer) {
        clearTimeout(resumeBannerTimer);
        resumeBannerTimer = null;
    }
    dom.videoResumeBanner?.classList.add('hidden');
}

function showResumeBanner(resumeSeconds) {
    if (!dom.videoResumeBanner || !dom.videoResumeText || resumeSeconds < RESUME_MIN_SECONDS) return;
    hideResumeBanner();
    dom.videoResumeText.textContent = `Resumed from ${formatVideoTime(resumeSeconds)}`;
    dom.videoResumeBanner.classList.remove('hidden');
    resumeBannerTimer = setTimeout(() => {
        hideResumeBanner();
    }, RESUME_BANNER_HIDE_MS);
}

export function handleStartOverClick(event) {
    event?.stopPropagation();
    hideResumeBanner();
    if (!activeStreamState.movieId || !activeStreamState.filePath) return;

    persistWatchProgress(
        activeStreamState.movieId,
        activeStreamState.filePath,
        0,
        activeStreamState.duration,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
    commitVideoSeek(0);
}

export function handleVideoPause() {
    syncVideoControlIcons();
    saveCurrentPlaybackProgress({ force: true });
    updatePlayButtonForCurrentMovie();
}

export function handleVideoEnded() {
    syncVideoControlIcons();
    hideResumeBanner();
    if (!activeStreamState.movieId || !activeStreamState.filePath) return;

    persistWatchProgress(
        activeStreamState.movieId,
        activeStreamState.filePath,
        0,
        activeStreamState.duration,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
}

export function savePlaybackProgressOnExit() {
    if (!dom.videoPlayerModal || dom.videoPlayerModal.classList.contains('hidden')) return;
    saveCurrentPlaybackProgress({ force: true, keepalive: true });
}

function parseSubtitleTimestamp(tsStr) {
    const parts = tsStr.replace(',', '.').split(':');
    if (parts.length === 3) {
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
        return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return 0;
}

function formatVttTimestamp(seconds) {
    const msTotal = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(msTotal / 3600000);
    const m = Math.floor((msTotal % 3600000) / 60000);
    const s = Math.floor((msTotal % 60000) / 1000);
    const ms = msTotal % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function convertSrtToVtt(rawText, offsetSeconds = 0) {
    const timingRe = /^((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)$/;
    const blocks = String(rawText || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim()
        .split(/\n\s*\n/);

    const out = ['WEBVTT', ''];
    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length === 0) continue;
        const firstUpper = lines[0].trim().toUpperCase();
        if (firstUpper.startsWith('WEBVTT') || firstUpper.startsWith('NOTE')) continue;

        const timingIdx = lines.findIndex((l) => timingRe.test(l.trim()));
        if (timingIdx === -1) continue;

        const match = lines[timingIdx].trim().match(timingRe);
        if (!match) continue;

        const start = parseSubtitleTimestamp(match[1]) - offsetSeconds;
        const end = parseSubtitleTimestamp(match[2]) - offsetSeconds;
        if (end <= 0) continue;

        const cueLines = lines.slice(timingIdx + 1);
        if (cueLines.length === 0) continue;

        out.push(`${formatVttTimestamp(Math.max(0, start))} --> ${formatVttTimestamp(end)}${match[3]}`);
        out.push(...cueLines);
        out.push('');
    }
    return out.join('\n');
}

function clearVideoSubtitleTracks() {
    if (activeManualSubtitleBlobUrl) {
        URL.revokeObjectURL(activeManualSubtitleBlobUrl);
        activeManualSubtitleBlobUrl = null;
    }
    if (!dom.localVideoPlayer) return;
    dom.localVideoPlayer.querySelectorAll('track').forEach((t) => t.remove());
}

function isUsingFfmpegPlayback() {
    return (
        activeStreamState.mode === 'ffmpeg' ||
        activeStreamState.burnSubTrackIndex >= 0 ||
        activeStreamState.selectedAudioTrackIndex > 0
    );
}

function getCurrentPlaybackSeconds() {
    if (!dom.localVideoPlayer) return 0;
    const rawTime = dom.localVideoPlayer.currentTime || 0;
    return isUsingFfmpegPlayback() ? activeStreamState.seekOffset + rawTime : rawTime;
}

export function isTracksMenuOpen() {
    return Boolean(dom.videoTracksMenu && !dom.videoTracksMenu.classList.contains('hidden'));
}

export function closeVideoTracksMenu() {
    if (!dom.videoTracksMenu) return;
    dom.videoTracksMenu.classList.add('hidden');
    dom.videoTracksBtn?.setAttribute('aria-expanded', 'false');
    showFullscreenControls();
}

export function toggleVideoTracksMenu(event) {
    event?.stopPropagation();
    if (!dom.videoTracksMenu) return;
    const willOpen = dom.videoTracksMenu.classList.contains('hidden');
    dom.videoTracksMenu.classList.toggle('hidden', !willOpen);
    dom.videoTracksBtn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    dom.videoTracksBtn?.blur();
    showFullscreenControls();
}

export function handleVideoSurfaceClick() {
    if (isTracksMenuOpen()) {
        closeVideoTracksMenu();
        return;
    }
    toggleVideoPlayPause();
}

function createTrackOptionButton(label, isActive, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `video-track-item${isActive ? ' active' : ''}`;
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    btn.textContent = label;
    btn.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return btn;
}

function renderVideoTracksMenu() {
    const hasActiveSub = Boolean(activeStreamState.selectedSubtitleValue);
    dom.videoTracksBtn?.classList.toggle('active', hasActiveSub);

    if (dom.videoSubtitleList) {
        dom.videoSubtitleList.innerHTML = '';

        dom.videoSubtitleList.appendChild(
            createTrackOptionButton('Off', activeStreamState.selectedSubtitleValue === '', () => {
                selectSubtitleTrack('');
            })
        );

        activeStreamState.serverSubtitles.forEach((sub) => {
            const val = `server:${sub.index}`;
            dom.videoSubtitleList.appendChild(
                createTrackOptionButton(
                    sub.label,
                    activeStreamState.selectedSubtitleValue === val,
                    () => selectSubtitleTrack(val)
                )
            );
        });

        activeStreamState.manualSubtitles.forEach((sub, idx) => {
            const val = `manual:${idx}`;
            dom.videoSubtitleList.appendChild(
                createTrackOptionButton(
                    sub.label,
                    activeStreamState.selectedSubtitleValue === val,
                    () => selectSubtitleTrack(val)
                )
            );
        });

        // "Choose subtitle file (.srt / .vtt)" inside the subtitle chooser
        const uploadBtn = document.createElement('button');
        uploadBtn.type = 'button';
        uploadBtn.className = 'video-track-item video-track-upload-btn';
        uploadBtn.textContent = 'Choose subtitle file (.srt / .vtt)';
        uploadBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            closeVideoTracksMenu();
            dom.srtFileInput?.click();
        });
        dom.videoSubtitleList.appendChild(uploadBtn);
    }

    if (dom.videoAudioSection && dom.videoAudioList) {
        dom.videoAudioList.innerHTML = '';
        if (activeStreamState.audioTracks.length > 0) {
            dom.videoAudioSection.classList.remove('hidden');
            activeStreamState.audioTracks.forEach((track) => {
                dom.videoAudioList.appendChild(
                    createTrackOptionButton(
                        track.label,
                        activeStreamState.selectedAudioTrackIndex === track.index,
                        () => selectAudioTrack(track.index)
                    )
                );
            });
        } else {
            dom.videoAudioSection.classList.add('hidden');
        }
    }
}

function mountVttBlobTrack(vttText, trackLabel) {
    clearVideoSubtitleTracks();
    if (!dom.localVideoPlayer || !vttText) return;

    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
    activeManualSubtitleBlobUrl = URL.createObjectURL(blob);

    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = trackLabel || 'Subtitles';
    trackEl.srclang = 'en';
    trackEl.src = activeManualSubtitleBlobUrl;
    trackEl.default = true;

    const enableTrack = () => {
        if (!dom.localVideoPlayer) return;
        const tracks = dom.localVideoPlayer.textTracks;
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = tracks[i] === trackEl.track ? 'showing' : 'disabled';
        }
        if (trackEl.track) {
            trackEl.track.mode = 'showing';
        }
    };

    trackEl.addEventListener('load', enableTrack);
    dom.localVideoPlayer.appendChild(trackEl);
    enableTrack();
    requestAnimationFrame(enableTrack);
}

async function reloadStreamForTrackChange({
    nextBurnIndex = activeStreamState.burnSubTrackIndex,
    nextAudioIndex = activeStreamState.selectedAudioTrackIndex
} = {}) {
    if (!activeStreamState.ticket || !dom.localVideoPlayer) return;

    const resumeAt = getCurrentPlaybackSeconds();
    const wasPaused = dom.localVideoPlayer.paused;
    const requestId = ++activeStreamRequestId;

    activeStreamState.burnSubTrackIndex = nextBurnIndex;
    activeStreamState.selectedAudioTrackIndex = nextAudioIndex;
    clearVideoSubtitleTracks();

    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }

    try {
        dom.localVideoPlayer.pause();

        if (isUsingFfmpegPlayback()) {
            activeStreamState.seekOffset = resumeAt;
            syncSeekBarMetrics(resumeAt, activeStreamState.duration);
            await attachFfmpegStream(activeStreamState.ticket, resumeAt, requestId, true);
            if (wasPaused && requestId === activeStreamRequestId) {
                dom.localVideoPlayer.pause();
                syncVideoControlIcons();
            }
        } else {
            // Returning to direct MP4 playback (track 0 audio, no burned bitmap subtitle)
            destroyActiveHls();
            notifyServerStopStream(activeStreamState.ticket);
            activeStreamState.seekOffset = 0;
            dom.localVideoPlayer.src = `/api/local-files/stream?ticket=${encodeURIComponent(activeStreamState.ticket)}`;
            dom.localVideoPlayer.addEventListener(
                'loadedmetadata',
                () => {
                    if (requestId !== activeStreamRequestId) return;
                    dom.localVideoPlayer.currentTime = resumeAt;
                    applySelectedSubtitleTrack();
                    if (!wasPaused) {
                        dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
                    }
                },
                { once: true }
            );
        }
    } catch (error) {
        if (requestId !== activeStreamRequestId) return;
        console.error('Track switch error:', error);
        if (dom.videoPlayerError) {
            dom.videoPlayerError.textContent = error.message || 'Could not switch audio or subtitle track.';
            dom.videoPlayerError.classList.remove('hidden');
        }
    }
}

async function selectSubtitleTrack(value) {
    activeStreamState.selectedSubtitleValue = value || '';
    renderVideoTracksMenu();
    closeVideoTracksMenu();
    await applySelectedSubtitleTrack();
}

async function selectAudioTrack(audioIndex) {
    if (audioIndex === activeStreamState.selectedAudioTrackIndex) {
        closeVideoTracksMenu();
        return;
    }
    activeStreamState.selectedAudioTrackIndex = audioIndex;
    renderVideoTracksMenu();
    closeVideoTracksMenu();
    await reloadStreamForTrackChange({ nextAudioIndex: audioIndex });
}

async function applySelectedSubtitleTrack() {
    const subReqId = ++activeSubtitleRequestId;
    clearVideoSubtitleTracks();
    if (!dom.localVideoPlayer) return;

    const value = activeStreamState.selectedSubtitleValue;

    if (!value) {
        if (activeStreamState.burnSubTrackIndex >= 0) {
            await reloadStreamForTrackChange({ nextBurnIndex: -1 });
        }
        return;
    }

    if (value.startsWith('server:')) {
        const idx = parseInt(value.slice('server:'.length), 10);
        const sub = activeStreamState.serverSubtitles.find((s) => s.index === idx);
        if (!sub || !activeStreamState.ticket) return;

        if (sub.render_mode === 'burn') {
            if (activeStreamState.burnSubTrackIndex !== idx) {
                await reloadStreamForTrackChange({ nextBurnIndex: idx });
            }
            return;
        }

        if (activeStreamState.burnSubTrackIndex >= 0) {
            await reloadStreamForTrackChange({ nextBurnIndex: -1 });
            return;
        }

        const offset = isUsingFfmpegPlayback() ? activeStreamState.seekOffset : 0;
        const url = `/api/local-files/subtitles?ticket=${encodeURIComponent(activeStreamState.ticket)}&track=${idx}&offset=${offset}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Could not extract embedded subtitle track.');
            const vttText = await res.text();
            if (subReqId !== activeSubtitleRequestId) return;
            mountVttBlobTrack(vttText, sub.label);
        } catch (error) {
            if (subReqId !== activeSubtitleRequestId) return;
            console.error('Embedded subtitle load error:', error);
            if (dom.videoPlayerError) {
                dom.videoPlayerError.textContent = error.message || 'Could not load subtitle track.';
                dom.videoPlayerError.classList.remove('hidden');
            }
        }
        return;
    }

    if (value.startsWith('manual:')) {
        if (activeStreamState.burnSubTrackIndex >= 0) {
            await reloadStreamForTrackChange({ nextBurnIndex: -1 });
            return;
        }
        const idx = parseInt(value.slice('manual:'.length), 10);
        const sub = activeStreamState.manualSubtitles[idx];
        if (!sub) return;
        const offset = isUsingFfmpegPlayback() ? activeStreamState.seekOffset : 0;
        const vtt = convertSrtToVtt(sub.rawText, offset);
        mountVttBlobTrack(vtt, sub.label);
    }
}

function destroyActiveHls() {
    if (activeHlsInstance) {
        activeHlsInstance.destroy();
        activeHlsInstance = null;
    }
}

function notifyServerStopStream(ticket) {
    if (!ticket) return;
    fetch(`/api/local-files/stream-stop?ticket=${encodeURIComponent(ticket)}`, {
        method: 'POST',
        keepalive: true
    }).catch(() => {});
}

function isVideoInFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    return Boolean(
        fsEl &&
        (fsEl === dom.videoPlayerStage || fsEl === dom.localVideoPlayer)
    );
}

function clearFullscreenControlsTimer() {
    if (fullscreenControlsTimer) {
        clearTimeout(fullscreenControlsTimer);
        fullscreenControlsTimer = null;
    }
}

export function showFullscreenControls() {
    clearFullscreenControlsTimer();
    dom.videoPlayerStage?.classList.remove('controls-hidden');

    if (
        !isVideoInFullscreen() ||
        !dom.localVideoPlayer ||
        dom.localVideoPlayer.paused ||
        activeStreamState.isScrubbing ||
        isHoveringVideoControls ||
        isTracksMenuOpen()
    ) {
        return;
    }

    fullscreenControlsTimer = setTimeout(() => {
        if (
            isVideoInFullscreen() &&
            dom.localVideoPlayer &&
            !dom.localVideoPlayer.paused &&
            !activeStreamState.isScrubbing &&
            !isHoveringVideoControls &&
            !isTracksMenuOpen()
        ) {
            dom.videoPlayerStage?.classList.add('controls-hidden');
        }
    }, FULLSCREEN_CONTROLS_HIDE_MS);
}

export function setControlsHoverState(isHovered) {
    isHoveringVideoControls = Boolean(isHovered);
    showFullscreenControls();
}

export function handleFullscreenChange() {
    if (!isVideoInFullscreen()) {
        clearFullscreenControlsTimer();
        isHoveringVideoControls = false;
        dom.videoPlayerStage?.classList.remove('controls-hidden');
        return;
    }
    showFullscreenControls();
}

export function syncVideoControlIcons() {
    if (!dom.localVideoPlayer) return;
    if (dom.videoPlayPauseBtn) {
        dom.videoPlayPauseBtn.innerHTML = dom.localVideoPlayer.paused
            ? PLAYER_PLAY_SVG
            : PLAYER_PAUSE_SVG;
    }
    if (dom.videoMuteBtn) {
        dom.videoMuteBtn.innerHTML = dom.localVideoPlayer.muted
            ? PLAYER_VOL_OFF_SVG
            : PLAYER_VOL_ON_SVG;
    }
    if (isVideoInFullscreen()) {
        showFullscreenControls();
    }
}

function syncSeekBarMetrics(currentSec, totalSec) {
    const safeTotal = Math.max(0, Math.floor(Number(totalSec) || 0));
    const safeCurrent = Math.max(0, Math.min(safeTotal || currentSec, Math.floor(Number(currentSec) || 0)));

    if (dom.videoSeekSlider) {
        dom.videoSeekSlider.max = String(safeTotal);
        dom.videoSeekSlider.value = String(safeCurrent);
    }
    if (dom.videoCurrentTime) {
        dom.videoCurrentTime.textContent = formatVideoTime(safeCurrent);
    }
    if (dom.videoTotalDuration) {
        dom.videoTotalDuration.textContent = formatVideoTime(safeTotal);
    }
}

function stopLocalVideoPlayback() {
    hideResumeBanner();
    clearTimeout(keyboardSeekTimer);
    keyboardSeekTimer = null;
    pendingKeyboardSeekTarget = null;
    clearFullscreenControlsTimer();
    dom.videoPlayerStage?.classList.remove('controls-hidden');
    destroyActiveHls();
    clearVideoSubtitleTracks();
    if (activeStreamState.ticket) {
        notifyServerStopStream(activeStreamState.ticket);
    }
    if (!dom.localVideoPlayer) return;
    dom.localVideoPlayer.onerror = null;
    dom.localVideoPlayer.pause();
    dom.localVideoPlayer.removeAttribute('src');
    dom.localVideoPlayer.load();
    syncVideoControlIcons();
    syncSeekBarMetrics(0, 0);
}

async function attachFfmpegStream(ticket, startSeconds, requestId, ffmpegAvailable) {
    if (!dom.localVideoPlayer) return;
    destroyActiveHls();

    const canNativeHls = Boolean(
        dom.localVideoPlayer.canPlayType('application/vnd.apple.mpegurl')
    );
    const canHlsJs = Boolean(window.Hls && window.Hls.isSupported());

    const burnParam = activeStreamState.burnSubTrackIndex >= 0
        ? `&burn_sub=${activeStreamState.burnSubTrackIndex}`
        : '';
    const audioParam = activeStreamState.selectedAudioTrackIndex > 0
        ? `&audio_track=${activeStreamState.selectedAudioTrackIndex}`
        : '';

    if (canNativeHls || canHlsJs) {
        const hlsRes = await fetch(
            `/api/local-files/hls-start?ticket=${encodeURIComponent(ticket)}&start=${startSeconds}${burnParam}${audioParam}`,
            { method: 'POST' }
        );
        const hlsData = await hlsRes.json().catch(() => ({}));
        if (requestId !== activeStreamRequestId) return;

        if (!hlsRes.ok || !hlsData.playlist_url) {
            throw new Error(hlsData.detail || 'Could not start HLS video stream.');
        }

        if (canHlsJs) {
            const hls = new window.Hls({
                lowLatencyMode: false,
                backBufferLength: 30
            });
            activeHlsInstance = hls;
            hls.on(window.Hls.Events.ERROR, (_event, errData) => {
                if (errData?.fatal && requestId === activeStreamRequestId && dom.videoPlayerError) {
                    dom.videoPlayerError.textContent =
                        'Playback interrupted. Try seeking slightly or downloading the file.';
                    dom.videoPlayerError.classList.remove('hidden');
                }
            });
            hls.loadSource(hlsData.playlist_url);
            hls.attachMedia(dom.localVideoPlayer);
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                if (requestId !== activeStreamRequestId) return;
                applySelectedSubtitleTrack();
                dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
            });
        } else {
            // Native HLS (iOS Firefox / Safari)
            dom.localVideoPlayer.src = hlsData.playlist_url;
            applySelectedSubtitleTrack();
            dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
        }
        return;
    }

    // Offline fallback if hls.js CDN couldn't load on non-Safari browsers
    dom.localVideoPlayer.onerror = () => {
        if (requestId !== activeStreamRequestId || !dom.videoPlayerError) return;
        dom.videoPlayerError.textContent = ffmpegAvailable
            ? 'Your browser could not play this stream directly. Try downloading the file instead.'
            : 'MKV/HEVC playback requires FFmpeg installed on your server (add ffmpeg to PATH or set FFMPEG_PATH in .env).';
        dom.videoPlayerError.classList.remove('hidden');
    };
    dom.localVideoPlayer.src = `/api/local-files/stream?ticket=${encodeURIComponent(ticket)}&start=${startSeconds}${burnParam}${audioParam}`;
    applySelectedSubtitleTrack();
    dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
}

export function handleVideoLoadedMetadata() {
    if (!dom.localVideoPlayer) return;
    if (!isUsingFfmpegPlayback() && Number.isFinite(dom.localVideoPlayer.duration)) {
        activeStreamState.duration = dom.localVideoPlayer.duration;
        syncSeekBarMetrics(dom.localVideoPlayer.currentTime, activeStreamState.duration);
    }
    syncVideoControlIcons();
}

export function handleVideoTimeUpdate() {
    if (activeStreamState.isScrubbing || !dom.localVideoPlayer) return;
    const rawTime = dom.localVideoPlayer.currentTime || 0;
    const currentTotal = isUsingFfmpegPlayback()
        ? activeStreamState.seekOffset + rawTime
        : rawTime;
    const totalDur = activeStreamState.duration || (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    syncSeekBarMetrics(currentTotal, totalDur);

    if (!activeStreamState.isLoadingSource && !dom.localVideoPlayer.paused) {
        persistWatchProgress(
            activeStreamState.movieId,
            activeStreamState.filePath,
            currentTotal,
            totalDur
        );
    }
}

export function handleVideoSeekInput() {
    if (!dom.videoSeekSlider) return;
    activeStreamState.isScrubbing = true;
    showFullscreenControls();
    if (dom.videoCurrentTime) {
        dom.videoCurrentTime.textContent = formatVideoTime(dom.videoSeekSlider.value);
    }
}

async function commitVideoSeek(targetSec) {
    if (!dom.localVideoPlayer) return;

    hideResumeBanner();

    const totalDur = activeStreamState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    const clampedSec = Math.max(0, totalDur > 0 ? Math.min(totalDur, targetSec) : targetSec);

    persistWatchProgress(
        activeStreamState.movieId,
        activeStreamState.filePath,
        clampedSec,
        totalDur,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
    
    if (!isUsingFfmpegPlayback()) {
        dom.localVideoPlayer.currentTime = clampedSec;
        syncSeekBarMetrics(clampedSec, totalDur);
        return;
    }

    if (!activeStreamState.ticket) return;
    const requestId = ++activeStreamRequestId;
    activeStreamState.seekOffset = clampedSec;
    syncSeekBarMetrics(clampedSec, activeStreamState.duration);

    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }

    try {
        dom.localVideoPlayer.pause();
        await attachFfmpegStream(activeStreamState.ticket, clampedSec, requestId, true);
    } catch (error) {
        if (requestId !== activeStreamRequestId) return;
        console.error('Seek error:', error);
        if (dom.videoPlayerError) {
            dom.videoPlayerError.textContent = error.message || 'Could not seek video.';
            dom.videoPlayerError.classList.remove('hidden');
        }
    }
}

export async function handleVideoSeekCommit() {
    activeStreamState.isScrubbing = false;
    showFullscreenControls();
    if (!dom.videoSeekSlider || !dom.localVideoPlayer) return;

    clearTimeout(keyboardSeekTimer);
    keyboardSeekTimer = null;
    pendingKeyboardSeekTarget = null;

    const targetSec = Math.max(0, Number(dom.videoSeekSlider.value) || 0);
    dom.videoSeekSlider.blur();
    await commitVideoSeek(targetSec);
}

function seekVideoByDelta(deltaSeconds) {
    if (!dom.localVideoPlayer) return;

    const totalDur = activeStreamState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);

    const currentPos = isUsingFfmpegPlayback()
        ? (pendingKeyboardSeekTarget !== null
            ? pendingKeyboardSeekTarget
            : activeStreamState.seekOffset + (dom.localVideoPlayer.currentTime || 0))
        : (dom.localVideoPlayer.currentTime || 0);

    const nextTarget = Math.max(
        0,
        totalDur > 0 ? Math.min(totalDur, currentPos + deltaSeconds) : currentPos + deltaSeconds
    );

    if (!isUsingFfmpegPlayback()) {
        commitVideoSeek(nextTarget);
        return;
    }

    // Debounce rapid ArrowLeft/ArrowRight taps in FFmpeg HLS mode
    pendingKeyboardSeekTarget = nextTarget;
    syncSeekBarMetrics(nextTarget, totalDur);
    clearTimeout(keyboardSeekTimer);
    keyboardSeekTimer = setTimeout(() => {
        const finalTarget = pendingKeyboardSeekTarget;
        pendingKeyboardSeekTarget = null;
        keyboardSeekTimer = null;
        if (finalTarget !== null) {
            commitVideoSeek(finalTarget);
        }
    }, FFMPEG_KEY_SEEK_DEBOUNCE_MS);
}

export function toggleVideoPlayPause() {
    if (!dom.localVideoPlayer) return;
    if (dom.localVideoPlayer.paused) {
        dom.localVideoPlayer.play().catch(() => {});
    } else {
        dom.localVideoPlayer.pause();
    }
    syncVideoControlIcons();
    showFullscreenControls();
}

export function toggleVideoMute() {
    if (!dom.localVideoPlayer) return;
    dom.localVideoPlayer.muted = !dom.localVideoPlayer.muted;
    syncVideoControlIcons();
    showFullscreenControls();
}

export function toggleVideoFullscreen() {
    const stage = dom.videoPlayerStage;
    const video = dom.localVideoPlayer;
    if (!stage || !video) return;

    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        return;
    }

    if (stage.requestFullscreen) {
        stage.requestFullscreen().catch(() => {
            video.webkitEnterFullscreen?.();
        });
    } else if (stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
    }
}

export function handleVideoPlayerKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const activeEl = document.activeElement;
    if (
        activeEl &&
        (activeEl.tagName === 'TEXTAREA' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.isContentEditable ||
            (activeEl.tagName === 'INPUT' && activeEl.type !== 'range'))
    ) {
        return;
    }

    const key = event.key;
    if (event.code === 'Space' || key === ' ') {
        event.preventDefault();
        toggleVideoPlayPause();
    } else if (key === 'ArrowLeft') {
        event.preventDefault();
        seekVideoByDelta(-VIDEO_SEEK_STEP_SECONDS);
        showFullscreenControls();
    } else if (key === 'ArrowRight') {
        event.preventDefault();
        seekVideoByDelta(VIDEO_SEEK_STEP_SECONDS);
        showFullscreenControls();
    } else if (key === 'f' || key === 'F') {
        event.preventDefault();
        toggleVideoFullscreen();
        showFullscreenControls();
    } else if (key === 'm' || key === 'M') {
        event.preventDefault();
        toggleVideoMute();
    }
}

export async function handleManualSrtUpload(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
        const rawText = await file.text();
        const label = file.name.replace(/\.(srt|vtt)$/i, '');
        const newIdx = activeStreamState.manualSubtitles.push({ label, rawText }) - 1;
        activeStreamState.selectedSubtitleValue = `manual:${newIdx}`;
        renderVideoTracksMenu();
        await applySelectedSubtitleTrack();
    } catch (error) {
        console.error('Could not read subtitle file:', error);
        alert('Could not read the selected subtitle file.');
    } finally {
        if (dom.srtFileInput) dom.srtFileInput.value = '';
    }
}

async function loadLocalVideoSource(movieId, filePath) {
    if (!dom.localVideoPlayer) return;

    // Save current source's spot before switching videos
    if (activeStreamState.movieId && activeStreamState.filePath) {
        saveCurrentPlaybackProgress({ force: true });
    }

    const requestId = ++activeStreamRequestId;
    activeStreamState.isLoadingSource = true;
    stopLocalVideoPlayback();
    closeVideoTracksMenu();
    activeStreamState.movieId = String(movieId);
    activeStreamState.filePath = filePath;
    activeStreamState.ticket = '';
    activeStreamState.mode = 'direct';
    activeStreamState.duration = 0;
    activeStreamState.burnSubTrackIndex = -1;
    activeStreamState.selectedSubtitleValue = '';
    activeStreamState.audioTracks = [];
    activeStreamState.selectedAudioTrackIndex = 0;
    activeStreamState.isScrubbing = false;
    activeStreamState.lastProgressSaveAt = 0;
    activeStreamState.lastSavedPosition = -1;
    activeStreamState.serverSubtitles = [];
    renderVideoTracksMenu();

    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }

    try {
        const response = await fetch('/api/local-files/stream-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': state.serverApiToken
            },
            body: JSON.stringify({
                movie_id: String(movieId),
                path: filePath
            })
        });

        const data = await response.json().catch(() => ({}));
        if (requestId !== activeStreamRequestId) return;

        if (!response.ok) {
            throw new Error(data.detail || 'Could not start video stream.');
        }

        activeStreamState.ticket = data.ticket;
        activeStreamState.mode = data.mode || 'direct';
        activeStreamState.duration = Number(data.duration) || 0;
        activeStreamState.seekOffset = 0;
        activeStreamState.serverSubtitles = Array.isArray(data.subtitles) ? data.subtitles : [];
        activeStreamState.audioTracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : [];
        activeStreamState.selectedAudioTrackIndex = 0;

        const resumeAt = getResumeSecondsForSource(movieId, filePath, activeStreamState.duration);
        activeStreamState.seekOffset = activeStreamState.mode === 'ffmpeg' ? resumeAt : 0;
        syncSeekBarMetrics(resumeAt, activeStreamState.duration);

        const defaultSidecar = activeStreamState.serverSubtitles.find(
            (sub) => sub.source === 'file'
        );
        activeStreamState.selectedSubtitleValue = defaultSidecar ? `server:${defaultSidecar.index}` : '';
        renderVideoTracksMenu();

        if (activeStreamState.mode === 'ffmpeg') {
            await attachFfmpegStream(data.ticket, resumeAt, requestId, Boolean(data.ffmpeg_available));
            if (requestId !== activeStreamRequestId) return;
            activeStreamState.isLoadingSource = false;
            if (resumeAt > 0) {
                showResumeBanner(resumeAt);
            }
        } else {
            dom.localVideoPlayer.onerror = () => {
                if (requestId !== activeStreamRequestId || !dom.videoPlayerError) return;
                activeStreamState.isLoadingSource = false;
                dom.videoPlayerError.textContent =
                    'Your browser could not play this video format directly. Try downloading the file instead.';
                dom.videoPlayerError.classList.remove('hidden');
            };
            dom.localVideoPlayer.src = `/api/local-files/stream?ticket=${encodeURIComponent(data.ticket)}`;
            applySelectedSubtitleTrack();

            if (resumeAt > 0) {
                dom.localVideoPlayer.addEventListener(
                    'loadedmetadata',
                    () => {
                        if (requestId !== activeStreamRequestId) return;
                        const mediaDur = Number.isFinite(dom.localVideoPlayer.duration)
                            ? dom.localVideoPlayer.duration
                            : activeStreamState.duration;
                        const safeResume = mediaDur > 0 && resumeAt / mediaDur < RESUME_COMPLETE_RATIO
                            ? Math.min(resumeAt, Math.max(0, mediaDur - 5))
                            : 0;
                        if (safeResume >= RESUME_MIN_SECONDS) {
                            dom.localVideoPlayer.currentTime = safeResume;
                            syncSeekBarMetrics(safeResume, mediaDur);
                            showResumeBanner(safeResume);
                        }
                        activeStreamState.isLoadingSource = false;
                        dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
                    },
                    { once: true }
                );
            } else {
                activeStreamState.isLoadingSource = false;
                dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
            }
        }
    } catch (error) {
        if (requestId !== activeStreamRequestId) return;
        activeStreamState.isLoadingSource = false;
        console.error('Local video stream error:', error);
        if (dom.videoPlayerError) {
            dom.videoPlayerError.textContent = error.message || 'Failed to load local video.';
            dom.videoPlayerError.classList.remove('hidden');
        }
    }
}

export function openVideoPlayerForCurrentMovie() {
    if (state.isDemoMode) {
        alert('Local video playback requires the self-hosted Python backend.');
        return;
    }
    if (!state.currentMovieId || !dom.videoPlayerModal) return;

    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(state.currentMovieId));
    if (!movie) return;

    const localPaths = parseLinkArray(movie.link).filter((entry) => !isHttpLink(entry));
    if (localPaths.length === 0) return;

    activeStreamState.manualSubtitles = [];

    if (dom.videoPlayerTitle) {
        dom.videoPlayerTitle.textContent = movie.title || `Movie #${movie.movie_id}`;
    }

    if (dom.videoPlayerSources) {
        dom.videoPlayerSources.innerHTML = '';
        if (localPaths.length > 1) {
            dom.videoPlayerSources.classList.remove('hidden');
            localPaths.forEach((relPath, idx) => {
                const fileName = relPath.split(/[\\/]/).pop() || `Video ${idx + 1}`;
                const pillBtn = document.createElement('button');
                pillBtn.type = 'button';
                pillBtn.className = `video-source-pill${idx === 0 ? ' active' : ''}`;
                pillBtn.textContent = `Video ${idx + 1}`;
                pillBtn.title = fileName;
                pillBtn.addEventListener('click', () => {
                    dom.videoPlayerSources
                        .querySelectorAll('.video-source-pill')
                        .forEach((btn) => btn.classList.remove('active'));
                    pillBtn.classList.add('active');
                    loadLocalVideoSource(movie.movie_id, relPath);
                });
                dom.videoPlayerSources.appendChild(pillBtn);
            });
        } else {
            dom.videoPlayerSources.classList.add('hidden');
        }
    }

    openModal(dom.videoPlayerModal);
    loadLocalVideoSource(movie.movie_id, localPaths[0]);
}

export function closeVideoPlayerModal() {
    saveCurrentPlaybackProgress({ force: true, keepalive: true });
    activeStreamRequestId++;
    activeStreamState.isLoadingSource = false;
    if (isVideoInFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    stopLocalVideoPlayback();
    activeStreamState.movieId = '';
    activeStreamState.filePath = '';
    activeStreamState.ticket = '';
    activeStreamState.mode = 'direct';
    activeStreamState.duration = 0;
    activeStreamState.seekOffset = 0;
    activeStreamState.burnSubTrackIndex = -1;
    activeStreamState.selectedSubtitleValue = '';
    activeStreamState.audioTracks = [];
    activeStreamState.selectedAudioTrackIndex = 0;
    activeStreamState.isScrubbing = false;
    activeStreamState.lastProgressSaveAt = 0;
    activeStreamState.lastSavedPosition = -1;
    activeStreamState.serverSubtitles = [];
    activeStreamState.manualSubtitles = [];
    closeVideoTracksMenu();
    renderVideoTracksMenu();
    if (dom.srtFileInput) dom.srtFileInput.value = '';
    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }
    updatePlayButtonForCurrentMovie();
    closeModal(dom.videoPlayerModal);
}

export function openMoviePage(movieId, recordHistory = true) {
    const movie = state.moviesDatabase.find((m) => String(m.movie_id) === String(movieId));
    if (!movie || !dom.moviePage) return;

    updateHideMovieButtonState(Boolean(movie.is_hidden));

    if (recordHistory && (state.currentPage !== 'movie-page' || String(state.currentMovieId) !== String(movieId))) {
        pushCurrentStateToHistory();
    }

    state.currentMovieId = String(movie.movie_id);
    
    // 1. Standardized Backdrop Image
    const backdropUrl = movie.backdrop_path || movie.poster_path || '';
    if (dom.movieBackdropImage) {
        dom.movieBackdropImage.style.backgroundImage = backdropUrl ? `url('${backdropUrl}')` : 'none';
    }

    // 2. Release Year & Title
    if (dom.movieReleaseYear) {
        dom.movieReleaseYear.textContent = movie.release_year || '';
        dom.movieReleaseYear.classList.toggle('hidden', !movie.release_year);
    }
    if (dom.movieTitle) dom.movieTitle.textContent = movie.title;

    // 3. Clickable Director(s)
    if (dom.movieDirectors) {
        dom.movieDirectors.innerHTML = '';
        if (movie.directors && movie.directors.length > 0) {
            const prefix = document.createElement('span');
            prefix.textContent = 'Directed by ';
            dom.movieDirectors.appendChild(prefix);

            movie.directors.forEach((dir, index) => {
                const dirSpan = document.createElement('span');
                dirSpan.className = 'director-link';
                dirSpan.textContent = dir.name;
                dirSpan.addEventListener('click', () => {
                    openPersonPage(dir.id || dir.name);
                });
                dom.movieDirectors.appendChild(dirSpan);

                if (index < movie.directors.length - 1) {
                    const comma = document.createElement('span');
                    comma.textContent = ', ';
                    dom.movieDirectors.appendChild(comma);
                }
            });
        }
    }

    // 4. Rating Hearts & Last Watch
    const numericRating = parseFloat(movie.rating) || 0;
    if (dom.movieRatingRow && dom.movieHearts && dom.movieLastWatch) {
        if (numericRating > 0) {
            renderRatingHearts(numericRating);
            dom.movieLastWatch.textContent = movie.last_watch || '';
            dom.movieRatingRow.classList.remove('hidden');
        } else {
            dom.movieRatingRow.classList.add('hidden');
            dom.movieHearts.innerHTML = '';
            dom.movieLastWatch.textContent = '';
        }
    }

    // 5. Synopsis
    if (dom.movieSynopsis) {
        dom.movieSynopsis.textContent = movie.overview || 'No synopsis available.';
    }

    // 6. Download Links & Play Button (Populated inside #download-modal-links)
    const links = parseLinkArray(movie.link);
    updatePlayButtonForMovie(movie);

    if (dom.downloadModalLinks && dom.openDownloadModalBtn) {
        dom.downloadModalLinks.innerHTML = '';

        if (links.length > 0) {
            dom.openDownloadModalBtn.classList.remove('hidden');
            links.forEach((entry, idx) => {
                const isUrl = isHttpLink(entry);
                const baseLabel = links.length > 1 ? `Download ${idx + 1}` : 'Download';

                if (isUrl) {
                    const linkBtn = document.createElement('a');
                    linkBtn.href = entry;
                    linkBtn.target = '_blank';
                    linkBtn.rel = 'noopener noreferrer';
                    linkBtn.className = 'download-link-btn';
                    linkBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>${baseLabel}</span>
                    `;
                    dom.downloadModalLinks.appendChild(linkBtn);
                } else {
                    const localBtn = document.createElement('button');
                    localBtn.type = 'button';
                    localBtn.className = 'download-link-btn';
                    localBtn.title = entry; // Still shows the filename on hover
                    localBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>${baseLabel}</span>
                    `;
                    localBtn.addEventListener('click', () => {
                        handleDownloadLocalFile(movie.movie_id, entry, localBtn);
                    });
                    dom.downloadModalLinks.appendChild(localBtn);
                }
            });
        } else {
            dom.openDownloadModalBtn.classList.add('hidden');
        }
    }

    // 7. Cast List
    if (dom.movieCastList) {
        dom.movieCastList.innerHTML = '';
        (movie.cast || []).forEach((actor) => {
            const card = document.createElement('div');
            card.className = 'cast-card';

            const imgHtml = actor.profile_path
                ? `<img src="${actor.profile_path}" alt="${actor.name}" class="cast-card-img">`
                : `<div class="cast-card-placeholder">No Photo</div>`;

            card.innerHTML = `
                ${imgHtml}
                <div class="cast-card-info">
                    <div class="cast-card-name" title="${actor.name}">${actor.name}</div>
                    <div class="cast-card-character" title="${actor.character || ''}">${actor.character || ''}</div>
                </div>
            `;

            card.addEventListener('click', () => {
                openPersonPage(actor.id || actor.name);
            });

            dom.movieCastList.appendChild(card);
        });
    }

    // 8. Collections
    renderMovieCollections(movie);

    // 9. Switch View
    navigateToPage('movie-page', null, false);
}

export function openRandomMoviePage() {
    if (state.moviesDatabase.length === 0) return;
    triggerDiceRollAnimation(dom.navRandomBtn);

    let pool = state.moviesDatabase;
    if (state.currentPage === 'movie-page' && state.currentMovieId && state.moviesDatabase.length > 1) {
        pool = state.moviesDatabase.filter((m) => String(m.movie_id) !== String(state.currentMovieId));
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    openMoviePage(pool[randomIndex].movie_id);
}

const EYE_VISIBLE_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
`;

const EYE_HIDDEN_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>
`;

function updateHideMovieButtonState(isHidden) {
    if (!dom.hideMovieBtn) return;
    dom.hideMovieBtn.classList.toggle('is-hidden-movie', Boolean(isHidden));
    dom.hideMovieBtn.innerHTML = isHidden ? EYE_HIDDEN_SVG : EYE_VISIBLE_SVG;
    const label = isHidden
        ? 'Hidden from public (click to unhide)'
        : 'Hide movie from public';
    dom.hideMovieBtn.title = label;
    dom.hideMovieBtn.setAttribute('aria-label', label);
}

export async function handleToggleHideMovie() {
    if (!state.isAdmin || state.isDemoMode || !state.currentMovieId) return;

    const targetId = String(state.currentMovieId);
    if (dom.hideMovieBtn) dom.hideMovieBtn.disabled = true;

    try {
        const response = await fetch(`/api/movies/${targetId}/toggle-hide`, {
            method: 'POST',
            headers: { 'x-api-token': state.serverApiToken }
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || 'Could not update movie visibility');
        }

        const isNowHidden = Boolean(data.is_hidden);
        const movie = state.moviesDatabase.find((m) => String(m.movie_id) === targetId);
        if (movie) movie.is_hidden = isNowHidden;

        const rawRow = state.rawCsvMovies.find((r) => String(r.movie_id) === targetId);
        if (rawRow) rawRow.is_hidden = isNowHidden;

        updateHideMovieButtonState(isNowHidden);
    } catch (error) {
        console.error('Error toggling movie visibility:', error);
        alert(error.message || 'Failed to update movie visibility.');
    } finally {
        if (dom.hideMovieBtn) dom.hideMovieBtn.disabled = false;
    }
}