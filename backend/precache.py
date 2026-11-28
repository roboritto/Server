from collections import deque
import secrets
import threading
import time
from pathlib import Path
from typing import List, Optional

from backend.downloads import extract_movie_links, is_http_url, resolve_local_file
from backend.media_probe import (
    can_copy_video_for_mobile,
    find_sidecar_subtitles,
    get_ffmpeg_binary,
    get_selected_audio_track,
    get_stream_cache_dir,
    needs_ffmpeg_remux,
    pick_default_subtitle_index,
    probe_local_video,
    subtitle_sort_key,
)
from backend.subtitles import extract_all_pgs_sup_tracks
from backend.transcoder import (
    CPU_ENCODER_SPEC,
    PREPARE_LOCK,
    STREAM_PREPARE_JOBS,
    build_prepare_ffmpeg_cmd,
    build_stream_cache_key,
    get_best_h264_encoder,
    get_stream_cache_stats,
    run_prepare_mp4_worker,
    terminate_process,
)

_PRECACHE_LOCK = threading.Lock()
_PRECACHE_QUEUE: deque[dict] = deque()
_PRECACHE_CURRENT: Optional[dict] = None
_PRECACHE_WORKER_RUNNING = False
_PRECACHE_HISTORY: deque[dict] = deque(maxlen=25)


def _collect_uncached_targets_for_row(
    movie_row: dict,
    title: str = "",
    include_mobile_burn: bool = True,
) -> dict:
    """
    Inspects all local video files linked to a movie row and returns cache summary +
    any uncached preparation targets (skipping direct-play MP4s and existing cache hits).
    """
    movie_id = str(movie_row.get("movie_id", "")).strip()
    display_title = (title or "").strip() or f"Movie #{movie_id}"
    entries = extract_movie_links(movie_row.get("link", ""))
    local_entries = [e for e in entries if not is_http_url(e)]

    ffmpeg_available = bool(get_ffmpeg_binary())
    cache_dir = get_stream_cache_dir()

    summary = {
        "movie_id": movie_id,
        "local_files": 0,
        "cached_or_direct": 0,
        "uncached_targets": [],
    }

    for rel_path in local_entries:
        file_path = resolve_local_file(rel_path)
        if not file_path:
            continue

        summary["local_files"] += 1
        probe = probe_local_video(file_path)
        use_ffmpeg = needs_ffmpeg_remux(file_path, probe)

        subtitles = find_sidecar_subtitles(file_path)
        if ffmpeg_available:
            subtitles.extend(probe.get("embedded_subtitles", []))
        subtitles.sort(key=subtitle_sort_key)
        default_idx = pick_default_subtitle_index(subtitles)
        default_sub = subtitles[default_idx] if default_idx >= 0 else None

        pgs_stream_indices = [
            int(sub["stream_index"])
            for sub in subtitles
            if sub.get("codec") == "hdmv_pgs_subtitle" and "stream_index" in sub
        ]

        variants: List[tuple[Optional[int], str]] = []
        if use_ffmpeg:
            variants.append((None, "Universal MP4"))

        if (
            ffmpeg_available
            and default_sub
            and default_sub.get("render_mode") == "burn"
            and "stream_index" in default_sub
        ):
            is_pgs = default_sub.get("codec") == "hdmv_pgs_subtitle"
            if include_mobile_burn or not is_pgs:
                variants.append(
                    (int(default_sub["stream_index"]), f"English Burn-in ({default_sub['label']})")
                )

        if not variants:
            summary["cached_or_direct"] += 1
            continue

        file_has_missing = False
        for burn_stream, variant_label in variants:
            cache_key = build_stream_cache_key(file_path, 0, burn_stream)
            final_path = cache_dir / f"{cache_key}.mp4"
            if final_path.is_file() and final_path.stat().st_size > 0:
                continue

            file_has_missing = True
            summary["uncached_targets"].append(
                {
                    "cache_key": cache_key,
                    "movie_id": movie_id,
                    "title": display_title,
                    "path": str(file_path),
                    "filename": file_path.name,
                    "variant": variant_label,
                    "burn_stream": burn_stream,
                    "pgs_stream_indices": pgs_stream_indices,
                    "duration": float(probe.get("duration") or 0.0),
                    "video_codec": probe.get("video_codec", ""),
                    "video_pix_fmt": probe.get("video_pix_fmt", ""),
                    "audio_codec": probe.get("audio_codec", ""),
                    "audio_tracks": probe.get("audio_tracks", []),
                }
            )

        if not file_has_missing:
            summary["cached_or_direct"] += 1

    return summary


