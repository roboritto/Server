import { dom } from './dom.js';

export const VIDEO_SEEK_STEP_SECONDS = 10;
export const FULLSCREEN_CONTROLS_HIDE_MS = 2500;
export const WATCH_PROGRESS_STORAGE_KEY = 'cinema_watch_progress_v1';
export const RESUME_MIN_SECONDS = 10;
export const RESUME_COMPLETE_RATIO = 0.95;
export const PROGRESS_SAVE_INTERVAL_MS = 5000;
export const RESUME_BANNER_HIDE_MS = 6000;

export const PLAYER_PLAY_SVG = `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <polygon points="6 4 20 12 6 20 6 4"></polygon>
    </svg>
`;
export const PLAYER_PAUSE_SVG = `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
    </svg>
`;
export const PLAYER_VOL_ON_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    </svg>
`;
export const PLAYER_VOL_OFF_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <line x1="23" y1="9" x2="17" y2="15"></line>
        <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
`;
export const PLAYER_FS_ENTER_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 3 21 3 21 9"></polyline>
        <polyline points="9 21 3 21 3 15"></polyline>
        <line x1="21" y1="3" x2="14" y2="10"></line>
        <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>
`;
export const PLAYER_FS_EXIT_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 14 10 14 10 20"></polyline>
        <polyline points="20 10 14 10 14 4"></polyline>
        <line x1="14" y1="10" x2="21" y2="3"></line>
        <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>
`;

export const playerState = {
    streamRequestId: 0,
    useNativePlayer: false,
    movieId: '',
    filePath: '',
    ticket: '',
    duration: 0,
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

/**
 * Returns true ONLY on iOS / iPadOS / Android devices.
 * Resizing a desktop/laptop browser window to a small width still returns false.
 */
export function isMobileOsDevice() {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPod/i.test(ua)) return true;
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
        return true;
    }
    return false;
}

export function isHttpLink(entry) {
    return /^https?:\/\//i.test((entry || '').trim());
}

export function formatVideoTime(totalSeconds) {
    const secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function normalizeLocalPathKey(rawPath) {
    let cleaned = String(rawPath || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    while (cleaned.startsWith('./')) {
        cleaned = cleaned.slice(2);
    }
    return cleaned.replace(/^\/+/, '').toLowerCase();
}

export function getCurrentPlaybackSeconds() {
    if (!dom.localVideoPlayer) return 0;
    return dom.localVideoPlayer.currentTime || 0;
}

export function syncSeekBarMetrics(currentSec, totalSec) {
    const safeTotal = Math.max(0, Math.floor(Number(totalSec) || 0));
    const safeCurrent = Math.max(
        0,
        Math.min(safeTotal || currentSec, Math.floor(Number(currentSec) || 0))
    );

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