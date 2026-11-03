"""Speech-to-text for recorded consultations: Sarvam's batch API (saaras:v3, Indian languages and
code-mixed speech, with speaker diarization). Ported from engageomedicalscribe
(packages/pipeline/transcribe/src/providers/sarvam-batch-transcriber.ts).

Job lifecycle: init -> upload-files (presigned URL) -> PUT audio -> start -> poll status -> download.
The browser's recording is converted to 16 kHz mono WAV with ffmpeg first. Sarvam's text is kept
exactly as returned; nothing here rewrites it.
"""

import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

BASE_URL = "https://api.sarvam.ai"
HTTP_TIMEOUT = 60
POLL_SECONDS = 3


class SarvamError(RuntimeError):
    pass


def enabled() -> bool:
    key = (get_settings().sarvam_api_key or "").strip()
    return bool(key) and "your" not in key.lower() and "placeholder" not in key.lower()


def to_wav(path: Path) -> Path:
    """A 16 kHz mono WAV copy in a temp folder. Raises SarvamError if ffmpeg cannot read the file."""
    if not shutil.which("ffmpeg"):
        raise SarvamError("ffmpeg is not installed on the server")
    out = Path(tempfile.mkdtemp(prefix="scribe-")) / "audio.wav"
    try:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "16000", str(out)],
                       check=True, timeout=600, capture_output=True)
    except (subprocess.SubprocessError, OSError) as e:
        raise SarvamError(f"could not read the recording: {e}") from e
    return out


def _call(client: httpx.Client, method: str, path: str, json: dict | None = None) -> Any:
    try:
        r = client.request(method, f"{BASE_URL}{path}", json=json)
    except httpx.HTTPError as e:
        raise SarvamError(f"cannot reach Sarvam ({path}): {e}") from e
    if r.status_code >= 400:
        raise SarvamError(f"Sarvam {path} failed ({r.status_code}): {r.text[:300]}")
    return r.json()


def _url(entry: Any) -> str | None:
    return entry if isinstance(entry, str) else (entry or {}).get("file_url")


def turns_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Diarized entries as turns [{turn_index, speaker, text}]; consecutive entries of one speaker
    are joined. Without diarization, the whole transcript is one turn."""
    turns: list[dict[str, Any]] = []
    for e in (result.get("diarized_transcript") or {}).get("entries") or []:
        text = str(e.get("transcript") or "").strip()
        if not text:
            continue
        try:
            speaker = int(str(e.get("speaker_id", "")).replace("SPEAKER_", "").strip())
        except ValueError:
            speaker = None
        if turns and turns[-1]["speaker"] == speaker:
            turns[-1]["text"] += " " + text
        else:
            turns.append({"turn_index": len(turns), "speaker": speaker, "text": text})
    if not turns and str(result.get("transcript") or "").strip():
        turns = [{"turn_index": 0, "speaker": None, "text": str(result["transcript"]).strip()}]
    return turns


def transcribe(path: Path) -> list[dict[str, Any]]:
    s = get_settings()
    if not enabled():
        raise SarvamError("Sarvam is not connected: set SARVAM_API_KEY on the server")
    wav = to_wav(path)
    try:
        with httpx.Client(headers={"api-subscription-key": s.sarvam_api_key.strip()}, timeout=HTTP_TIMEOUT) as c:
            params = {"model": s.sarvam_stt_model, "mode": "transcribe", "language_code": s.sarvam_stt_language,
                      "with_diarization": True, "num_speakers": 2}
            job = _call(c, "POST", "/speech-to-text/job/v1", {"job_parameters": params}).get("job_id")
            if not job:
                raise SarvamError("Sarvam returned no job id")
            up = _call(c, "POST", "/speech-to-text/job/v1/upload-files", {"job_id": job, "files": ["audio.wav"]})
            upload_url = _url((up.get("upload_urls") or {}).get("audio.wav"))
            if not upload_url:
                raise SarvamError("Sarvam returned no upload URL")
            put = httpx.put(upload_url, content=wav.read_bytes(), timeout=600,
                            headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "audio/wav"})
            if put.status_code >= 400:
                raise SarvamError(f"uploading the audio to Sarvam failed ({put.status_code})")
            _call(c, "POST", f"/speech-to-text/job/v1/{job}/start")
            deadline, output = time.monotonic() + s.sarvam_max_wait_seconds, "0.json"
            while True:
                st = _call(c, "GET", f"/speech-to-text/job/v1/{job}/status")
                state = str(st.get("job_state") or "")
                if state == "Completed":
                    outs = ((st.get("job_details") or [{}])[0].get("outputs") or [{}])
                    output = outs[0].get("file_name") or output
                    break
                if state == "Failed":
                    detail = st.get("error_message") or (st.get("job_details") or [{}])[0].get("error_message")
                    raise SarvamError(f"Sarvam could not transcribe it: {detail or 'unknown error'}")
                if time.monotonic() > deadline:
                    raise SarvamError(f"Sarvam did not finish within {s.sarvam_max_wait_seconds} s")
                time.sleep(POLL_SECONDS)
            dl = _call(c, "POST", "/speech-to-text/job/v1/download-files", {"job_id": job, "files": [output]})
            download_url = _url((dl.get("download_urls") or {}).get(output))
            if not download_url:
                raise SarvamError("Sarvam returned no download URL")
            r = httpx.get(download_url, timeout=HTTP_TIMEOUT)
            if r.status_code >= 400:
                raise SarvamError(f"downloading the transcript failed ({r.status_code})")
            return turns_from_result(r.json())
    finally:
        shutil.rmtree(wav.parent, ignore_errors=True)
