import { state } from './state.js';
import { dom } from './dom.js';
import { parseLinkArray, sleep } from './utils.js';
import { openModal, closeModal } from './navigation.js';
import {
    VIDEO_SEEK_STEP_SECONDS,
    FULLSCREEN_CONTROLS_HIDE_MS,
    RESUME_MIN_SECONDS,
    RESUME_COMPLETE_RATIO,
    PLAYER_PLAY_SVG,
    PLAYER_PAUSE_SVG,
    PLAYER_VOL_ON_SVG,
    PLAYER_VOL_OFF_SVG,
    PLAYER_FS_ENTER_SVG,
    PLAYER_FS_EXIT_SVG,
    playerState,
    isMobileOsDevice,
    isHttpLink,
    formatVideoTime,
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
    renderMobileHeaderTrackSelectors,
    applySelectedSubtitleTrack,
    handleManualSrtUpload
} from './player-tracks.js';

export {
    updatePlayButtonForMovie,
    isTracksMenuOpen,
    closeVideoTracksMenu,
    toggleVideoTracksMenu,
    handleManualSrtUpload
};

const PREPARE_POLL_MS = 700;

let activePrepareJobId = '';
let fullscreenControlsTimer = null;
let isHoveringVideoControls = false;

initTrackCallbacks({
    onReloadStream: reloadStreamForTrackChange,
    onControlsActivity: showFullscreenControls
});

// --- UI Helpers ---
function setPrepareOverlay(visible, statusText = '', percent = 0, { showCancel = false } = {}) {
    if (!dom.videoPrepareOverlay) return;
    dom.videoPrepareOverlay.classList.toggle('hidden', !visible);
    if (!visible) {
        dom.videoPrepareHint?.classList.add('hidden');
        dom.videoPrepareCancelBtn?.classList.add('hidden');
        return;
    }

    const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    if (dom.videoPrepareStatus && statusText) {
        dom.videoPrepareStatus.textContent = statusText;
    }
    if (dom.videoPrepareBarFill) {
        dom.videoPrepareBarFill.style.width = `${clamped}%`;
    }
    if (dom.videoPreparePercent) {
        dom.videoPreparePercent.textContent = `${clamped}%`;
    }
    dom.videoPrepareHint?.classList.toggle('hidden', !showCancel);
    dom.videoPrepareCancelBtn?.classList.toggle('hidden', !showCancel);
}

function setPlayerError(message = '') {
    if (!dom.videoPlayerError) return;
    dom.videoPlayerError.textContent = message;
    dom.videoPlayerError.classList.toggle('hidden', !message);
}

function notifyServerCancelPrepare(ticket) {
    if (!ticket) return;
    fetch(`/api/local-files/stream-stop?ticket=${encodeURIComponent(ticket)}`, {
        method: 'POST',
        keepalive: true
    }).catch(() => {});
}

function applyPlayerModeForDevice() {
    const useNative = isMobileOsDevice();
    playerState.useNativePlayer = useNative;
    dom.videoPlayerModal?.classList.toggle('native-mobile-player', useNative);
    if (dom.localVideoPlayer) {
        dom.localVideoPlayer.controls = useNative;
    }
    renderMobileHeaderTrackSelectors();
}

function stopLocalVideoPlayback() {
    activePrepareJobId = '';
    hideResumeBanner();
    setPrepareOverlay(false);
    clearFullscreenControlsTimer();
    dom.videoPlayerStage?.classList.remove('controls-hidden');
    clearVideoSubtitleTracks();
    if (playerState.ticket) {
        notifyServerCancelPrepare(playerState.ticket);
    }
    if (!dom.localVideoPlayer) return;
    dom.localVideoPlayer.onerror = null;
    dom.localVideoPlayer.pause();
    dom.localVideoPlayer.removeAttribute('src');
    dom.localVideoPlayer.load();
    syncVideoControlIcons();
    syncSeekBarMetrics(0, 0);
}