def _run_precache_queue_worker():
    """Sequentially encodes queued uncached movies one at a time, sharing STREAM_PREPARE_JOBS."""
    global _PRECACHE_CURRENT, _PRECACHE_WORKER_RUNNING

    try:
        while True:
            with _PRECACHE_LOCK:
                if not _PRECACHE_QUEUE:
                    _PRECACHE_CURRENT = None
                    _PRECACHE_WORKER_RUNNING = False
                    return
                item = _PRECACHE_QUEUE.popleft()
                _PRECACHE_CURRENT = {
                    "movie_id": item["movie_id"],
                    "title": item["title"],
                    "filename": item["filename"],
                    "variant": item["variant"],
                    "cache_key": item["cache_key"],
                    "job_id": "",
                    "mode_label": "Starting...",
                    "progress": 0.0,
                }

            file_path = Path(item["path"])
            cache_dir = get_stream_cache_dir()
            cache_key = item["cache_key"]
            final_path = cache_dir / f"{cache_key}.mp4"

            # Skip immediately if another device already finished caching it
            if final_path.is_file() and final_path.stat().st_size > 0:
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "cached",
                        }
                    )
                continue

            ffmpeg_bin = get_ffmpeg_binary()
            if not ffmpeg_bin or not file_path.is_file():
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "error",
                            "error": "Missing file or FFmpeg binary.",
                        }
                    )
                continue

            # Pre-extract all embedded PGS .sup tracks in a single pass (skips existing)
            pgs_indices = item.get("pgs_stream_indices") or []
            if pgs_indices:
                with _PRECACHE_LOCK:
                    if _PRECACHE_CURRENT:
                        _PRECACHE_CURRENT["mode_label"] = (
                            f"Extracting {len(pgs_indices)} PGS subtitle track(s)..."
                        )
                extract_all_pgs_sup_tracks(file_path, pgs_indices)

            # If a live player is already preparing this exact cache_key, wait for it instead of duplicating
            existing_job_id = ""
            with PREPARE_LOCK:
                for jid, job in STREAM_PREPARE_JOBS.items():
                    if job["cache_key"] == cache_key and job["status"] == "preparing":
                        existing_job_id = jid
                        break

            if existing_job_id:
                with _PRECACHE_LOCK:
                    if _PRECACHE_CURRENT:
                        _PRECACHE_CURRENT["job_id"] = existing_job_id
                while True:
                    with PREPARE_LOCK:
                        job = STREAM_PREPARE_JOBS.get(existing_job_id)
                        status = job["status"] if job else "ready"
                    if status != "preparing":
                        break
                    time.sleep(0.5)
                with _PRECACHE_LOCK:
                    _PRECACHE_HISTORY.appendleft(
                        {
                            "movie_id": item["movie_id"],
                            "title": item["title"],
                            "variant": item["variant"],
                            "status": "cached" if status == "ready" else status,
                        }
                    )
                continue

            job_id = secrets.token_urlsafe(10)
            part_path = cache_dir / f"{cache_key}_{job_id}.part.mp4"
            burn_stream = item.get("burn_stream")

            selected_audio = get_selected_audio_track(item, 0)
            audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
            audio_codec = selected_audio["codec"] if selected_audio else item.get("audio_codec", "")
            audio_channels = int(selected_audio.get("channels", 2)) if selected_audio else 2

            can_copy_h264 = can_copy_video_for_mobile(item) and burn_stream is None
            fallback_cmd: Optional[List[str]] = None

            if can_copy_h264:
                mode_label = "Pre-caching (fast copy)..."
                primary_video_args = ["-c:v", "copy"]
            else:
                enc_key, enc_label, primary_video_args = get_best_h264_encoder(ffmpeg_bin)
                mode_label = (
                    f"Pre-caching with subtitles ({enc_label})..."
                    if burn_stream is not None
                    else f"Pre-caching ({enc_label})..."
                )
                if enc_key != "cpu":
                    fallback_cmd = build_prepare_ffmpeg_cmd(
                        ffmpeg_bin,
                        file_path,
                        part_path,
                        audio_map,
                        audio_codec,
                        audio_channels,
                        burn_stream,
                        CPU_ENCODER_SPEC[2],
                        is_copy_video=False,
                    )

            primary_cmd = build_prepare_ffmpeg_cmd(
                ffmpeg_bin,
                file_path,
                part_path,
                audio_map,
                audio_codec,
                audio_channels,
                burn_stream,
                primary_video_args,
                is_copy_video=can_copy_h264,
            )

            with PREPARE_LOCK:
                STREAM_PREPARE_JOBS[job_id] = {
                    "cache_key": cache_key,
                    "status": "preparing",
                    "progress": 0.0,
                    "mode_label": mode_label,
                    "error": "",
                    "process": None,
                    "part_path": str(part_path),
                    "tickets": set(),
                    "finished_at": 0.0,
                }

            with _PRECACHE_LOCK:
                if _PRECACHE_CURRENT:
                    _PRECACHE_CURRENT["job_id"] = job_id
                    _PRECACHE_CURRENT["mode_label"] = mode_label

            run_prepare_mp4_worker(
                job_id,
                primary_cmd,
                fallback_cmd,
                part_path,
                final_path,
                float(item.get("duration") or 0.0),
                cache_key,
            )

            with PREPARE_LOCK:
                finished_job = STREAM_PREPARE_JOBS.get(job_id) or {}
                final_status = finished_job.get("status", "error")
                final_err = finished_job.get("error", "")

            with _PRECACHE_LOCK:
                _PRECACHE_HISTORY.appendleft(
                    {
                        "movie_id": item["movie_id"],
                        "title": item["title"],
                        "variant": item["variant"],
                        "status": "cached" if final_status == "ready" else final_status,
                        "error": final_err if final_status == "error" else "",
                    }
                )
    except Exception as exc:
        print(f"[Pre-Cache Worker Error] {exc}")
        with _PRECACHE_LOCK:
            _PRECACHE_CURRENT = None
            _PRECACHE_WORKER_RUNNING = False


