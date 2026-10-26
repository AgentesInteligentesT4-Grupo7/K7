"""Nome padronizado das músicas do K7: "Título - Artista", sem cópias "(2)", sem "(Official Video)" e afins.

Regras:
- o YouTube costuma escrever "Artista - Título": o primeiro pedaço vira o artista, o resto o título;
  "Título by Artista" também é entendido;
- vários artistas ficam juntos, como vieram ("ZAYN, Taylor Swift", "Swedish House Mafia ft. John Martin");
- participação no título ("Side To Side ft. Nicki Minaj", "(feat. Sean Paul)") vai para o artista,
  e o que o título repete do artista sai do título, junto com o separador que sobrar;
- arquivo já padronizado (etiqueta encoded_by=K7) usa título e artista das etiquetas: rodar de novo não inverte nada.
"""

import re

# Entre parênteses/colchetes: ruído (sai) e o que diferencia uma versão da outra (fica).
NOISE = re.compile(
    r"official|oficial|v[ií]deo|clipe|\bclip\b|[aá]udio|lyric|letra|legendad|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|\bmv\b|m/v|full album",
    re.IGNORECASE,
)
KEEP = re.compile(r"remix|ao vivo|\blive\b|ac[uú]stic|acoustic|vers[aã]o|version|cover|instrumental|remaster", re.IGNORECASE)
# Ruído solto no fim do nome (fora de parênteses).
TRAILING = re.compile(
    r"(?:\s*[-|~]\s*|\s+)(?:vevo|official\s+(?:music\s+)?(?:video|audio)|lyric\s+video|lyrics?|letra|legendado|clipe\s+oficial|v[ií]deo\s+oficial"
    r"|on\s+spotify(?:\s*(?:&|and)\s*apple(?:\s+music)?)?)\s*$",
    re.IGNORECASE,
)
COPY_MARK = re.compile(r"\s*\(\d{1,3}\)\s*$")  # "(2)": cópia de um download repetido
TRACK_NUMBER = re.compile(r"^\d{1,3}\s*-\s+")  # "017 - ": numeração antiga de playlist
TRACK_NUMBER_DOT = re.compile(r"^\d{1,3}\.\s+")  # "1. Blue Swede": numeração de faixa grudada no artista
SEPARATOR = re.compile(r"\s+[-–—~]\s+|\s+[-–—]\s*(?=\S)|(?<=\S)\s*[-–—]\s+")
FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^\)\]]+?)\s*[\)\]]?\s*$", re.IGNORECASE)
BY = re.compile(r"^(.+?)\s+by\s+(.+)$", re.IGNORECASE)
ARTIST_SPLIT = re.compile(r"\s*(?:,|&|\+|\bx\b|\be\b|\band\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*", re.IGNORECASE)
FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f｜⧸⧹＂？＊：＜＞]')


def _brackets(text: str) -> str:
    """Tira os parênteses/colchetes de ruído; os de versão ("(Remix)", "(Ao Vivo)", "(cover by ...)") ficam."""

    def keep_or_drop(m: re.Match[str]) -> str:
        inside = m.group(1).strip()
        if KEEP.search(inside) and not re.search(r"official|oficial", inside, re.IGNORECASE):
            return f" ({inside})"
        return "" if NOISE.search(inside) else m.group(0)

    return re.sub(r"\s*[\(\[]\s*([^\)\]]*?)\s*[\)\]]", keep_or_drop, text)


