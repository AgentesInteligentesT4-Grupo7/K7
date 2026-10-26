"""Serviço local de downloads do YouTube para o módulo "midia" do K7 (yt-dlp + ffmpeg + deno).

- POST /baixar {url, formato: mp3|wav|mp4, playlist, max_itens?} → {id}; o download roda em segundo plano.
  Sem max_itens, a playlist inteira.
- GET /trabalhos/{id} → status (rodando | ok | erro), progresso e arquivos prontos.
- GET /trabalhos/{id}/arquivos/{nome} → o arquivo; DELETE /trabalhos/{id} → apaga a pasta do trabalho.
Só aceita links do YouTube. Os arquivos ficam em /downloads/<id>/ até o K7 copiá-los e apagar.
"""

import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

DOWNLOADS = Path("/downloads")
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
JOB_TTL_SECONDS = 6 * 3600
# Vídeos de uma playlist baixados ao mesmo tempo (YTDLP_PARALELO). Poucos de propósito: muitos downloads
# simultâneos do mesmo IP fazem o YouTube pedir "confirme que você não é um robô" e bloquear por horas.
PARALLEL = max(1, min(6, int(os.environ.get("YTDLP_PARALELO", "3") or 3)))

app = FastAPI(title="ytdlp")
jobs: dict[str, dict] = {}
lock = threading.Lock()


class DownloadRequest(BaseModel):
    url: str = ""
    # Vários vídeos avulsos num só trabalho (ex.: vários links colados, ou tentar de novo os que falharam).
    links: list[str] = Field(default_factory=list, max_length=500)
    formato: str = Field("mp3", pattern="^(mp3|wav|mp4)$")
    playlist: bool = False
    max_itens: int | None = Field(None, ge=1)  # None = a playlist inteira
    # IDs dos vídeos (11 caracteres do link) que o K7 já tem neste formato: não são baixados de novo.
    pular: list[str] = Field(default_factory=list)


# Entre parênteses/colchetes: ruído (sai do nome) e o que diferencia uma versão da outra (fica).
NOISE = re.compile(
    r"official|oficial|v[ií]deo|clipe|\bclip\b|[aá]udio|lyric|letra|legendad|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|\bmv\b|m/v|full album",
    re.IGNORECASE,
)
KEEP = re.compile(r"feat|\bft\b|remix|ao vivo|\blive\b|ac[uú]stic|acoustic|vers[aã]o|version|cover|instrumental|remaster", re.IGNORECASE)
# Caracteres proibidos no Windows e os substitutos que o yt-dlp usa no lugar deles.
FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f｜⧸⧹＂？＊：＜＞]')


def clean_title(title: str, artist: str | None = None, track: str | None = None) -> str:
    """Nome padronizado da música: "Artista - Faixa" quando o YouTube informa, sem "(Official Video)" e afins."""
    name = f"{artist} - {track}" if artist and track else title

    def bracket(match: re.Match) -> str:
        inner = match.group(0)[1:-1]
        return match.group(0) if KEEP.search(inner) else " "

    name = re.sub(r"\([^()]*\)|\[[^\[\]]*\]|【[^】]*】", bracket, name)
    # "Música | Clipe Oficial" / "Música - Official Video": o trecho final só de ruído sai.
    name = re.sub(r"\s*[|｜]\s*[^|｜]*$", lambda m: "" if NOISE.search(m.group(0)) else m.group(0), name)
    name = re.sub(r"\s+[-–—]\s*(official|oficial|clipe|v[ií]deo)\b[^-–—]*$", "", name, flags=re.IGNORECASE)
    name = FORBIDDEN.sub(" ", name)
    name = re.sub(r"\s+[-–—]+\s+", " - ", name)
    name = re.sub(r"\s{2,}", " ", name).strip(" .-–—_")
    return name or "audio"


def failure_reason(message: str) -> str:
    """Motivo, em português, de um vídeo que não pôde ser baixado."""
    text = message.lower()
    if "private" in text:
        return "vídeo privado"
    if "sign in to confirm your age" in text or "age-restricted" in text or "inappropriate" in text:
        return "restrição de idade (o YouTube pede login)"
    if "copyright" in text or "blocked" in text or "not available in your country" in text:
        return "bloqueado (direitos autorais ou região)"
    if "members-only" in text or "join this channel" in text:
        return "só para membros do canal"
    if "unavailable" in text or "removed" in text or "deleted" in text or "does not exist" in text or "terminated" in text:
        return "vídeo excluído ou indisponível"
    if "live event" in text or "premiere" in text:
        return "transmissão ao vivo ou estreia ainda não começou"
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", message)[:200]


class JobLogger:
    """Recebe as mensagens do yt-dlp: cada vídeo que falhou vira {link, motivo} e o download segue com os outros."""

    VIDEO_ERROR = re.compile(r"\[youtube[^\]]*\]\s*([\w-]{11}):\s*(.+)")

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        match = self.VIDEO_ERROR.search(message)
        failure = (
            {"link": f"https://youtu.be/{match.group(1)}", "motivo": failure_reason(match.group(2))}
            if match
            else {"link": None, "motivo": failure_reason(message)}
        )
        with lock:
            failures = jobs[self.job_id]["falhas"]
            if failure not in failures:
                failures.append(failure)


def unique(folder: Path, stem: str, ext: str) -> Path:
    target = folder / f"{stem}{ext}"
    for i in range(2, 10_000):
        if not target.exists():
            return target
        target = folder / f"{stem} ({i}){ext}"
    return target