def queue_movies_for_precache(
    movie_rows: List[dict],
    titles: Optional[dict] = None,
    include_mobile_burn: bool = True,
) -> dict:
    """Scans the given movie rows and enqueues every uncached local video file."""
    global _PRECACHE_WORKER_RUNNING

    if not get_ffmpeg_binary():
        return {
            "status": "error",
            "error": "FFmpeg is not available on the server (add ffmpeg to PATH or set FFMPEG_PATH in .env).",
        }

    titles_map = titles or {}
    queued_count = 0
    already_cached_count = 0
    already_queued_count = 0

    with PREPARE_LOCK:
        active_prepare_keys = {
            job["cache_key"]
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }

    with _PRECACHE_LOCK:
        known_queue_keys = {item["cache_key"] for item in _PRECACHE_QUEUE}
        if _PRECACHE_CURRENT:
            known_queue_keys.add(_PRECACHE_CURRENT["cache_key"])

    new_items: List[dict] = []
    for row in movie_rows:
        m_id = str(row.get("movie_id", "")).strip()
        summary = _collect_uncached_targets_for_row(
            row,
            title=titles_map.get(m_id, ""),
            include_mobile_burn=include_mobile_burn,
        )
        already_cached_count += summary["cached_or_direct"]

        for target in summary["uncached_targets"]:
            ck = target["cache_key"]
            if ck in known_queue_keys or ck in active_prepare_keys:
                already_queued_count += 1
                continue
            known_queue_keys.add(ck)
            new_items.append(target)
            queued_count += 1

    should_start_worker = False
    with _PRECACHE_LOCK:
        for item in new_items:
            _PRECACHE_QUEUE.append(item)
        if not _PRECACHE_WORKER_RUNNING and _PRECACHE_QUEUE:
            _PRECACHE_WORKER_RUNNING = True
            should_start_worker = True

    if should_start_worker:
        threading.Thread(target=_run_precache_queue_worker, daemon=True).start()

    return {
        "status": "ok",
        "queued_count": queued_count,
        "already_cached_count": already_cached_count,
        "already_queued_count": already_queued_count,
        "queue_status": get_precache_queue_status(),
    }