// --- Faststart MP4 Preparation & Mounting ---
async function prepareAndMountStream(
    requestId,
    resumeSeconds,
    { showResumeNotice = true, autoPlay = true } = {}
) {
    if (!dom.localVideoPlayer || !playerState.ticket) return;

    activePrepareJobId = '';
    playerState.isLoadingSource = true;
    setPlayerError('');
    hideResumeBanner();
    setPrepareOverlay(true, 'Checking server cache...', 0);

    const prepRes = await fetch(
        `/api/local-files/prepare?ticket=${encodeURIComponent(playerState.ticket)}&audio_track=${playerState.selectedAudioTrackIndex}&burn_sub=${playerState.burnSubTrackIndex}`,
        { method: 'POST' }
    );
    const prepData = await prepRes.json().catch(() => ({}));
    if (requestId !== playerState.streamRequestId) return;

    if (!prepRes.ok || prepData.status === 'error') {
        throw new Error(prepData.error || prepData.detail || 'Could not prepare video.');
    }

    let streamUrl = prepData.stream_url || '';

    if (prepData.status === 'preparing' && prepData.job_id) {
        activePrepareJobId = prepData.job_id;
        setPrepareOverlay(
            true,
            prepData.mode_label || 'Caching video once for all devices...',
            prepData.progress || 0,
            { showCancel: true }
        );

        while (requestId === playerState.streamRequestId) {
            await sleep(PREPARE_POLL_MS);
            if (requestId !== playerState.streamRequestId) return;

            const pollRes = await fetch(
                `/api/local-files/prepare-status?ticket=${encodeURIComponent(playerState.ticket)}&job_id=${encodeURIComponent(prepData.job_id)}`
            );
            const pollData = await pollRes.json().catch(() => ({}));
            if (requestId !== playerState.streamRequestId) return;

            if (!pollRes.ok || pollData.status === 'error') {
                activePrepareJobId = '';
                throw new Error(pollData.error || pollData.detail || 'Video preparation failed.');
            }
            if (pollData.status === 'cancelled') {
                activePrepareJobId = '';
                return;
            }
            if (pollData.status === 'ready' && pollData.stream_url) {
                activePrepareJobId = '';
                streamUrl = pollData.stream_url;
                break;
            }
            setPrepareOverlay(
                true,
                pollData.mode_label || 'Caching video once for all devices...',
                pollData.progress || 0,
                { showCancel: true }
            );
        }
    }

    if (requestId !== playerState.streamRequestId || !streamUrl) return;

    setPrepareOverlay(false);

    dom.localVideoPlayer.onerror = () => {
        if (requestId !== playerState.streamRequestId) return;
        playerState.isLoadingSource = false;
        setPlayerError('Your browser could not play this video file. Try downloading it instead.');
    };

    const onMetadataReady = () => {
        if (requestId !== playerState.streamRequestId) return;

        const mediaDur = Number.isFinite(dom.localVideoPlayer.duration) && dom.localVideoPlayer.duration > 0
            ? dom.localVideoPlayer.duration
            : playerState.duration;
        if (mediaDur > 0) playerState.duration = mediaDur;

        const safeResume = resumeSeconds >= RESUME_MIN_SECONDS &&
            (mediaDur <= 0 || resumeSeconds / mediaDur < RESUME_COMPLETE_RATIO)
            ? (mediaDur > 0 ? Math.min(resumeSeconds, Math.max(0, mediaDur - 5)) : resumeSeconds)
            : 0;

        if (safeResume >= RESUME_MIN_SECONDS) {
            try {
                dom.localVideoPlayer.currentTime = safeResume;
            } catch {}

            // iOS WebKit safeguard: re-apply once playable if currentTime snapped back to 0
            dom.localVideoPlayer.addEventListener(
                'canplay',
                () => {
                    if (requestId !== playerState.streamRequestId) return;
                    if (Math.abs((dom.localVideoPlayer.currentTime || 0) - safeResume) > 3) {
                        try {
                            dom.localVideoPlayer.currentTime = safeResume;
                        } catch {}
                    }
                },
                { once: true }
            );

            syncSeekBarMetrics(safeResume, mediaDur);
            if (showResumeNotice) {
                showResumeBanner(safeResume);
            }
        } else {
            syncSeekBarMetrics(0, mediaDur);
        }

        playerState.isLoadingSource = false;
        if (autoPlay) {
            dom.localVideoPlayer.play().catch(() => syncVideoControlIcons());
        } else {
            syncVideoControlIcons();
        }
    };

    dom.localVideoPlayer.addEventListener('loadedmetadata', onMetadataReady, { once: true });
    dom.localVideoPlayer.src = streamUrl;
    applySelectedSubtitleTrack();
}

async function reloadStreamForTrackChange({
    nextBurnIndex = playerState.burnSubTrackIndex,
    nextAudioIndex = playerState.selectedAudioTrackIndex
} = {}) {
    if (!playerState.ticket || !dom.localVideoPlayer) return;

    const resumeAt = dom.localVideoPlayer.currentTime || 0;
    const wasPaused = dom.localVideoPlayer.paused;
    const requestId = ++playerState.streamRequestId;

    playerState.burnSubTrackIndex = nextBurnIndex;
    playerState.selectedAudioTrackIndex = nextAudioIndex;
    clearVideoSubtitleTracks();
    dom.localVideoPlayer.pause();

    try {
        await prepareAndMountStream(requestId, resumeAt, {
            showResumeNotice: false,
            autoPlay: !wasPaused
        });
    } catch (error) {
        if (requestId !== playerState.streamRequestId) return;
        playerState.isLoadingSource = false;
        setPrepareOverlay(false);
        console.error('Track switch error:', error);
        setPlayerError(error.message || 'Could not switch audio or subtitle track.');
    }
}

