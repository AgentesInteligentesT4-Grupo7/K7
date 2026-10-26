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
from urllib.parse import quote, urlparse

import json
import subprocess

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from nomes import filename as standard_filename
from nomes import standardize
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


def read_tags(path: Path) -> dict:
    """Etiquetas do arquivo (title, artist, encoded_by...), em minúsculas."""
    probe = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)], capture_output=True, text=True, timeout=120)
    try:
        tags = json.loads(probe.stdout or "{}").get("format", {}).get("tags") or {}
    except json.JSONDecodeError:
        return {}
    return {str(k).lower(): v for k, v in tags.items()}


def write_tags(source: Path, target: Path, title: str, artist: str | None) -> None:
    """Grava título e artista (e a marca encoded_by=K7) sem mexer no áudio nem no vídeo (cópia direta)."""
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0", "-c", "copy", "-map_metadata", "0",
            "-metadata", f"title={title}", "-metadata", f"artist={artist or ''}", "-metadata", "encoded_by=K7"]
    if source.suffix.lower() == ".mp3":
        args += ["-id3v2_version", "3"]
    run = subprocess.run([*args, str(target)], capture_output=True, text=True, timeout=600)
    if run.returncode != 0 or not target.is_file():
        raise RuntimeError(f"ffmpeg falhou ao gravar as etiquetas: {run.stderr[-300:]}")


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
    """MoveFiles é o último passo (extensão final): o arquivo ganha "Título - Artista" e as etiquetas.

    Dois vídeos com o mesmo nome padronizado são a mesma música: fica um arquivo só (sem "(2)").
    """
    if d.get("status") != "finished" or d.get("postprocessor") != "MoveFiles":
        return
    info = d.get("info_dict") or {}
    path = Path(info.get("filepath") or "")
    if not path.is_file():
        return
    # Com artista e faixa informados pelo YouTube (YouTube Music), eles valem mais que o título do vídeo.
    source = f"{info['artist']} - {info['track']}" if info.get("artist") and info.get("track") else (info.get("title") or path.stem)
    title, artist = standardize(source)
    with lock:
        target = path.parent / f"{standard_filename(title, artist)}{path.suffix}"
        duplicate = target.exists() and target != path
        if not duplicate:
            path = path.rename(target)
    if duplicate:
        path.unlink(missing_ok=True)
        path = target
    else:
        tagged = path.with_name(f".etiquetas-{uuid.uuid4().hex}{path.suffix}")
        try:
            write_tags(path, tagged, title, artist)
            os.replace(tagged, path)
        except Exception:  # noqa: BLE001 - sem etiqueta, o arquivo continua bom
            tagged.unlink(missing_ok=True)
    with lock:
        jobs[job_id]["arquivos"].append({"nome": path.name, "id": info.get("id"), "titulo": title, "bytes": path.stat().st_size})


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


# ── Nivelamento de volume (EBU R128, ffmpeg loudnorm em duas passadas) ─────────
TARGET_LUFS = float(os.environ.get("NIVELAR_LUFS", "-14") or -14)  # padrão das plataformas de música
LEVEL_DIR = Path("/tmp/nivelar")
MAX_LEVEL_BYTES = 2 * 1024**3
# Codec de áudio por extensão: o arquivo nivelado sai no mesmo formato. Vídeo: a imagem é copiada, só o áudio muda.
AUDIO_CODECS = {
    ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    ".wav": ["-c:a", "pcm_s16le"],
    ".m4a": ["-c:a", "aac", "-b:a", "192k"],
    ".aac": ["-c:a", "aac", "-b:a", "192k"],
    ".ogg": ["-c:a", "libvorbis", "-q:a", "6"],
    ".opus": ["-c:a", "libopus", "-b:a", "160k"],
    ".flac": ["-c:a", "flac"],
    ".mp4": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
    ".mkv": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
    ".webm": ["-c:v", "copy", "-c:a", "libopus", "-b:a", "160k"],
    ".mov": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
}


