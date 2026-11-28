import { dom } from './dom.js';
import { playerState } from './player-state.js';
import { loadPgsSubtitleUrl, clearPgsSubtitles } from './player-pgs.js';

let activeSubtitleRequestId = 0;
let activeBlobUrls = [];
let onReloadStream = async () => {};
let onControlsActivity = () => {};

export function initTrackCallbacks(callbacks = {}) {
    if (typeof callbacks.onReloadStream === 'function') {
        onReloadStream = callbacks.onReloadStream;
    }
    if (typeof callbacks.onControlsActivity === 'function') {
        onControlsActivity = callbacks.onControlsActivity;
    }
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

function convertSrtToVtt(rawText) {
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

        const start = parseSubtitleTimestamp(match[1]);
        const end = parseSubtitleTimestamp(match[2]);
        if (end <= 0) continue;

        const cueLines = lines.slice(timingIdx + 1);
        if (cueLines.length === 0) continue;

        out.push(`${formatVttTimestamp(Math.max(0, start))} --> ${formatVttTimestamp(end)}${match[3]}`);
        out.push(...cueLines);
        out.push('');
    }
    return out.join('\n');
}

export function clearVideoSubtitleTracks() {
    clearPgsSubtitles();
    activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    activeBlobUrls = [];
    if (!dom.localVideoPlayer) return;
    dom.localVideoPlayer.querySelectorAll('track').forEach((t) => t.remove());
}

export function isTracksMenuOpen() {
    return Boolean(dom.videoTracksMenu && !dom.videoTracksMenu.classList.contains('hidden'));
}

export function closeVideoTracksMenu() {
    if (!dom.videoTracksMenu) return;
    dom.videoTracksMenu.classList.add('hidden');
    dom.videoTracksBtn?.setAttribute('aria-expanded', 'false');
    onControlsActivity();
}

