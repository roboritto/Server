from pathlib import Path
from fastapi import FastAPI, Header, HTTPException, Request, Security
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.config import SERVER_API_TOKEN, TMDB_API_KEY
from backend.downloads import (
    build_collection_zip_stream,
    consume_download_ticket,
    consume_local_file_ticket,
    create_download_ticket,
    create_local_file_ticket,
    extract_movie_links,
    movie_in_collection,
    normalize_local_path,
    resolve_local_file,
)
from backend.streaming import (
    cancel_precache_queue,
    cancel_prepare_job,
    create_local_stream_ticket,
    detach_ticket_from_prepare_jobs,
    extract_pgs_track_sup,
    get_cached_mp4_path,
    get_local_stream_ticket,
    get_movie_precache_status,
    get_precache_queue_status,
    get_prepare_job_status,
    queue_movies_for_precache,
    render_subtitle_track_vtt,
    start_prepare_mp4_job,
)
from backend.models import (
    CollectionDownloadRequest,
    CustomMovieCreate,
    LocalFileDownloadRequest,
    Movie,
    MovieUpdate,
    PrecacheQueueRequest,
    TmdbCacheUpdate,
)
from backend.storage import (
    attach_is_new_flags,
    get_client_ip,
    get_hidden_ids_for_request,
    get_permissions_for_request,
    is_admin_request,
    load_custom_movies,
    load_hidden_movies_config,
    load_tmdb_cache,
    merge_tmdb_cache,
    read_csv,
    remove_from_hidden_movies,
    remove_from_known_movies,
    remove_from_tmdb_cache,
    require_permission,
    save_custom_movie,
    toggle_hidden_movie,
    write_csv,
)

app = FastAPI(title="Cine.ma API")
app.add_middleware(GZipMiddleware, minimum_size=1000)


# --- Security Dependency ---
def verify_token(x_api_token: str = Header(...)):
    if not SERVER_API_TOKEN or x_api_token != SERVER_API_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid API Token")
    return x_api_token


# --- Config & Metadata Endpoints ---
@app.get("/api/config", dependencies=[Security(verify_token)])
def get_config(request: Request):
    """Passes the TMDB API key, admin flag, and effective IP permissions to the frontend."""
    return {
        "tmdb_api_key": TMDB_API_KEY,
        "is_admin": is_admin_request(request),
        "permissions": get_permissions_for_request(request),
    }


@app.get("/api/custom-movies", dependencies=[Security(verify_token)])
def get_custom_movies(request: Request):
    """Returns local metadata for non-TMDB movies, excluding movies hidden from the client IP."""
    custom_data = load_custom_movies()
    hidden_ids = get_hidden_ids_for_request(request)

    if hidden_ids:
        custom_data = {
            k: v for k, v in custom_data.items()
            if str(k).strip() not in hidden_ids
        }

    return custom_data


@app.post("/api/custom-movies", dependencies=[Security(verify_token)])
def add_custom_movie(payload: CustomMovieCreate, request: Request):
    """Saves local metadata for a custom movie (movie_id >= 8000000) into custom_movies.json."""
    require_permission(request, "add_movie")
    movie_id = str(payload.movie_id).strip()
    if not movie_id.isdigit() or int(movie_id) < 8000000:
        raise HTTPException(status_code=400, detail="Custom movie_id must be a number >= 8000000")

    metadata = payload.model_dump(exclude={"movie_id"})
    save_custom_movie(movie_id, metadata)
    return {"status": "success", "movie_id": movie_id}


@app.get("/api/tmdb-cache", dependencies=[Security(verify_token)])
def get_tmdb_cache(request: Request):
    """Returns server-side cached TMDB metadata, excluding movies hidden from the client IP."""
    cache = load_tmdb_cache()
    hidden_ids = get_hidden_ids_for_request(request)

    if hidden_ids:
        cache = {
            k: v for k, v in cache.items()
            if str(k).strip() not in hidden_ids
        }

    return cache


@app.post("/api/tmdb-cache", dependencies=[Security(verify_token)])
def update_tmdb_cache(payload: TmdbCacheUpdate):
    """Merges newly fetched TMDB metadata entries into tmdb_cache.json."""
    saved_count = merge_tmdb_cache(payload.entries)
    return {"status": "success", "saved_count": saved_count}