export async function handleAudioTrackChange() {
    if (!dom.videoAudioSelect || !playerState.ticket) return;
    const nextAudio = parseInt(dom.videoAudioSelect.value, 10) || 0;
    if (nextAudio === playerState.selectedAudioTrackIndex) return;
    await reloadStreamForTrackChange({ nextAudioIndex: nextAudio });
}

export async function handleBurnSubChange() {
    if (!dom.videoBurnSubSelect || !playerState.ticket) return;
    const nextBurn = parseInt(dom.videoBurnSubSelect.value, 10);
    const safeBurn = Number.isNaN(nextBurn) ? -1 : nextBurn;
    if (safeBurn === playerState.burnSubTrackIndex) return;
    await reloadStreamForTrackChange({ nextBurnIndex: safeBurn });
}

export async function handleCancelPrepareClick(event) {
    event?.stopPropagation();
    const ticket = playerState.ticket;
    const jobId = activePrepareJobId;
    activePrepareJobId = '';

    if (ticket && jobId) {
        try {
            await fetch(
                `/api/local-files/prepare-cancel?ticket=${encodeURIComponent(ticket)}&job_id=${encodeURIComponent(jobId)}`,
                { method: 'POST' }
            );
        } catch {}
    }

    closeVideoPlayerModal();
}

// --- Desktop Fullscreen Auto-Hide & Control Icons ---
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
    if (playerState.useNativePlayer) return;
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
    if (playerState.useNativePlayer || !window.matchMedia('(hover: hover)').matches) return;
    isHoveringVideoControls = Boolean(isHovered);
    showFullscreenControls();
}

export function handleFullscreenChange() {
    if (playerState.useNativePlayer) return;
    if (!isVideoInFullscreen()) {
        clearFullscreenControlsTimer();
        isHoveringVideoControls = false;
        dom.videoPlayerStage?.classList.remove('controls-hidden');
        syncVideoControlIcons();
        return;
    }
    syncVideoControlIcons();
    showFullscreenControls();
}

export function syncVideoControlIcons() {
    if (!dom.localVideoPlayer || playerState.useNativePlayer) return;
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
    if (dom.videoFullscreenBtn) {
        const inFs = isVideoInFullscreen();
        dom.videoFullscreenBtn.innerHTML = inFs ? PLAYER_FS_EXIT_SVG : PLAYER_FS_ENTER_SVG;
        dom.videoFullscreenBtn.title = inFs ? 'Exit Fullscreen' : 'Fullscreen';
        dom.videoFullscreenBtn.setAttribute('aria-label', inFs ? 'Exit Fullscreen' : 'Toggle Fullscreen');
    }
    if (isVideoInFullscreen()) {
        showFullscreenControls();
    }
}

// --- Transport, Seeking & Keyboard Shortcuts ---
export function handleVideoSurfaceClick() {
    if (playerState.useNativePlayer) return;
    if (isTracksMenuOpen()) {
        closeVideoTracksMenu();
        return;
    }
    toggleVideoPlayPause();
}

export function handleVideoLoadedMetadata() {
    if (!dom.localVideoPlayer) return;
    if (Number.isFinite(dom.localVideoPlayer.duration) && dom.localVideoPlayer.duration > 0) {
        playerState.duration = dom.localVideoPlayer.duration;
        syncSeekBarMetrics(dom.localVideoPlayer.currentTime, playerState.duration);
    }
    syncVideoControlIcons();
}

export function handleVideoTimeUpdate() {
    if (playerState.isScrubbing || !dom.localVideoPlayer) return;
    const currentSec = dom.localVideoPlayer.currentTime || 0;
    const totalDur = Number.isFinite(dom.localVideoPlayer.duration) && dom.localVideoPlayer.duration > 0
        ? dom.localVideoPlayer.duration
        : playerState.duration;

    if (!playerState.useNativePlayer) {
        syncSeekBarMetrics(currentSec, totalDur);
    }

    if (!playerState.isLoadingSource && !dom.localVideoPlayer.paused) {
        persistWatchProgress(
            playerState.movieId,
            playerState.filePath,
            currentSec,
            totalDur
        );
    }
}

export function handleVideoPause() {
    syncVideoControlIcons();
    saveCurrentPlaybackProgress({ force: true });
    updatePlayButtonForCurrentMovie();
}