export function toggleVideoTracksMenu(event) {
    event?.stopPropagation();
    if (!dom.videoTracksMenu) return;
    const willOpen = dom.videoTracksMenu.classList.contains('hidden');
    dom.videoTracksMenu.classList.toggle('hidden', !willOpen);
    dom.videoTracksBtn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    dom.videoTracksBtn?.blur();
    onControlsActivity();
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

export function renderVideoTracksMenu() {
    const hasActiveSub = Boolean(playerState.selectedSubtitleValue);
    dom.videoTracksBtn?.classList.toggle('active', hasActiveSub);

    if (dom.videoSubtitleList) {
        dom.videoSubtitleList.innerHTML = '';

        dom.videoSubtitleList.appendChild(
            createTrackOptionButton('Off', playerState.selectedSubtitleValue === '', () => {
                selectSubtitleTrack('');
            })
        );

        playerState.serverSubtitles.forEach((sub) => {
            const val = `server:${sub.index}`;
            let displayLabel = sub.label;
            if (sub.pgs_canvas) {
                displayLabel = `${sub.label} (PGS)`;
            } else if (sub.render_mode === 'burn') {
                displayLabel = `${sub.label} (Burn-in)`;
            }
            dom.videoSubtitleList.appendChild(
                createTrackOptionButton(
                    displayLabel,
                    playerState.selectedSubtitleValue === val,
                    () => selectSubtitleTrack(val)
                )
            );
        });

        playerState.manualSubtitles.forEach((sub, idx) => {
            const val = `manual:${idx}`;
            dom.videoSubtitleList.appendChild(
                createTrackOptionButton(
                    sub.label,
                    playerState.selectedSubtitleValue === val,
                    () => selectSubtitleTrack(val)
                )
            );
        });

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
        if (playerState.audioTracks.length > 0) {
            dom.videoAudioSection.classList.remove('hidden');
            playerState.audioTracks.forEach((track) => {
                dom.videoAudioList.appendChild(
                    createTrackOptionButton(
                        track.label,
                        playerState.selectedAudioTrackIndex === track.index,
                        () => selectAudioTrack(track.index)
                    )
                );
            });
        } else {
            dom.videoAudioSection.classList.add('hidden');
        }
    }
}

export function renderMobileHeaderTrackSelectors() {
    if (!dom.videoMobileTools) return;
    dom.videoMobileTools.classList.toggle('hidden', !playerState.useNativePlayer);
    if (!playerState.useNativePlayer) return;

    if (dom.videoAudioSelect) {
        dom.videoAudioSelect.innerHTML = '';
        if (playerState.audioTracks.length > 1) {
            playerState.audioTracks.forEach((track) => {
                const opt = document.createElement('option');
                opt.value = String(track.index);
                opt.textContent = `Audio: ${track.label}`;
                dom.videoAudioSelect.appendChild(opt);
            });
            dom.videoAudioSelect.value = String(playerState.selectedAudioTrackIndex);
            dom.videoAudioSelect.classList.remove('hidden');
        } else {
            dom.videoAudioSelect.classList.add('hidden');
        }
    }

    if (dom.videoBurnSubSelect) {
        const bitmapSubs = playerState.serverSubtitles.filter((sub) => sub.render_mode === 'burn');
        dom.videoBurnSubSelect.innerHTML = '<option value="-1">Image Sub: Off</option>';
        if (bitmapSubs.length > 0) {
            bitmapSubs.forEach((sub) => {
                const opt = document.createElement('option');
                opt.value = String(sub.index);
                opt.textContent = `Image Sub: ${sub.label}`;
                dom.videoBurnSubSelect.appendChild(opt);
            });
            dom.videoBurnSubSelect.value = String(playerState.burnSubTrackIndex);
            dom.videoBurnSubSelect.classList.remove('hidden');
        } else {
            dom.videoBurnSubSelect.classList.add('hidden');
        }
    }
}

function mountSingleDesktopVttBlob(vttText, trackLabel) {
    clearVideoSubtitleTracks();
    if (!dom.localVideoPlayer || !vttText) return;

    const blobUrl = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt;charset=utf-8' }));
    activeBlobUrls.push(blobUrl);

    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = trackLabel || 'Subtitles';
    trackEl.srclang = 'en';
    trackEl.src = blobUrl;
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

/**
 * Mounts all text subtitle tracks directly on <video> for iOS / Android native CC menu.
 */
export function mountAllNativeSubtitleTracks({ activateLastManual = false } = {}) {
    clearVideoSubtitleTracks();
    if (!dom.localVideoPlayer || !playerState.ticket) return;

    const textSubs = playerState.serverSubtitles.filter((sub) => sub.render_mode !== 'burn');
    let hasDefaultTrack = false;

    textSubs.forEach((sub) => {
        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = sub.label || 'Subtitles';
        trackEl.srclang = sub.language || 'en';
        trackEl.src = `/api/local-files/subtitles?ticket=${encodeURIComponent(playerState.ticket)}&track=${sub.index}`; // unchanged
        const isSelectedTextSub = playerState.selectedSubtitleValue === `server:${sub.index}`;
        if (!activateLastManual && !hasDefaultTrack && isSelectedTextSub) {
            trackEl.default = true;
            hasDefaultTrack = true;
        }
        dom.localVideoPlayer.appendChild(trackEl);
    });

    playerState.manualSubtitles.forEach((sub, idx) => {
        const vtt = convertSrtToVtt(sub.rawText);
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' }));
        activeBlobUrls.push(blobUrl);

        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = sub.label || `Custom ${idx + 1}`;
        trackEl.srclang = 'en';
        trackEl.src = blobUrl;

        const isTargetManual = activateLastManual && idx === playerState.manualSubtitles.length - 1;
        if (isTargetManual) {
            trackEl.default = true;
            const enable = () => {
                if (!dom.localVideoPlayer) return;
                const list = dom.localVideoPlayer.textTracks;
                for (let i = 0; i < list.length; i++) {
                    list[i].mode = list[i] === trackEl.track ? 'showing' : 'disabled';
                }
                if (trackEl.track) trackEl.track.mode = 'showing';
            };
            trackEl.addEventListener('load', enable);
            dom.localVideoPlayer.appendChild(trackEl);
            enable();
            requestAnimationFrame(enable);
        } else {
            dom.localVideoPlayer.appendChild(trackEl);
        }
    });
}

async function selectSubtitleTrack(value) {
    playerState.selectedSubtitleValue = value || '';
    renderVideoTracksMenu();
    closeVideoTracksMenu();
    await applySelectedSubtitleTrack();
}

async function selectAudioTrack(audioIndex) {
    if (audioIndex === playerState.selectedAudioTrackIndex) {
        closeVideoTracksMenu();
        return;
    }
    playerState.selectedAudioTrackIndex = audioIndex;
    renderVideoTracksMenu();
    closeVideoTracksMenu();
    await onReloadStream({ nextAudioIndex: audioIndex });
}

export async function applySelectedSubtitleTrack() {
    if (playerState.useNativePlayer) {
        mountAllNativeSubtitleTracks();
        return;
    }

    const subReqId = ++activeSubtitleRequestId;
    clearVideoSubtitleTracks();
    if (!dom.localVideoPlayer) return;

    const value = playerState.selectedSubtitleValue;

    if (!value) {
        if (playerState.burnSubTrackIndex >= 0) {
            await onReloadStream({ nextBurnIndex: -1 });
        }
        return;
    }

    if (value.startsWith('server:')) {
        const idx = parseInt(value.slice('server:'.length), 10);
        const sub = playerState.serverSubtitles.find((s) => s.index === idx);
        if (!sub || !playerState.ticket) return;

        // Desktop client-side PGS (<canvas>) — instant, zero video re-encoding
        if (sub.pgs_canvas) {
            if (playerState.burnSubTrackIndex >= 0) {
                await onReloadStream({ nextBurnIndex: -1 });
                return;
            }
            const pgsUrl = `/api/local-files/pgs?ticket=${encodeURIComponent(playerState.ticket)}&track=${idx}`;
            try {
                await loadPgsSubtitleUrl(pgsUrl);
            } catch (error) {
                if (subReqId !== activeSubtitleRequestId) return;
                console.error('PGS subtitle load error:', error);
                if (dom.videoPlayerError) {
                    dom.videoPlayerError.textContent = error.message || 'Could not load PGS subtitle track.';
                    dom.videoPlayerError.classList.remove('hidden');
                }
            }
            return;
        }
        
        if (sub.render_mode === 'burn') {
            if (playerState.burnSubTrackIndex !== idx) {
                await onReloadStream({ nextBurnIndex: idx });
            }
            return;
        }

        if (playerState.burnSubTrackIndex >= 0) {
            await onReloadStream({ nextBurnIndex: -1 });
            return;
        }

        const url = `/api/local-files/subtitles?ticket=${encodeURIComponent(playerState.ticket)}&track=${idx}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Could not extract embedded subtitle track.');
            const vttText = await res.text();
            if (subReqId !== activeSubtitleRequestId) return;
            mountSingleDesktopVttBlob(vttText, sub.label);
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
        if (playerState.burnSubTrackIndex >= 0) {
            await onReloadStream({ nextBurnIndex: -1 });
            return;
        }
        const idx = parseInt(value.slice('manual:'.length), 10);
        const sub = playerState.manualSubtitles[idx];
        if (!sub) return;
        const vtt = convertSrtToVtt(sub.rawText);
        mountSingleDesktopVttBlob(vtt, sub.label);
    }
}

export async function handleManualSrtUpload(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
        const rawText = await file.text();
        const label = file.name.replace(/\.(srt|vtt)$/i, '');
        const newIdx = playerState.manualSubtitles.push({ label, rawText }) - 1;

        if (playerState.useNativePlayer) {
            mountAllNativeSubtitleTracks({ activateLastManual: true });
        } else {
            playerState.selectedSubtitleValue = `manual:${newIdx}`;
            renderVideoTracksMenu();
            await applySelectedSubtitleTrack();
        }
    } catch (error) {
        console.error('Could not read subtitle file:', error);
        alert('Could not read the selected subtitle file.');
    } finally {
        if (dom.srtFileInput) dom.srtFileInput.value = '';
    }
}