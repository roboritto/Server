from fastapi import FastAPI, Header, HTTPException, Request, Security
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.config import SERVER_API_TOKEN, TMDB_API_KEY
from backend.downloads import (
    build_collection_zip_stream,
    consume_download_ticket,
    create_download_ticket,
    movie_in_collection,
)
from backend.models import CollectionDownloadRequest, Movie, MovieUpdate
from backend.storage import (
    attach_is_new_flags,
    get_client_ip,
    get_hidden_ids_for_request,
    load_custom_movies,
    read_csv,
    remove_from_known_movies,
    write_csv,
)

app = FastAPI(title="Cine.ma API")


# --- Security Dependency ---
def verify_token(x_api_token: str = Header(...)):
    if not SERVER_API_TOKEN or x_api_token != SERVER_API_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid API Token")
    return x_api_token


# --- Config & Metadata Endpoints ---
@app.get("/api/config", dependencies=[Security(verify_token)])
def get_config():
    """Passes the TMDB API key to the authenticated frontend."""
    return {"tmdb_api_key": TMDB_API_KEY}


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

    return movies


@app.post("/api/movies", dependencies=[Security(verify_token)])
def add_movie(movie: Movie):
    """Appends a new movie from the frontend TMDB search."""
    data = read_csv()

    if any(str(row.get("movie_id", "")).strip() == str(movie.movie_id).strip() for row in data):
        raise HTTPException(status_code=400, detail="Movie already exists")

    data.append(movie.model_dump())
    write_csv(data)
    return {"status": "success", "message": "Movie added"}


@app.put("/api/movies/{movie_id}", dependencies=[Security(verify_token)])
def update_movie(movie_id: str, updates: MovieUpdate, request: Request):
    """Updates the link, rating, review, last_watch date, or collection."""
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
    return {"status": "success", "message": "Movie deleted"}


# --- Collection Download Endpoints ---
@app.post("/api/collections/download-ticket", dependencies=[Security(verify_token)])
def create_collection_download_ticket(payload: CollectionDownloadRequest, request: Request):
    """Probes collection links and issues a single-use download ticket."""
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


# --- Direct Movie URL Deep-Link & Static Web App ---
@app.get("/{movie_id:int}")
def serve_movie_url(movie_id: int):
    """Serves index.html for direct movie ID URLs like /1234."""
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static", html=True), name="static")