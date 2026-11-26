import { state } from './state.js';
import { dom } from './dom.js';
import { parseLinkArray } from './utils.js';
import { openModal, closeModal } from './navigation.js';
import {
    VIDEO_SEEK_STEP_SECONDS,
    FULLSCREEN_CONTROLS_HIDE_MS,
    FFMPEG_KEY_SEEK_DEBOUNCE_MS,
    RESUME_MIN_SECONDS,
    RESUME_COMPLETE_RATIO,
    PLAYER_PLAY_SVG,
    PLAYER_PAUSE_SVG,
    PLAYER_VOL_ON_SVG,
    PLAYER_VOL_OFF_SVG,
    playerState,
    isHttpLink,
    formatVideoTime,
    isUsingFfmpegPlayback,
    getCurrentPlaybackSeconds,
    syncSeekBarMetrics
} from './player-state.js';
import {
    getResumeSecondsForSource,
    updatePlayButtonForMovie,
    updatePlayButtonForCurrentMovie,
    persistWatchProgress,
    saveCurrentPlaybackProgress,
    hideResumeBanner,
    showResumeBanner
} from './player-progress.js';
import {
    initTrackCallbacks,
    clearVideoSubtitleTracks,
    isTracksMenuOpen,
    closeVideoTracksMenu,
    toggleVideoTracksMenu,
    renderVideoTracksMenu,
    applySelectedSubtitleTrack,
    handleManualSrtUpload
} from './player-tracks.js';

// Re-export so main.js and movie.js keep importing everything from ./player.js
export {
    updatePlayButtonForMovie,
    isTracksMenuOpen,
    closeVideoTracksMenu,
    toggleVideoTracksMenu,
    handleManualSrtUpload
};

let activeHlsInstance = null;
let fullscreenControlsTimer = null;
let isHoveringVideoControls = false;
let keyboardSeekTimer = null;
let pendingKeyboardSeekTarget = null;

initTrackCallbacks({
    onReloadStream: reloadStreamForTrackChange,
    onControlsActivity: showFullscreenControls
});

// --- HLS & Stream Lifecycle ---
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

function stopLocalVideoPlayback() {
    hideResumeBanner();
    clearTimeout(keyboardSeekTimer);
    keyboardSeekTimer = null;
    pendingKeyboardSeekTarget = null;
    clearFullscreenControlsTimer();
    dom.videoPlayerStage?.classList.remove('controls-hidden');
    destroyActiveHls();
    clearVideoSubtitleTracks();
    if (playerState.ticket) {
        notifyServerStopStream(playerState.ticket);
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

    const burnParam = playerState.burnSubTrackIndex >= 0
        ? `&burn_sub=${playerState.burnSubTrackIndex}`
        : '';
    const audioParam = playerState.selectedAudioTrackIndex > 0
        ? `&audio_track=${playerState.selectedAudioTrackIndex}`
        : '';

    if (canNativeHls || canHlsJs) {
        const hlsRes = await fetch(
            `/api/local-files/hls-start?ticket=${encodeURIComponent(ticket)}&start=${startSeconds}${burnParam}${audioParam}`,
            { method: 'POST' }
        );
        const hlsData = await hlsRes.json().catch(() => ({}));
        if (requestId !== playerState.streamRequestId) return;

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
                if (errData?.fatal && requestId === playerState.streamRequestId && dom.videoPlayerError) {
                    dom.videoPlayerError.textContent =
                        'Playback interrupted. Try seeking slightly or downloading the file.';
                    dom.videoPlayerError.classList.remove('hidden');
                }
            });
            hls.loadSource(hlsData.playlist_url);
            hls.attachMedia(dom.localVideoPlayer);
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                if (requestId !== playerState.streamRequestId) return;
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
        if (requestId !== playerState.streamRequestId || !dom.videoPlayerError) return;
        dom.videoPlayerError.textContent = ffmpegAvailable
            ? 'Your browser could not play this stream directly. Try downloading the file instead.'
            : 'MKV/HEVC playback requires FFmpeg installed on your server (add ffmpeg to PATH or set FFMPEG_PATH in .env).';
        dom.videoPlayerError.classList.remove('hidden');
    };
    dom.localVideoPlayer.src = `/api/local-files/stream?ticket=${encodeURIComponent(ticket)}&start=${startSeconds}${burnParam}${audioParam}`;
    applySelectedSubtitleTrack();
    dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
}

