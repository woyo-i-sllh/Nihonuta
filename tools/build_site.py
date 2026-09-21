# -*- coding: utf-8 -*-
"""Build the Nihonuta public static site from the read-only lyric source."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

DEFAULT_SOURCE = Path(r"F:\life\songs\日语歌")
DEFAULT_SITE = Path(__file__).resolve().parents[1] / "site"
REPO_URL = "https://github.com/woyo-i-sllh/Nihonuta"
SHARD_COUNT = 32

TITLE_RE = re.compile(r'<h1\s+class="title"[^>]*>(.*?)</h1>', re.I | re.S)
ARTIST_RE = re.compile(r'<div\s+class="artist"[^>]*>(.*?)</div>', re.I | re.S)
CN_TITLE_RE = re.compile(r'<div\s+class="cn-title"[^>]*>(.*?)</div>', re.I | re.S)
ROW_RE = re.compile(
    r'<div\s+class="row"[^>]*>\s*<div\s+class="jp"[^>]*>(.*?)</div>\s*'
    r'<div\s+class="cn"[^>]*>(.*?)</div>\s*</div>',
    re.I | re.S,
)
RT_RE = re.compile(r"<rt[^>]*>(.*?)</rt>", re.I | re.S)
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(?:script|style)\b[^>]*>.*?</(?:script|style)>", re.I | re.S)
LINKS_RE = re.compile(r"window\.__linksInit\s*=\s*(\[.*?\]);", re.I | re.S)


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def clean_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.replace("\xa0", " ").replace("\u3000", " ")
    value = re.sub(r"[ \t\f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{2,}", "\n", value)
    return value.strip()


def plain_without_readings(value: str) -> str:
    value = re.sub(r"<rt[^>]*>.*?</rt>", "", value, flags=re.I | re.S)
    value = re.sub(r"</?(?:ruby|rb|rp)[^>]*>", "", value, flags=re.I)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    return clean_text(TAG_RE.sub("", value))


def reading_text(value: str) -> str:
    return clean_text(" ".join(plain_without_readings(x) for x in RT_RE.findall(value)))


def one_line(value: str, limit: int = 160) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def safe_title_html(value: str) -> str:
    # Generated source pages only use ruby/rt here. Keep those tags and remove
    # everything else so the catalog remains safe if it is ever edited upstream.
    value = html.unescape(value or "")
    allowed = {"ruby", "rt"}
    parts: list[str] = []
    pos = 0
    for match in re.finditer(r"</?([a-zA-Z0-9]+)(?:\s[^>]*)?>", value):
        parts.append(html.escape(value[pos:match.start()], quote=False))
        tag = match.group(1).lower()
        if tag in allowed:
            parts.append(match.group(0))
        pos = match.end()
    parts.append(html.escape(value[pos:], quote=False))
    return "".join(parts).strip()


def file_digest(path: Path) -> tuple[str, str, int]:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    text = data.decode("utf-8", errors="replace")
    return digest, text, len(data)


def parse_song(path: Path, song_id: int) -> tuple[dict, str, str]:
    digest, source, size = file_digest(path)

    title_match = TITLE_RE.search(source)
    artist_match = ARTIST_RE.search(source)
    cn_title_match = CN_TITLE_RE.search(source)

    title_html = title_match.group(1) if title_match else html.escape(path.stem)
    title = plain_without_readings(title_html) or path.stem
    title_reading = reading_text(title_html)
    artist = plain_without_readings(artist_match.group(1)) if artist_match else ""
    cn_title = plain_without_readings(cn_title_match.group(1)) if cn_title_match else ""

    rows = [(plain_without_readings(jp), plain_without_readings(cn)) for jp, cn in ROW_RE.findall(source)]
    row_jp = clean_text("\n".join(jp for jp, _ in rows if jp))
    row_rt = clean_text(" ".join(reading_text(raw_jp) for raw_jp, _ in ROW_RE.findall(source)))
    row_cn = clean_text("\n".join(cn for _, cn in rows if cn))

    link_count = 0
    links_match = LINKS_RE.search(source)
    if links_match:
        try:
            links = json.loads(links_match.group(1))
            if isinstance(links, list):
                link_count = sum(1 for item in links if isinstance(item, list) and len(item) >= 2 and item[1])
        except Exception:
            pass

    preview = ""
    if rows:
        jp, cn = rows[0]
        preview = one_line(" / ".join(x for x in (jp, cn) if x), 150)

    relative_url = "lyrics/" + quote(path.name, safe="")
    item = {
        "i": song_id,
        "t": title,
        "th": safe_title_html(title_html),
        "a": artist,
        "c": cn_title,
        "p": preview,
        "r": title_reading,
        "u": relative_url,
        "m": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date().isoformat(),
        "l": link_count,
    }

    search_text = clean_text(
        "\n".join(
            part
            for part in (
                title,
                title_reading,
                artist,
                cn_title,
                row_jp,
                row_rt,
                row_cn,
                path.stem,
            )
            if part
        )
    )
    signature = hashlib.sha256(
        f"{path.name}\0{digest}\0{size}".encode("utf-8")
    ).hexdigest()
    return item, search_text, signature


def write_json(path: Path, value: object, *, pretty: bool = False) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    else:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    data = text.encode("utf-8")
    path.write_bytes(data)
    return data


def within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="Build the public Nihonuta site.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--site", type=Path, default=DEFAULT_SITE)
    parser.add_argument("--no-clean", action="store_true", help="Do not remove generated lyrics/data before rebuilding")
    args = parser.parse_args()

    source_dir = args.source.resolve()
    site_dir = args.site.resolve()
    if not source_dir.is_dir():
        print(f"Source directory does not exist: {source_dir}", file=sys.stderr)
        return 2
    if source_dir == site_dir or within(source_dir, site_dir) or within(site_dir, source_dir):
        print("Source and site directories must be separate and must not contain one another.", file=sys.stderr)
        return 2

    html_files = sorted(
        (p for p in source_dir.glob("*.html") if p.is_file() and p.name.lower() != "index.html"),
        key=lambda p: (unicodedata.normalize("NFKC", p.name).casefold(), p.name),
    )
    if not html_files:
        print(f"No lyric HTML files found in {source_dir}", file=sys.stderr)
        return 2

    site_dir.mkdir(parents=True, exist_ok=True)
    lyrics_dir = site_dir / "lyrics"
    search_dir = site_dir / "data" / "search"

    if not args.no_clean:
        for generated in (lyrics_dir, search_dir):
            if generated.exists() and within(generated, site_dir):
                shutil.rmtree(generated)

    lyrics_dir.mkdir(parents=True, exist_ok=True)
    search_dir.mkdir(parents=True, exist_ok=True)

    catalog: list[dict] = []
    full_items: list[tuple[int, str]] = []
    signatures: list[str] = []
    failure_count = 0
    copied_bytes = 0

    print(f"Building {len(html_files)} lyric pages...")
    for index, source_path in enumerate(html_files, start=1):
        try:
            item, search_text, signature = parse_song(source_path, index)
        except Exception as exc:
            failure_count += 1
            print(f"  ! {source_path.name}: {exc}", file=sys.stderr)
            continue

        target = lyrics_dir / source_path.name
        shutil.copy2(source_path, target)
        copied_bytes += source_path.stat().st_size
        catalog.append(item)
        full_items.append((index, search_text))
        signatures.append(signature)

        if index % 250 == 0:
            print(f"  {index}/{len(html_files)}")

    if not catalog:
        print("No pages could be parsed.", file=sys.stderr)
        return 2

    catalog_bytes = write_json(site_dir / "data" / "catalog.json", catalog)
    source_revision = hashlib.sha256("".join(sorted(signatures)).encode("ascii")).hexdigest()

    shard_size = max(1, (len(full_items) + SHARD_COUNT - 1) // SHARD_COUNT)
    shard_names: list[str] = []
    for shard_index in range(0, len(full_items), shard_size):
        shard_number = len(shard_names)
        shard_name = f"{shard_number:02d}.json"
        shard = [[song_id, text] for song_id, text in full_items[shard_index:shard_index + shard_size]]
        write_json(search_dir / shard_name, shard)
        shard_names.append(shard_name)

    artists = Counter(item["a"] for item in catalog if item["a"])
    latest_source = max((p.stat().st_mtime for p in html_files), default=0)
    generated_dt = datetime.fromtimestamp(latest_source, tz=timezone.utc).replace(microsecond=0)
    generated_at = generated_dt.isoformat().replace("+00:00", "Z")
    latest_source_date = generated_dt.date().isoformat() if latest_source else ""
    version = f"{generated_dt.strftime('%Y%m%d')}-{source_revision[:10]}"

    manifest = {
        "count": len(full_items),
        "shards": shard_names,
        "generated_at": generated_at,
        "version": version,
    }
    site_meta = {
        "name": "Nihonuta",
        "title": "日本歌",
        "description": "可搜索、可查阅的日语歌词卡资料库",
        "version": version,
        "generated_at": generated_at,
        "latest_source_date": latest_source_date,
        "song_count": len(catalog),
        "artist_count": len(artists),
        "catalog_url": "data/catalog.json",
        "search_manifest_url": "data/search/manifest.json",
        "repository": REPO_URL,
        "source_revision": source_revision,
    }
    write_json(site_dir / "data" / "search" / "manifest.json", manifest)
    write_json(site_dir / "data" / "site.json", site_meta, pretty=True)
    (site_dir / ".nojekyll").write_text("", encoding="utf-8")

    print()
    print(f"Built: {len(catalog)} songs, {len(artists)} artists")
    print(f"Lyrics: {copied_bytes / 1024 / 1024:.2f} MiB")
    print(f"Catalog: {len(catalog_bytes) / 1024:.1f} KiB")
    print(f"Shards: {len(shard_names)}")
    print(f"Version: {version}")
    if failure_count:
        print(f"Failures: {failure_count}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())