# --- Movie CRUD Endpoints ---
@app.get("/api/movies", dependencies=[Security(verify_token)])
def get_movies(request: Request):
    """Returns the movie database with NEW flags, excluding movies hidden from the client IP."""
    movies = attach_is_new_flags(read_csv())
    hidden_ids = get_hidden_ids_for_request(request)

    if hidden_ids:
        movies = [
            row for row in movies
            if str(row.get("movie_id", "")).strip() not in hidden_ids
        ]

    # Only reveal hidden status to admins (never to allowed non-admin IPs)
    admin_hidden_set = (
        set(load_hidden_movies_config()["hidden_movies"])
        if is_admin_request(request)
        else set()
    )
    for row in movies:
        m_id = str(row.get("movie_id", "")).strip()
        row["is_hidden"] = m_id in admin_hidden_set

    return movies


@app.post("/api/movies", dependencies=[Security(verify_token)])
def add_movie(movie: Movie, request: Request):
    """Appends a new movie from the frontend TMDB search."""
    require_permission(request, "add_movie")
    data = read_csv()

    if any(str(row.get("movie_id", "")).strip() == str(movie.movie_id).strip() for row in data):
        raise HTTPException(status_code=400, detail="Movie already exists")

    data.append(movie.model_dump())
    write_csv(data)
    return {"status": "success", "message": "Movie added"}


@app.put("/api/movies/{movie_id}", dependencies=[Security(verify_token)])
def update_movie(movie_id: str, updates: MovieUpdate, request: Request):
    """Updates the link, rating, review, last_watch date, or collection."""
    if updates.link is not None:
        require_permission(request, "add_link")
    if (
        updates.rating is not None
        or updates.last_watch is not None
        or updates.review is not None
    ):
        require_permission(request, "edit_rating")
    if updates.collection is not None:
        require_permission(request, "edit_collection")

    target_id = str(movie_id).strip()
    if target_id in get_hidden_ids_for_request(request):
        raise HTTPException(status_code=404, detail="Movie not found")

    data = read_csv()
    movie_found = False

    for row in data:
        if str(row.get("movie_id", "")).strip() == target_id:
            if updates.link is not None:
                row["link"] = updates.link
            if updates.rating is not None:
                row["rating"] = updates.rating
            if updates.last_watch is not None:
                row["last_watch"] = updates.last_watch
            if updates.review is not None:
                row["review"] = updates.review
            if updates.collection is not None:
                row["collection"] = updates.collection
            movie_found = True
            break

    if not movie_found:
        raise HTTPException(status_code=404, detail="Movie not found")

    write_csv(data)
    return {"status": "success", "message": "Movie updated"}


@app.delete("/api/movies/{movie_id}", dependencies=[Security(verify_token)])
def delete_movie(movie_id: str, request: Request):
    """Deletes a movie from both the CSV database and known_movies.json."""
    require_permission(request, "delete")
    target_id = str(movie_id).strip()
    if target_id in get_hidden_ids_for_request(request):
        raise HTTPException(status_code=404, detail="Movie not found")

    data = read_csv()
    filtered_data = [
        row for row in data
        if str(row.get("movie_id", "")).strip() != target_id
    ]

    if len(data) == len(filtered_data):
        raise HTTPException(status_code=404, detail="Movie not found")

    write_csv(filtered_data)
    remove_from_known_movies(target_id)
    remove_from_tmdb_cache(target_id)
    remove_from_hidden_movies(target_id)
    return {"status": "success", "message": "Movie deleted"}


