"""Serviço local de downloads do YouTube para o módulo "midia" do K7 (yt-dlp + ffmpeg + deno).

- POST /baixar {url, formato: mp3|wav|mp4, playlist, max_itens} → {id}; o download roda em segundo plano.
- GET /trabalhos/{id} → status (rodando | ok | erro), progresso e arquivos prontos.
- GET /trabalhos/{id}/arquivos/{nome} → o arquivo; DELETE /trabalhos/{id} → apaga a pasta do trabalho.
Só aceita links do YouTube. Os arquivos ficam em /downloads/<id>/ até o K7 copiá-los e apagar.
"""

import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

DOWNLOADS = Path("/downloads")
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
MAX_ITEMS = 200
JOB_TTL_SECONDS = 6 * 3600

app = FastAPI(title="ytdlp")
jobs: dict[str, dict] = {}
lock = threading.Lock()


class DownloadRequest(BaseModel):
    url: str
    formato: str = Field("mp3", pattern="^(mp3|wav|mp4)$")
    playlist: bool = False
    max_itens: int = Field(25, ge=1, le=MAX_ITEMS)


def options(job_id: str, req: DownloadRequest) -> dict:
    folder = DOWNLOADS / job_id
    template = "%(playlist_index)03d - %(title)s.%(ext)s" if req.playlist else "%(title)s.%(ext)s"
    opts: dict = {
        "outtmpl": str(folder / template),
        "windowsfilenames": True,
        "noplaylist": not req.playlist,
        "playlistend": req.max_itens,
        "ignoreerrors": req.playlist,  # numa playlist, um vídeo indisponível não derruba os outros
        "quiet": True,
        "noprogress": True,
        "postprocessor_hooks": [lambda d: on_postprocess(job_id, d)],
        "progress_hooks": [lambda d: on_progress(job_id, d)],
    }
    if req.formato == "mp4":
        opts["format"] = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b"
        opts["merge_output_format"] = "mp4"
    else:
        codec = {"mp3": {"preferredcodec": "mp3", "preferredquality": "192"}, "wav": {"preferredcodec": "wav"}}[req.formato]
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", **codec}, {"key": "FFmpegMetadata"}]
    return opts


def on_progress(job_id: str, d: dict) -> None:
    if d.get("status") == "finished":
        info = d.get("info_dict") or {}
        with lock:
            jobs[job_id]["progresso"] = f"{info.get('playlist_index') or 1}/{info.get('n_entries') or 1}"


def on_postprocess(job_id: str, d: dict) -> None:
    # MoveFiles é o último passo: aí o arquivo já tem o nome e a extensão finais.
    if d.get("status") == "finished" and d.get("postprocessor") == "MoveFiles":
        info = d.get("info_dict") or {}
        path = Path(info.get("filepath") or "")
        if path.is_file():
            with lock:
                jobs[job_id]["arquivos"].append({"nome": path.name, "titulo": info.get("title"), "bytes": path.stat().st_size})


def run(job_id: str, req: DownloadRequest) -> None:
    try:
        with yt_dlp.YoutubeDL(options(job_id, req)) as ydl:
            ydl.download([req.url])
        with lock:
            job = jobs[job_id]
            job["status"] = "ok" if job["arquivos"] else "erro"
            if not job["arquivos"]:
                job["erro"] = "nenhum arquivo baixado (vídeo indisponível, privado ou com restrição de idade?)"
    except Exception as error:  # noqa: BLE001 - qualquer falha do yt-dlp vira mensagem para o usuário
        with lock:
            jobs[job_id].update(status="erro", erro=str(error)[:500])


def cleanup_old_jobs() -> None:
    while True:
        time.sleep(600)
        limit = time.time() - JOB_TTL_SECONDS
        with lock:
            old = [job_id for job_id, job in jobs.items() if job["criado"] < limit]
            for job_id in old:
                jobs.pop(job_id)
        for job_id in old:
            shutil.rmtree(DOWNLOADS / job_id, ignore_errors=True)


threading.Thread(target=cleanup_old_jobs, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "yt_dlp": yt_dlp.version.__version__}


@app.post("/baixar")
def download(req: DownloadRequest) -> dict:
    host = (urlparse(req.url).hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise HTTPException(400, "só links do YouTube (youtube.com, youtu.be, music.youtube.com)")
    job_id = uuid.uuid4().hex[:12]
    with lock:
        jobs[job_id] = {"status": "rodando", "progresso": "0/?", "arquivos": [], "erro": None, "criado": time.time()}
    threading.Thread(target=run, args=(job_id, req), daemon=True).start()
    return {"id": job_id}


@app.get("/trabalhos/{job_id}")
def status(job_id: str) -> dict:
    with lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "trabalho não encontrado")
        return {k: v for k, v in job.items() if k != "criado"}


@app.get("/trabalhos/{job_id}/arquivos/{nome}")
def file(job_id: str, nome: str) -> FileResponse:
    folder = (DOWNLOADS / job_id).resolve()
    path = (folder / nome).resolve()
    if folder not in path.parents or not path.is_file():
        raise HTTPException(404, "arquivo não encontrado")
    return FileResponse(path, filename=nome)


@app.delete("/trabalhos/{job_id}")
def remove(job_id: str) -> dict:
    with lock:
        jobs.pop(job_id, None)
    shutil.rmtree(DOWNLOADS / job_id, ignore_errors=True)
    return {"ok": True}
