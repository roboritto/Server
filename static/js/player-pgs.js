import { dom } from './dom.js';

const PGS_MAGIC_0 = 0x50; // 'P'
const PGS_MAGIC_1 = 0x47; // 'G'
const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;
const SEG_END = 0x80;

let activeLoadId = 0;
let activeDisplaySets = [];
let lastRenderedCueIndex = -2;
let rafId = null;
let listenersBound = false;
let scratchCanvas = null;
let scratchCtx = null;

function readUint16BE(bytes, pos) {
    return ((bytes[pos] << 8) | bytes[pos + 1]) >>> 0;
}

function readUint32BE(bytes, pos) {
    return (
        ((bytes[pos] << 24) |
            (bytes[pos + 1] << 16) |
            (bytes[pos + 2] << 8) |
            bytes[pos + 3]) >>> 0
    );
}

function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function concatUint8Arrays(chunks) {
    if (chunks.length === 1) return chunks[0];
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
    }
    return merged;
}

function parsePgsSupBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    const displaySets = [];
    const palettes = new Map();
    const objects = new Map();

    let currentPcs = null;
    let videoWidth = 1920;
    let videoHeight = 1080;
    let pos = 0;

    while (pos + 13 <= len) {
        if (bytes[pos] !== PGS_MAGIC_0 || bytes[pos + 1] !== PGS_MAGIC_1) {
            pos++;
            continue;
        }

        const pts = readUint32BE(bytes, pos + 2) / 90000;
        const segType = bytes[pos + 10];
        const segSize = readUint16BE(bytes, pos + 11);
        const payloadStart = pos + 13;
        const payloadEnd = payloadStart + segSize;

        if (payloadEnd > len) break;
        const p = bytes.subarray(payloadStart, payloadEnd);
        pos = payloadEnd;

        if (segType === SEG_PCS && p.length >= 11) {
            videoWidth = readUint16BE(p, 0) || videoWidth;
            videoHeight = readUint16BE(p, 2) || videoHeight;
            const compState = p[7];
            const paletteUpdate = p[8] === 0x80;
            const paletteId = p[9];
            const numObjects = p[10];

            if (compState === 0x80) {
                palettes.clear();
                objects.clear();
            }

            const compObjects = [];
            let oPos = 11;
            for (let i = 0; i < numObjects && oPos + 8 <= p.length; i++) {
                const objectId = readUint16BE(p, oPos);
                const cropped = (p[oPos + 3] & 0x40) !== 0;
                const x = readUint16BE(p, oPos + 4);
                const y = readUint16BE(p, oPos + 6);
                oPos += 8;

                let cropX = 0;
                let cropY = 0;
                let cropW = 0;
                let cropH = 0;
                if (cropped && oPos + 8 <= p.length) {
                    cropX = readUint16BE(p, oPos);
                    cropY = readUint16BE(p, oPos + 2);
                    cropW = readUint16BE(p, oPos + 4);
                    cropH = readUint16BE(p, oPos + 6);
                    oPos += 8;
                }

                compObjects.push({ objectId, x, y, cropped, cropX, cropY, cropW, cropH });
            }

            currentPcs = { pts, width: videoWidth, height: videoHeight, paletteId, paletteUpdate, compObjects };
        } else if (segType === SEG_PDS && p.length >= 2) {
            const paletteId = p[0];
            const isHd = videoHeight >= 720;
            const existing = palettes.get(paletteId);
            const rgba = currentPcs?.paletteUpdate && existing
                ? new Uint8ClampedArray(existing)
                : new Uint8ClampedArray(256 * 4);

            for (let i = 2; i + 5 <= p.length; i += 5) {
                const entryId = p[i];
                const yVal = p[i + 1] - 16;
                const crVal = p[i + 2] - 128;
                const cbVal = p[i + 3] - 128;
                const alpha = p[i + 4];

                let r;
                let g;
                let b;
                if (isHd) {
                    r = 1.164383 * yVal + 1.792741 * crVal;
                    g = 1.164383 * yVal - 0.213249 * cbVal - 0.532909 * crVal;
                    b = 1.164383 * yVal + 2.112402 * cbVal;
                } else {
                    r = 1.164383 * yVal + 1.596027 * crVal;
                    g = 1.164383 * yVal - 0.391762 * cbVal - 0.812968 * crVal;
                    b = 1.164383 * yVal + 2.017232 * cbVal;
                }

                const base = entryId * 4;
                rgba[base] = clampByte(r);
                rgba[base + 1] = clampByte(g);
                rgba[base + 2] = clampByte(b);
                rgba[base + 3] = alpha;
            }
            palettes.set(paletteId, rgba);
        } else if (segType === SEG_ODS && p.length >= 4) {
            const objectId = readUint16BE(p, 0);
            const seqFlag = p[3];
            const isFirst = (seqFlag & 0x80) !== 0;
            const isLast = (seqFlag & 0x40) !== 0;

            if (isFirst && p.length >= 11) {
                const width = readUint16BE(p, 7);
                const height = readUint16BE(p, 9);
                const chunk = p.slice(11);
                const obj = { width, height, chunks: [chunk], rleData: null };
                if (isLast) {
                    obj.rleData = chunk;
                    obj.chunks = [];
                }
                objects.set(objectId, obj);
            } else if (!isFirst) {
                const obj = objects.get(objectId);
                if (obj) {
                    obj.chunks.push(p.slice(4));
                    if (isLast) {
                        obj.rleData = concatUint8Arrays(obj.chunks);
                        obj.chunks = [];
                    }
                }
            }
        } else if (segType === SEG_END && currentPcs) {
            const palette = palettes.get(currentPcs.paletteId);
            const paletteSnapshot = palette ? new Uint8ClampedArray(palette) : null;
            const items = [];

            if (paletteSnapshot && currentPcs.compObjects.length > 0) {
                for (const comp of currentPcs.compObjects) {
                    const obj = objects.get(comp.objectId);
                    if (!obj || !obj.rleData || obj.width <= 0 || obj.height <= 0) continue;
                    items.push({
                        x: comp.x,
                        y: comp.y,
                        width: obj.width,
                        height: obj.height,
                        cropped: comp.cropped,
                        cropX: comp.cropX,
                        cropY: comp.cropY,
                        cropW: comp.cropW,
                        cropH: comp.cropH,
                        rleData: obj.rleData,
                        palette: paletteSnapshot
                    });
                }
            }

            displaySets.push({
                pts: currentPcs.pts,
                width: currentPcs.width,
                height: currentPcs.height,
                items
            });
            currentPcs = null;
        }
    }

    displaySets.sort((a, b) => a.pts - b.pts);
    return displaySets;
}