@app.post("/api/movies/{movie_id}/toggle-hide", dependencies=[Security(verify_token)])
def toggle_movie_visibility(movie_id: str, request: Request):
    """Admin-only toggle to hide or unhide a movie from the public."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")

    target_id = str(movie_id).strip()
    if not any(str(row.get("movie_id", "")).strip() == target_id for row in read_csv()):
        raise HTTPException(status_code=404, detail="Movie not found")

    is_hidden = toggle_hidden_movie(target_id)
    return {"status": "success", "movie_id": target_id, "is_hidden": is_hidden}


# --- Collection Download Endpoints ---
@app.post("/api/collections/download-ticket", dependencies=[Security(verify_token)])
def create_collection_download_ticket(payload: CollectionDownloadRequest, request: Request):
    """Probes collection links and issues a single-use download ticket."""
    require_permission(request, "download_collection")
    target_collection = (payload.collection or "").strip()
    if not target_collection:
        raise HTTPException(status_code=400, detail="Collection name is required")

    hidden_ids = get_hidden_ids_for_request(request)
    collection_rows = [
        row for row in read_csv()
        if movie_in_collection(row.get("collection", ""), target_collection)
        and str(row.get("movie_id", "")).strip() not in hidden_ids
    ]

    if not collection_rows:
        raise HTTPException(status_code=404, detail="No movies found in this collection")

    result = create_download_ticket(
        collection_rows=collection_rows,
        target_collection=target_collection,
        titles=payload.titles,
        movie_order=payload.movie_order,
        client_ip=get_client_ip(request),
    )

    if not result:
        raise HTTPException(
            status_code=400,
            detail="No direct-downloadable movie links were found for this collection.",
        )

    return result


@app.get("/api/collections/download")
def download_collection_zip(ticket: str, request: Request):
    """Streams the entire collection as a single uncompressed ZIP64 archive."""
    ticket_data = consume_download_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired download ticket")

    zip_stream, content_disposition = build_collection_zip_stream(ticket_data)
    return StreamingResponse(
        zip_stream,
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


# --- Local File Download Endpoints ---
@app.post("/api/local-files/download-ticket", dependencies=[Security(verify_token)])
def request_local_file_ticket(payload: LocalFileDownloadRequest, request: Request):
    """Validates that a local path belongs to a visible movie in CSV and issues a download ticket."""
    target_id = str(payload.movie_id).strip()
    if target_id in get_hidden_ids_for_request(request):
        raise HTTPException(status_code=404, detail="Movie not found")

    requested_rel = normalize_local_path(payload.path)
    if not requested_rel:
        raise HTTPException(status_code=400, detail="File path is required")

    rows = read_csv()
    movie_row = next(
        (r for r in rows if str(r.get("movie_id", "")).strip() == target_id),
        None,
    )
    if not movie_row:
        raise HTTPException(status_code=404, detail="Movie not found")

    saved_entries = [
        normalize_local_path(e).lower()
        for e in extract_movie_links(movie_row.get("link", ""))
    ]
    if requested_rel.lower() not in saved_entries:
        raise HTTPException(status_code=403, detail="Requested file is not linked to this movie")

    resolved_path = resolve_local_file(requested_rel)
    if not resolved_path:
        raise HTTPException(
            status_code=404,
            detail="Local file not found on server (check LOCAL_MOVIES_DIR in .env)",
        )

    return create_local_file_ticket(resolved_path, get_client_ip(request))


@app.get("/api/local-files/download")
def download_local_file(ticket: str, request: Request):
    """Streams a local video file to the browser using a single-use ticket."""
    ticket_data = consume_local_file_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired download ticket")

    return FileResponse(
        path=ticket_data["path"],
        filename=ticket_data["filename"],
    )


@app.post("/api/local-files/stream-ticket", dependencies=[Security(verify_token)])
def request_local_stream_ticket(payload: LocalFileDownloadRequest, request: Request):
    """Validates a linked local video path and issues a reusable streaming ticket."""
    target_id = str(payload.movie_id).strip()
    if target_id in get_hidden_ids_for_request(request):
        raise HTTPException(status_code=404, detail="Movie not found")

    requested_rel = normalize_local_path(payload.path)
    if not requested_rel:
        raise HTTPException(status_code=400, detail="File path is required")

    rows = read_csv()
    movie_row = next(
        (r for r in rows if str(r.get("movie_id", "")).strip() == target_id),
        None,
    )
    if not movie_row:
        raise HTTPException(status_code=404, detail="Movie not found")

    saved_entries = [
        normalize_local_path(e).lower()
        for e in extract_movie_links(movie_row.get("link", ""))
    ]
    if requested_rel.lower() not in saved_entries:
        raise HTTPException(status_code=403, detail="Requested file is not linked to this movie")

    resolved_path = resolve_local_file(requested_rel)
    if not resolved_path:
        raise HTTPException(
            status_code=404,
            detail="Local file not found on server (check LOCAL_MOVIES_DIR in .env)",
        )

    return create_local_stream_ticket(resolved_path, get_client_ip(request))


@app.get("/api/local-files/stream")
def stream_local_file(ticket: str, request: Request, cache_key: str = ""):
    """Streams a native or prepared MP4 inline with full HTTP Range seeking support."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    if cache_key:
        cached_path = get_cached_mp4_path(ticket_data, cache_key)
        if not cached_path:
            raise HTTPException(status_code=404, detail="Prepared video not found")
        return FileResponse(
            path=str(cached_path),
            filename=f"{Path(ticket_data['filename']).stem}.mp4",
            media_type="video/mp4",
            content_disposition_type="inline",
        )

    return FileResponse(
        path=ticket_data["path"],
        filename=ticket_data["filename"],
        media_type=ticket_data["media_type"],
        content_disposition_type="inline",
    )