def _tidy(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    # Separador, vírgula ou "&" que sobrou na ponta depois de tirar algo ("Título -", "- Título").
    text = re.sub(r"^(?:[-–—~,&|+]\s*)+|(?:\s*[-–—~,&|+])+$", "", text).strip()
    if text.endswith(".") and not text.endswith(".."):
        text = text[:-1].rstrip()
    return text


def clean(text: str) -> str:
    """Tira cópia "(2)", numeração, "(Official Video)", "[Official Audio]", "Vevo"... de um título ou nome."""
    text = TRACK_NUMBER.sub("", text.strip())
    for _ in range(3):
        before = text
        text = COPY_MARK.sub("", text)
        text = _brackets(text)
        text = TRAILING.sub("", text)
        text = _tidy(text)
        if text == before:
            break
    return text


def _names(artist: str) -> list[str]:
    return [n.strip() for n in ARTIST_SPLIT.split(artist) if len(n.strip()) > 1]


def _without_artists(title: str, artist: str) -> str:
    """Tira do título o que repete o artista ("Side To Side ft. Nicki Minaj" com artista "... ft. Nicki Minaj")."""
    for name in sorted(_names(artist), key=len, reverse=True):
        title = re.sub(rf"(?:^|\s)(?:feat\.?|ft\.?|featuring|com|with)?\s*{re.escape(name)}(?=\s|$|[,&)\]])", " ", title, flags=re.IGNORECASE)
    title = re.sub(r"[\(\[]\s*(?:feat\.?|ft\.?|featuring)?\s*[,&]?\s*[\)\]]", "", title, flags=re.IGNORECASE)
    return _tidy(title)


def _add_featuring(artist: str, featured: str) -> str:
    """Junta a participação ao artista, sem repetir quem já está lá."""
    known = {n.lower() for n in _names(artist)}
    new = [n for n in _names(featured) if n.lower() not in known]
    if not new:
        return artist
    return f"{artist} ft. {' & '.join(new)}" if artist else " & ".join(new)


def _finish(title: str, artist: str | None) -> tuple[str, str | None]:
    """Acertos finais: numeração e versão fora do artista, participação no artista, título sem repetir o artista."""
    title = clean(title)
    if not artist:
        return title, None
    artist = TRACK_NUMBER_DOT.sub("", clean(artist))
    # Versão ("(... cover)", "(Remix)", "(Ao Vivo)") é do título, não do artista.
    for match in list(re.finditer(r"\s*\(([^)]*)\)", artist)):
        if KEEP.search(match.group(1)):
            artist = artist.replace(match.group(0), "")
            title = f"{title} ({match.group(1).strip()})"
    artist = _tidy(artist)
    # Participação no título vai para o artista ("Potion ft Dua Lipa & Young Thug"), mas não a que está dentro de um
    # parêntese de versão ("(Boyce Avenue feat. Fifth Harmony cover)" fica no título).
    feat = FEAT.search(title)
    if feat and title[: feat.start()].count("(") == title[: feat.start()].count(")"):
        artist = _add_featuring(artist, feat.group(1))
        title = _tidy(title[: feat.start()])
    return _without_artists(title, artist) or title, artist or None


def standardize(name: str, tags: dict | None = None) -> tuple[str, str | None]:
    """(título, artista) a partir do nome do arquivo (sem extensão) e das etiquetas, quando houver."""
    tags = {k.lower(): str(v).strip() for k, v in (tags or {}).items() if v}
    if tags.get("encoded_by") == "K7" and tags.get("title"):
        return _finish(tags["title"], tags.get("artist") or None)

    base = clean(name)
    artist: str | None = None
    parts = SEPARATOR.split(base, maxsplit=1)
    if len(parts) == 2 and parts[0] and parts[1]:
        artist, title = parts[0], parts[1]
    elif (by := BY.match(base)) and "(" not in by.group(1):
        title, artist = by.group(1), by.group(2)
    else:
        title = base
        tag_artist = tags.get("artist") or tags.get("album_artist")
        # Etiqueta do YouTube costuma trazer o canal ("FulanoVEVO", "Fulano - Topic"): só serve se parecer artista.
        if tag_artist and not re.search(r"vevo$|- topic$|official|oficial", tag_artist, re.IGNORECASE):
            artist = tag_artist

    return _finish(title, artist)


def filename(title: str, artist: str | None) -> str:
    """"Título - Artista" (ou só o título), sem caracteres proibidos no Windows, até 180 caracteres."""
    name = f"{title} - {artist}" if artist else title
    name = FORBIDDEN.sub(" ", name)
    # O Windows só proíbe ponto e espaço no fim do nome ("...Baby One More Time" é válido).
    name = re.sub(r"\s+", " ", name).strip().rstrip(" .")
    return name[:180].rstrip(" .") or "sem nome"