def level_file(source: Path, target: Path) -> dict:
    """Mede o volume (1ª passada) e aplica a correção exata (2ª), sem distorcer. Devolve o volume antes e depois."""
    base = f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11"
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(source), "-af", f"{base}:print_format=json", "-vn", "-f", "null", "-"],
        capture_output=True, text=True, timeout=1800,
    )
    found = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", probe.stderr)
    if probe.returncode != 0 or not found:
        raise HTTPException(422, "não consegui ler o áudio desse arquivo")
    m = json.loads(found.group(0))
    measured = (
        f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
        f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    codec = AUDIO_CODECS[source.suffix.lower()]
    run = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0", "-map_metadata", "0", "-af", measured, "-ar", "48000" if source.suffix.lower() in {".opus", ".webm"} else "44100", *codec, str(target)],
        capture_output=True, text=True, timeout=3600,
    )
    if run.returncode != 0 or not target.is_file():
        raise HTTPException(500, f"ffmpeg falhou ao nivelar: {run.stderr[-300:]}")
    return {"antes": float(m["input_i"]), "depois": TARGET_LUFS}


def standardize_file(source: Path, target: Path, nome: str) -> dict:
    tags = read_tags(source)
    title, artist = standardize(Path(nome).stem, tags)
    new_name = f"{standard_filename(title, artist)}{source.suffix.lower() if not Path(nome).suffix else Path(nome).suffix}"
    unchanged = tags.get("encoded_by") == "K7" and tags.get("title") == title and (tags.get("artist") or None) == artist
    if not unchanged:
        write_tags(source, target, title, artist)
    return {"nome": new_name, "titulo": title, "artista": artist or "", "mudou": not unchanged}


@app.post("/padronizar")
async def standardize_endpoint(request: Request, nome: str) -> Response:
    """Recebe o arquivo (nome= é o nome atual) e devolve o nome "Título - Artista" nos cabeçalhos.

    Corpo da resposta: o arquivo com título e artista gravados nas etiquetas; 204 quando as etiquetas já estavam
    certas (aí só o nome pode ter mudado e quem chamou só renomeia).
    """
    ext = Path(nome).suffix.lower()
    if ext not in AUDIO_CODECS:
        raise HTTPException(415, f"formato {ext or '(sem extensão)'} não suportado")
    work = LEVEL_DIR / uuid.uuid4().hex
    work.mkdir(parents=True)
    source, target = work / f"in{ext}", work / f"out{ext}"
    size = 0
    with source.open("wb") as out:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_LEVEL_BYTES:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(413, "arquivo grande demais (até 2 GB)")
            out.write(chunk)
    try:
        result = await run_in_threadpool(standardize_file, source, target, nome)
    except Exception as error:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(500, str(error)[:300]) from error
    headers = {"X-Nome": quote(result["nome"]), "X-Titulo": quote(result["titulo"]), "X-Artista": quote(result["artista"])}
    if not result["mudou"]:
        shutil.rmtree(work, ignore_errors=True)
        return Response(status_code=204, headers=headers)
    return FileResponse(target, headers=headers, background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))


@app.post("/nivelar")
async def level(request: Request, nome: str) -> FileResponse:
    """Recebe o arquivo no corpo (nome= dá a extensão) e devolve a versão nivelada no mesmo formato."""
    ext = Path(nome).suffix.lower()
    if ext not in AUDIO_CODECS:
        raise HTTPException(415, f"formato {ext or '(sem extensão)'} não suportado para nivelar")
    work = LEVEL_DIR / uuid.uuid4().hex
    work.mkdir(parents=True)
    source, target = work / f"in{ext}", work / f"out{ext}"
    size = 0
    with source.open("wb") as out:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_LEVEL_BYTES:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(413, "arquivo grande demais para nivelar (até 2 GB)")
            out.write(chunk)
    try:
        result = await run_in_threadpool(level_file, source, target)
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return FileResponse(
        target,
        filename=Path(nome).name,
        headers={"X-Volume-Antes": f"{result['antes']:.1f}", "X-Volume-Depois": f"{result['depois']:.1f}"},
        background=BackgroundTask(shutil.rmtree, work, ignore_errors=True),
    )


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
