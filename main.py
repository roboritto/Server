from fastapi import FastAPI, Header, HTTPException, Request, Security
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
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
from backend.models import (
    CollectionDownloadRequest,
    CustomMovieCreate,
    LocalFileDownloadRequest,
    Movie,
    MovieUpdate,
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


# --- Direct Movie URL Deep-Link & Static Web App ---
@app.get("/{movie_id:int}")
def serve_movie_url(movie_id: int):
    """Serves index.html for direct movie ID URLs like /1234."""
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static", html=True), name="static")