function decodePgsRleToImageData(item, ctx) {
    const { width, height, rleData, palette } = item;
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    const len = rleData.length;

    let x = 0;
    let y = 0;
    let i = 0;

    while (i < len && y < height) {
        const b1 = rleData[i++];
        if (b1 !== 0) {
            if (x < width) {
                const dst = (y * width + x) * 4;
                const src = b1 * 4;
                out[dst] = palette[src];
                out[dst + 1] = palette[src + 1];
                out[dst + 2] = palette[src + 2];
                out[dst + 3] = palette[src + 3];
            }
            x++;
            continue;
        }

        if (i >= len) break;
        const b2 = rleData[i++];
        if (b2 === 0) {
            x = 0;
            y++;
            continue;
        }

        const hasColor = (b2 & 0x80) !== 0;
        const isLong = (b2 & 0x40) !== 0;
        let runLen = b2 & 0x3f;

        if (isLong) {
            if (i >= len) break;
            runLen = (runLen << 8) | rleData[i++];
        }

        let colorIdx = 0;
        if (hasColor) {
            if (i >= len) break;
            colorIdx = rleData[i++];
        }

        const src = colorIdx * 4;
        const r = palette[src];
        const g = palette[src + 1];
        const b = palette[src + 2];
        const a = palette[src + 3];

        const drawCount = Math.min(runLen, Math.max(0, width - x));
        let dst = (y * width + x) * 4;
        for (let k = 0; k < drawCount; k++) {
            out[dst] = r;
            out[dst + 1] = g;
            out[dst + 2] = b;
            out[dst + 3] = a;
            dst += 4;
        }
        x += runLen;
    }

    return imageData;
}