export function handleVideoSeeked() {
    if (playerState.isLoadingSource) return;
    hideResumeBanner();
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
    if (!dom.localVideoPlayer || !playerState.movieId || !playerState.filePath) return;

    persistWatchProgress(
        playerState.movieId,
        playerState.filePath,
        0,
        playerState.duration,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
    dom.localVideoPlayer.currentTime = 0;
    syncSeekBarMetrics(0, playerState.duration);
    dom.localVideoPlayer.play().catch(() => {});
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

function commitVideoSeek(targetSec) {
    if (!dom.localVideoPlayer) return;
    hideResumeBanner();

    const totalDur = Number.isFinite(dom.localVideoPlayer.duration) && dom.localVideoPlayer.duration > 0
        ? dom.localVideoPlayer.duration
        : playerState.duration;
    const clampedSec = Math.max(0, totalDur > 0 ? Math.min(totalDur, targetSec) : targetSec);

    dom.localVideoPlayer.currentTime = clampedSec;
    syncSeekBarMetrics(clampedSec, totalDur);
    persistWatchProgress(
        playerState.movieId,
        playerState.filePath,
        clampedSec,
        totalDur,
        { force: true }
    );
    updatePlayButtonForCurrentMovie();
}

export function handleVideoSeekCommit() {
    playerState.isScrubbing = false;
    showFullscreenControls();
    if (!dom.videoSeekSlider || !dom.localVideoPlayer) return;

    const targetSec = Math.max(0, Number(dom.videoSeekSlider.value) || 0);
    dom.videoSeekSlider.blur();
    commitVideoSeek(targetSec);
}

function seekVideoByDelta(deltaSeconds) {
    if (!dom.localVideoPlayer) return;
    const currentPos = dom.localVideoPlayer.currentTime || 0;
    commitVideoSeek(currentPos + deltaSeconds);
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
    if (playerState.useNativePlayer || event.ctrlKey || event.metaKey || event.altKey) return;

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
    playerState.duration = 0;
    playerState.burnSubTrackIndex = -1;
    playerState.selectedSubtitleValue = '';
    playerState.audioTracks = [];
    playerState.selectedAudioTrackIndex = 0;
    playerState.isScrubbing = false;
    playerState.lastProgressSaveAt = 0;
    playerState.lastSavedPosition = -1;
    playerState.serverSubtitles = [];
    renderVideoTracksMenu();
    renderMobileHeaderTrackSelectors();
    setPlayerError('');
    setPrepareOverlay(true, 'Checking video format...', 0);

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
        playerState.duration = Number(data.duration) || 0;
        playerState.serverSubtitles = Array.isArray(data.subtitles) ? data.subtitles : [];
        playerState.audioTracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : [];
        playerState.selectedAudioTrackIndex = 0;

        const defaultIdx = Number.isInteger(data.default_subtitle_index)
            ? data.default_subtitle_index
            : -1;
        const defaultSub = defaultIdx >= 0
            ? playerState.serverSubtitles.find((sub) => sub.index === defaultIdx)
            : null;

        if (defaultSub) {
            playerState.selectedSubtitleValue = `server:${defaultSub.index}`;
            const needsBurnIn =
                defaultSub.render_mode === 'burn' &&
                (playerState.useNativePlayer || !defaultSub.pgs_canvas);
            playerState.burnSubTrackIndex = needsBurnIn ? defaultSub.index : -1;
        } else {
            playerState.selectedSubtitleValue = '';
            playerState.burnSubTrackIndex = -1;
        }
        
        renderVideoTracksMenu();
        renderMobileHeaderTrackSelectors();

        const resumeAt = getResumeSecondsForSource(movieId, filePath, playerState.duration);
        syncSeekBarMetrics(resumeAt, playerState.duration);
        await prepareAndMountStream(requestId, resumeAt, { showResumeNotice: true, autoPlay: true });
    } catch (error) {
        if (requestId !== playerState.streamRequestId) return;
        playerState.isLoadingSource = false;
        setPrepareOverlay(false);
        console.error('Local video stream error:', error);
        setPlayerError(error.message || 'Failed to load local video.');
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
    applyPlayerModeForDevice();

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
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    stopLocalVideoPlayback();

    playerState.movieId = '';
    playerState.filePath = '';
    playerState.ticket = '';
    playerState.duration = 0;
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
    renderMobileHeaderTrackSelectors();
    if (dom.srtFileInput) dom.srtFileInput.value = '';
    setPlayerError('');
    updatePlayButtonForCurrentMovie();
    closeModal(dom.videoPlayerModal);
}