@app.get("/api/local-files/subtitles")
def get_local_subtitle_track(
    ticket: str, track: int, request: Request, offset: float = 0.0
):
    """Serves a sidecar .srt/.vtt or embedded MKV subtitle track converted to WebVTT."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    vtt_content = render_subtitle_track_vtt(
        ticket_data, track_index=track, offset_seconds=max(0.0, offset)
    )
    if vtt_content is None:
        raise HTTPException(status_code=404, detail="Subtitle track not found")

    return Response(
        content=vtt_content,
        media_type="text/vtt; charset=utf-8",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/local-files/pgs")
def get_local_pgs_subtitle_track(ticket: str, track: int, request: Request):
    """Serves an extracted Blu-ray PGS (.sup) track for client-side <canvas> rendering."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    sup_path = extract_pgs_track_sup(ticket_data, track_index=track)
    if not sup_path:
        raise HTTPException(status_code=404, detail="PGS subtitle track not found")

    return FileResponse(
        path=str(sup_path),
        media_type="application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.post("/api/local-files/prepare")
def prepare_local_video_stream(
    ticket: str,
    request: Request,
    audio_track: int = 0,
    burn_sub: int = -1,
):
    """Returns a ready universal MP4 URL immediately or starts/joins a background cache job."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    return start_prepare_mp4_job(
        ticket=ticket,
        ticket_data=ticket_data,
        audio_track_index=audio_track,
        burn_sub_track=burn_sub,
    )


@app.get("/api/local-files/prepare-status")
def get_local_video_prepare_status(ticket: str, job_id: str, request: Request):
    """Polls live progress for a background MP4 preparation job."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    status = get_prepare_job_status(ticket, ticket_data, job_id)
    if not status:
        raise HTTPException(status_code=404, detail="Preparation job not found")
    return status


@app.post("/api/local-files/prepare-cancel")
def cancel_local_video_prepare(ticket: str, job_id: str, request: Request):
    """Explicitly cancels an in-progress MP4 conversion when the user clicks Cancel."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if not ticket_data:
        raise HTTPException(status_code=403, detail="Invalid or expired stream ticket")

    cancel_prepare_job(ticket, ticket_data, job_id)
    return {"status": "ok"}


@app.post("/api/local-files/stream-stop")
def stop_local_video_prepare(ticket: str, request: Request):
    """Detaches the closed player modal while letting background server caching finish."""
    ticket_data = get_local_stream_ticket(ticket, get_client_ip(request))
    if ticket_data:
        detach_ticket_from_prepare_jobs(ticket_data, ticket=ticket)
    return {"status": "ok"}


# --- Admin Pre-Cache Queue Endpoints ---
@app.get("/api/admin/precache/status", dependencies=[Security(verify_token)])
def get_admin_precache_status(request: Request):
    """Returns current background pre-cache queue status (admin-only)."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")
    return get_precache_queue_status()


@app.get("/api/admin/precache/movie-status/{movie_id}", dependencies=[Security(verify_token)])
def get_admin_movie_precache_status(
    movie_id: str, request: Request, include_mobile_burn: bool = True
):
    """Checks whether a single movie's local video(s) are cached, queued, or uncached."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")

    target_id = str(movie_id).strip()
    movie_row = next(
        (r for r in read_csv() if str(r.get("movie_id", "")).strip() == target_id),
        None,
    )
    if not movie_row:
        raise HTTPException(status_code=404, detail="Movie not found")

    return get_movie_precache_status(movie_row, include_mobile_burn=include_mobile_burn)


@app.post("/api/admin/precache/movie/{movie_id}", dependencies=[Security(verify_token)])
def queue_admin_single_movie_precache(
    movie_id: str, payload: PrecacheQueueRequest, request: Request
):
    """Queues uncached local video file(s) for a single movie."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")

    target_id = str(movie_id).strip()
    movie_row = next(
        (r for r in read_csv() if str(r.get("movie_id", "")).strip() == target_id),
        None,
    )
    if not movie_row:
        raise HTTPException(status_code=404, detail="Movie not found")

    result = queue_movies_for_precache(
        [movie_row],
        titles=payload.titles,
        include_mobile_burn=payload.include_mobile_burn,
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@app.post("/api/admin/precache/queue-all", dependencies=[Security(verify_token)])
def queue_admin_all_uncached_movies(payload: PrecacheQueueRequest, request: Request):
    """Scans all CSV movies and queues every local video that doesn't have a cache yet."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")

    result = queue_movies_for_precache(
        read_csv(),
        titles=payload.titles,
        include_mobile_burn=payload.include_mobile_burn,
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@app.post("/api/admin/precache/cancel", dependencies=[Security(verify_token)])
def cancel_admin_precache_queue(request: Request):
    """Stops the active pre-cache conversion and clears the remaining queue."""
    if not is_admin_request(request):
        raise HTTPException(status_code=403, detail="Admin access required")
    return {"status": "ok", "queue_status": cancel_precache_queue()}


# --- Direct Movie URL Deep-Link & Static Web App ---
@app.get("/{movie_id:int}")
def serve_movie_url(movie_id: int):
    """Serves index.html for direct movie ID URLs like /1234."""
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static", html=True), name="static")