function findActiveCueIndex(timeSec) {
    let lo = 0;
    let hi = activeDisplaySets.length - 1;
    let ans = -1;
    const target = timeSec + 0.02;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (activeDisplaySets[mid].pts <= target) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

function renderCueIndex(cueIdx) {
    const canvas = dom.videoPgsCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (cueIdx < 0 || cueIdx >= activeDisplaySets.length) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const cue = activeDisplaySets[cueIdx];
    if (canvas.width !== cue.width || canvas.height !== cue.height) {
        canvas.width = cue.width;
        canvas.height = cue.height;
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    if (cue.items.length === 0) return;

    if (!scratchCanvas) {
        scratchCanvas = document.createElement('canvas');
        scratchCtx = scratchCanvas.getContext('2d');
    }

    for (const item of cue.items) {
        if (scratchCanvas.width !== item.width || scratchCanvas.height !== item.height) {
            scratchCanvas.width = item.width;
            scratchCanvas.height = item.height;
        }
        const imgData = decodePgsRleToImageData(item, scratchCtx);
        scratchCtx.putImageData(imgData, 0, 0);

        if (item.cropped && item.cropW > 0 && item.cropH > 0) {
            ctx.drawImage(
                scratchCanvas,
                item.cropX,
                item.cropY,
                item.cropW,
                item.cropH,
                item.x,
                item.y,
                item.cropW,
                item.cropH
            );
        } else {
            ctx.drawImage(scratchCanvas, item.x, item.y);
        }
    }
}

export function syncPgsOverlayNow() {
    if (!dom.localVideoPlayer || activeDisplaySets.length === 0) return;
    const idx = findActiveCueIndex(dom.localVideoPlayer.currentTime || 0);
    if (idx !== lastRenderedCueIndex) {
        lastRenderedCueIndex = idx;
        renderCueIndex(idx);
    }
}

function stopRafLoop() {
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}

function startRafLoop() {
    stopRafLoop();
    const tick = () => {
        if (!dom.localVideoPlayer || dom.localVideoPlayer.paused || activeDisplaySets.length === 0) {
            rafId = null;
            return;
        }
        syncPgsOverlayNow();
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

function handleVideoPlay() {
    syncPgsOverlayNow();
    startRafLoop();
}

function handleVideoPause() {
    stopRafLoop();
    syncPgsOverlayNow();
}

function bindVideoListeners() {
    if (listenersBound || !dom.localVideoPlayer) return;
    dom.localVideoPlayer.addEventListener('play', handleVideoPlay);
    dom.localVideoPlayer.addEventListener('pause', handleVideoPause);
    dom.localVideoPlayer.addEventListener('ended', handleVideoPause);
    dom.localVideoPlayer.addEventListener('timeupdate', syncPgsOverlayNow);
    dom.localVideoPlayer.addEventListener('seeked', syncPgsOverlayNow);
    listenersBound = true;
}

function unbindVideoListeners() {
    if (!listenersBound || !dom.localVideoPlayer) return;
    dom.localVideoPlayer.removeEventListener('play', handleVideoPlay);
    dom.localVideoPlayer.removeEventListener('pause', handleVideoPause);
    dom.localVideoPlayer.removeEventListener('ended', handleVideoPause);
    dom.localVideoPlayer.removeEventListener('timeupdate', syncPgsOverlayNow);
    dom.localVideoPlayer.removeEventListener('seeked', syncPgsOverlayNow);
    listenersBound = false;
}

export function clearPgsSubtitles() {
    activeLoadId++;
    stopRafLoop();
    unbindVideoListeners();
    activeDisplaySets = [];
    lastRenderedCueIndex = -2;

    if (dom.videoPgsCanvas) {
        const ctx = dom.videoPgsCanvas.getContext('2d');
        ctx?.clearRect(0, 0, dom.videoPgsCanvas.width, dom.videoPgsCanvas.height);
        dom.videoPgsCanvas.classList.add('hidden');
    }
}

export async function loadPgsSubtitleUrl(url) {
    clearPgsSubtitles();
    if (!dom.videoPgsCanvas || !dom.localVideoPlayer || !url) return;

    const loadId = activeLoadId;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Could not extract PGS subtitle track.');
    }

    const buffer = await response.arrayBuffer();
    if (loadId !== activeLoadId) return;

    activeDisplaySets = parsePgsSupBuffer(buffer);
    lastRenderedCueIndex = -2;
    dom.videoPgsCanvas.classList.remove('hidden');
    bindVideoListeners();
    syncPgsOverlayNow();

    if (!dom.localVideoPlayer.paused) {
        startRafLoop();
    }
}