def options(job_id: str, req: DownloadRequest) -> dict:
    folder = DOWNLOADS / job_id
    # Baixa pelo id (dois vídeos de mesmo título numa playlist não se atropelam) e renomeia no fim (on_postprocess).
    opts: dict = {
        "outtmpl": str(folder / "%(id)s.%(ext)s"),
        "windowsfilenames": True,
        "noplaylist": not req.playlist,
        "playlistend": req.max_itens,
        # Vídeo excluído, privado ou bloqueado: pula, anota em "falhas" (JobLogger) e segue com os outros.
        "ignoreerrors": True,
        "logger": JobLogger(job_id),
        "quiet": True,
        "noprogress": True,
        "postprocessor_hooks": [lambda d: on_postprocess(job_id, d)],
    }
    if req.formato == "mp4":
        opts["format"] = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b"
        opts["merge_output_format"] = "mp4"
    else:
        codec = {"mp3": {"preferredcodec": "mp3", "preferredquality": "192"}, "wav": {"preferredcodec": "wav"}}[req.formato]
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", **codec}, {"key": "FFmpegMetadata"}]
    return opts


def on_postprocess(job_id: str, d: dict) -> None:
    # MoveFiles é o último passo: o arquivo já tem a extensão final; aqui ganha o nome padronizado.
    if d.get("status") == "finished" and d.get("postprocessor") == "MoveFiles":
        info = d.get("info_dict") or {}
        path = Path(info.get("filepath") or "")
        if path.is_file():
            with lock:
                target = unique(path.parent, clean_title(info.get("title") or path.stem, info.get("artist"), info.get("track")), path.suffix)
                path = path.rename(target)
                jobs[job_id]["arquivos"].append({"nome": path.name, "id": info.get("id"), "titulo": info.get("title"), "bytes": path.stat().st_size})


VIDEO_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/live/)([\w-]{11})")


def playlist_entries(job_id: str, req: DownloadRequest) -> tuple[str | None, list[tuple[str, str | None]]]:
    """Título e (link, id) dos vídeos da playlist, sem baixar. Excluídos/privados entram e falham no download, com motivo."""
    listing = {"extract_flat": "in_playlist", "quiet": True, "ignoreerrors": True, "logger": JobLogger(job_id), "playlistend": req.max_itens}
    with yt_dlp.YoutubeDL(listing) as ydl:
        info = ydl.extract_info(req.url, download=False) or {}
    entries = [entry for entry in info.get("entries") or [] if entry and (entry.get("url") or entry.get("id"))]
    return info.get("title"), [(entry.get("url") or f"https://www.youtube.com/watch?v={entry['id']}", entry.get("id")) for entry in entries]


def download_one(job_id: str, req: DownloadRequest, url: str, total: int) -> None:
    single = req.model_copy(update={"playlist": False})
    with yt_dlp.YoutubeDL(options(job_id, single)) as ydl:
        ydl.download([url])
    with lock:
        job = jobs[job_id]
        job["feitos"] = job.get("feitos", 0) + 1
        job["progresso"] = f"{job['feitos']}/{total}"


def run(job_id: str, req: DownloadRequest) -> None:
    try:
        found = VIDEO_ID.search(req.url)
        if req.links:
            title, entries = None, [(link, (VIDEO_ID.search(link) or [None, None])[1]) for link in req.links]
        elif req.playlist:
            title, entries = playlist_entries(job_id, req)
        else:
            title, entries = None, [(req.url, found.group(1) if found else None)]
        # Já baixados antes (pular) e repetidos dentro da própria playlist: não baixa de novo.
        known, urls, skipped, order = set(req.pular), [], [], []
        for url, video_id in entries:
            if video_id and video_id not in order:
                order.append(video_id)
            if video_id and video_id in known:
                if video_id in req.pular and video_id not in skipped:
                    skipped.append(video_id)
                continue
            if video_id:
                known.add(video_id)
            urls.append(url)
        with lock:
            jobs[job_id]["pulados"] = skipped
            # Para a biblioteca do K7: nome da playlist e a ordem original (os downloads em paralelo terminam fora de ordem).
            jobs[job_id]["titulo"] = title
            jobs[job_id]["ordem"] = order
            jobs[job_id]["progresso"] = f"0/{len(urls)}"
        # Alguns vídeos ao mesmo tempo (PARALLEL); cada um no próprio YoutubeDL.
        with ThreadPoolExecutor(max_workers=PARALLEL if req.playlist or len(urls) > 1 else 1) as pool:
            list(pool.map(lambda url: download_one(job_id, req, url, len(urls)), urls))
        with lock:
            job = jobs[job_id]
            job["status"] = "ok" if job["arquivos"] or job["pulados"] else "erro"
            if job["status"] == "erro":
                reasons = sorted({f["motivo"] for f in job["falhas"]})
                job["erro"] = f"nenhum arquivo baixado ({'; '.join(reasons) or 'vídeo indisponível'})"
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
    urls = req.links or [req.url]
    if not all((urlparse(u).hostname or "").lower() in ALLOWED_HOSTS for u in urls):
        raise HTTPException(400, "só links do YouTube (youtube.com, youtu.be, music.youtube.com)")
    job_id = uuid.uuid4().hex[:12]
    with lock:
        jobs[job_id] = {"status": "rodando", "progresso": "0/?", "arquivos": [], "falhas": [], "pulados": [], "erro": None, "criado": time.time()}
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