async function reloadStreamForTrackChange({
    nextBurnIndex = playerState.burnSubTrackIndex,
    nextAudioIndex = playerState.selectedAudioTrackIndex
} = {}) {
    if (!playerState.ticket || !dom.localVideoPlayer) return;

    const resumeAt = getCurrentPlaybackSeconds();
    const wasPaused = dom.localVideoPlayer.paused;
    const requestId = ++playerState.streamRequestId;

    playerState.burnSubTrackIndex = nextBurnIndex;
    playerState.selectedAudioTrackIndex = nextAudioIndex;
    clearVideoSubtitleTracks();

    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }

    try {
        dom.localVideoPlayer.pause();

        if (isUsingFfmpegPlayback()) {
            playerState.seekOffset = resumeAt;
            syncSeekBarMetrics(resumeAt, playerState.duration);
            await attachFfmpegStream(playerState.ticket, resumeAt, requestId, true);
            if (wasPaused && requestId === playerState.streamRequestId) {
                dom.localVideoPlayer.pause();
                syncVideoControlIcons();
            }
        } else {
            destroyActiveHls();
            notifyServerStopStream(playerState.ticket);
            playerState.seekOffset = 0;
            dom.localVideoPlayer.src = `/api/local-files/stream?ticket=${encodeURIComponent(playerState.ticket)}`;
            dom.localVideoPlayer.addEventListener(
                'loadedmetadata',
                () => {
                    if (requestId !== playerState.streamRequestId) return;
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
        if (requestId !== playerState.streamRequestId) return;
        console.error('Track switch error:', error);
        if (dom.videoPlayerError) {
            dom.videoPlayerError.textContent = error.message || 'Could not switch audio or subtitle track.';
            dom.videoPlayerError.classList.remove('hidden');
        }
    }
}

// --- Fullscreen Auto-Hide & Control Icons ---
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
        playerState.isScrubbing ||
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
            !playerState.isScrubbing &&
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

// --- Transport, Seeking & Keyboard Shortcuts ---
export function handleVideoSurfaceClick() {
    if (isTracksMenuOpen()) {
        closeVideoTracksMenu();
        return;
    }
    toggleVideoPlayPause();
}

export function handleVideoLoadedMetadata() {
    if (!dom.localVideoPlayer) return;
    if (!isUsingFfmpegPlayback() && Number.isFinite(dom.localVideoPlayer.duration)) {
        playerState.duration = dom.localVideoPlayer.duration;
        syncSeekBarMetrics(dom.localVideoPlayer.currentTime, playerState.duration);
    }
    syncVideoControlIcons();
}

export function handleVideoTimeUpdate() {
    if (playerState.isScrubbing || !dom.localVideoPlayer) return;
    const rawTime = dom.localVideoPlayer.currentTime || 0;
    const currentTotal = isUsingFfmpegPlayback()
        ? playerState.seekOffset + rawTime
        : rawTime;
    const totalDur = playerState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    syncSeekBarMetrics(currentTotal, totalDur);

    if (!playerState.isLoadingSource && !dom.localVideoPlayer.paused) {
        persistWatchProgress(
            playerState.movieId,
            playerState.filePath,
            currentTotal,
            totalDur
        );
    }
}

export function handleVideoPause() {
    syncVideoControlIcons();
    saveCurrentPlaybackProgress({ force: true });
    updatePlayButtonForCurrentMovie();
}

export function handleVideoEnded() {
    syncVideoControlIcons();
    hideResumeBanner();
    if (!playerState.movieId || !playerState.filePath) return;

    persistWatchProgress(
        playerState.movieId,
        playerState.filePath,
        0,
        playerState.duration,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
}

export function handleStartOverClick(event) {
    event?.stopPropagation();
    hideResumeBanner();
    if (!playerState.movieId || !playerState.filePath) return;

    persistWatchProgress(
        playerState.movieId,
        playerState.filePath,
        0,
        playerState.duration,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
    commitVideoSeek(0);
}

export function savePlaybackProgressOnExit() {
    if (!dom.videoPlayerModal || dom.videoPlayerModal.classList.contains('hidden')) return;
    saveCurrentPlaybackProgress({ force: true });
}

export function handleVideoSeekInput() {
    if (!dom.videoSeekSlider) return;
    playerState.isScrubbing = true;
    showFullscreenControls();
    if (dom.videoCurrentTime) {
        dom.videoCurrentTime.textContent = formatVideoTime(dom.videoSeekSlider.value);
    }
}

async function commitVideoSeek(targetSec) {
    if (!dom.localVideoPlayer) return;

    hideResumeBanner();

    const totalDur = playerState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);
    const clampedSec = Math.max(0, totalDur > 0 ? Math.min(totalDur, targetSec) : targetSec);

    persistWatchProgress(
        playerState.movieId,
        playerState.filePath,
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

    if (!playerState.ticket) return;
    const requestId = ++playerState.streamRequestId;
    playerState.seekOffset = clampedSec;
    syncSeekBarMetrics(clampedSec, playerState.duration);

    if (dom.videoPlayerError) {
        dom.videoPlayerError.textContent = '';
        dom.videoPlayerError.classList.add('hidden');
    }

    try {
        dom.localVideoPlayer.pause();
        await attachFfmpegStream(playerState.ticket, clampedSec, requestId, true);
    } catch (error) {
        if (requestId !== playerState.streamRequestId) return;
        console.error('Seek error:', error);
        if (dom.videoPlayerError) {
            dom.videoPlayerError.textContent = error.message || 'Could not seek video.';
            dom.videoPlayerError.classList.remove('hidden');
        }
    }
}

export async function handleVideoSeekCommit() {
    playerState.isScrubbing = false;
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

    const totalDur = playerState.duration ||
        (Number.isFinite(dom.localVideoPlayer.duration) ? dom.localVideoPlayer.duration : 0);

    const currentPos = isUsingFfmpegPlayback()
        ? (pendingKeyboardSeekTarget !== null
            ? pendingKeyboardSeekTarget
            : playerState.seekOffset + (dom.localVideoPlayer.currentTime || 0))
        : (dom.localVideoPlayer.currentTime || 0);

    const nextTarget = Math.max(
        0,
        totalDur > 0 ? Math.min(totalDur, currentPos + deltaSeconds) : currentPos + deltaSeconds
    );

    if (!isUsingFfmpegPlayback()) {
        commitVideoSeek(nextTarget);
        return;
    }

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

// --- Modal Lifecycle & Source Loading ---
async function loadLocalVideoSource(movieId, filePath) {
    if (!dom.localVideoPlayer) return;

    if (playerState.movieId && playerState.filePath) {
        saveCurrentPlaybackProgress({ force: true });
    }

    const requestId = ++playerState.streamRequestId;
    playerState.isLoadingSource = true;
    stopLocalVideoPlayback();
    closeVideoTracksMenu();
    playerState.movieId = String(movieId);
    playerState.filePath = filePath;
    playerState.ticket = '';
    playerState.mode = 'direct';
    playerState.duration = 0;
    playerState.seekOffset = 0;
    playerState.burnSubTrackIndex = -1;
    playerState.selectedSubtitleValue = '';
    playerState.audioTracks = [];
    playerState.selectedAudioTrackIndex = 0;
    playerState.isScrubbing = false;
    playerState.lastProgressSaveAt = 0;
    playerState.lastSavedPosition = -1;
    playerState.serverSubtitles = [];
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
        if (requestId !== playerState.streamRequestId) return;

        if (!response.ok) {
            throw new Error(data.detail || 'Could not start video stream.');
        }

        playerState.ticket = data.ticket;
        playerState.mode = data.mode || 'direct';
        playerState.duration = Number(data.duration) || 0;
        playerState.serverSubtitles = Array.isArray(data.subtitles) ? data.subtitles : [];
        playerState.audioTracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : [];
        playerState.selectedAudioTrackIndex = 0;

        const resumeAt = getResumeSecondsForSource(movieId, filePath, playerState.duration);
        playerState.seekOffset = playerState.mode === 'ffmpeg' ? resumeAt : 0;
        syncSeekBarMetrics(resumeAt, playerState.duration);

        const defaultSidecar = playerState.serverSubtitles.find(
            (sub) => sub.source === 'file'
        );
        playerState.selectedSubtitleValue = defaultSidecar ? `server:${defaultSidecar.index}` : '';
        renderVideoTracksMenu();

        if (playerState.mode === 'ffmpeg') {
            await attachFfmpegStream(data.ticket, resumeAt, requestId, Boolean(data.ffmpeg_available));
            if (requestId !== playerState.streamRequestId) return;
            playerState.isLoadingSource = false;
            if (resumeAt > 0) {
                showResumeBanner(resumeAt);
            }
        } else {
            dom.localVideoPlayer.onerror = () => {
                if (requestId !== playerState.streamRequestId || !dom.videoPlayerError) return;
                playerState.isLoadingSource = false;
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
                        if (requestId !== playerState.streamRequestId) return;
                        const mediaDur = Number.isFinite(dom.localVideoPlayer.duration)
                            ? dom.localVideoPlayer.duration
                            : playerState.duration;
                        const safeResume = mediaDur > 0 && resumeAt / mediaDur < RESUME_COMPLETE_RATIO
                            ? Math.min(resumeAt, Math.max(0, mediaDur - 5))
                            : 0;
                        if (safeResume >= RESUME_MIN_SECONDS) {
                            dom.localVideoPlayer.currentTime = safeResume;
                            syncSeekBarMetrics(safeResume, mediaDur);
                            showResumeBanner(safeResume);
                        }
                        playerState.isLoadingSource = false;
                        dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
                    },
                    { once: true }
                );
            } else {
                playerState.isLoadingSource = false;
                dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
            }
        }
    } catch (error) {
        if (requestId !== playerState.streamRequestId) return;
        playerState.isLoadingSource = false;
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

    playerState.manualSubtitles = [];

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
    saveCurrentPlaybackProgress({ force: true });
    playerState.streamRequestId++;
    playerState.isLoadingSource = false;
    if (isVideoInFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    stopLocalVideoPlayback();
    playerState.movieId = '';
    playerState.filePath = '';
    playerState.ticket = '';
    playerState.mode = 'direct';
    playerState.duration = 0;
    playerState.seekOffset = 0;
    playerState.burnSubTrackIndex = -1;
    playerState.selectedSubtitleValue = '';
    playerState.audioTracks = [];
    playerState.selectedAudioTrackIndex = 0;
    playerState.isScrubbing = false;
    playerState.lastProgressSaveAt = 0;
    playerState.lastSavedPosition = -1;
    playerState.serverSubtitles = [];
    playerState.manualSubtitles = [];
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