def get_movie_precache_status(movie_row: dict, include_mobile_burn: bool = True) -> dict:
    """Returns whether a single movie's local video(s) are cached, currently queued/caching, or uncached."""
    summary = _collect_uncached_targets_for_row(
        movie_row, include_mobile_burn=include_mobile_burn
    )
    if summary["local_files"] == 0:
        return {"state": "no_local", "uncached_count": 0}

    uncached_targets = summary["uncached_targets"]
    if not uncached_targets:
        return {"state": "cached", "uncached_count": 0}

    target_keys = {t["cache_key"] for t in uncached_targets}

    with _PRECACHE_LOCK:
        if _PRECACHE_CURRENT and _PRECACHE_CURRENT["cache_key"] in target_keys:
            job_id = _PRECACHE_CURRENT.get("job_id", "")
            progress = _PRECACHE_CURRENT.get("progress", 0.0)
            if job_id:
                with PREPARE_LOCK:
                    job = STREAM_PREPARE_JOBS.get(job_id)
                    if job:
                        progress = job.get("progress", progress)
            return {
                "state": "caching",
                "progress": progress,
                "uncached_count": len(uncached_targets),
            }
        if any(item["cache_key"] in target_keys for item in _PRECACHE_QUEUE):
            return {"state": "queued", "uncached_count": len(uncached_targets)}

    with PREPARE_LOCK:
        for job in STREAM_PREPARE_JOBS.values():
            if job["cache_key"] in target_keys and job["status"] == "preparing":
                return {
                    "state": "caching",
                    "progress": job.get("progress", 0.0),
                    "uncached_count": len(uncached_targets),
                }

    return {"state": "uncached", "uncached_count": len(uncached_targets)}


def get_precache_queue_status() -> dict:
    """Returns live progress of the active pre-cache job, pending queue, and recent results."""
    with _PRECACHE_LOCK:
        running = _PRECACHE_WORKER_RUNNING
        current = dict(_PRECACHE_CURRENT) if _PRECACHE_CURRENT else None
        queued = [
            {
                "movie_id": item["movie_id"],
                "title": item["title"],
                "filename": item["filename"],
                "variant": item["variant"],
            }
            for item in _PRECACHE_QUEUE
        ]
        history = list(_PRECACHE_HISTORY)

    if current and current.get("job_id"):
        with PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(current["job_id"])
            if job:
                current["progress"] = job.get("progress", 0.0)
                current["mode_label"] = job.get("mode_label", current["mode_label"])

    return {
        "running": running,
        "current": current,
        "queued": queued,
        "queued_count": len(queued),
        "history": history,
        "cache_stats": get_stream_cache_stats(),
    }


def cancel_precache_queue() -> dict:
    """Clears all pending items in the pre-cache queue and stops the active pre-cache FFmpeg job."""
    active_job_id = ""
    with _PRECACHE_LOCK:
        _PRECACHE_QUEUE.clear()
        if _PRECACHE_CURRENT:
            active_job_id = _PRECACHE_CURRENT.get("job_id", "")

    if active_job_id:
        with PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(active_job_id)
            if job and job["status"] == "preparing":
                job["status"] = "cancelled"
                job["finished_at"] = time.time()
                terminate_process(job.get("process"))
                job["process"] = None
                part_path = job.get("part_path")
                if part_path:
                    Path(part_path).unlink(missing_ok=True)

    return get_precache_queue_status()