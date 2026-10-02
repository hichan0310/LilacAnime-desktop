#!/usr/bin/env python3
"""Translate ASS/SRT/WebVTT subtitles to natural Korean with Gemini."""

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ASS_TAG = re.compile(r"\{[^}]*\}")
HTML_TAG = re.compile(r"<[^>]+>")
ASS_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[.](\d{2})")
TIMING = re.compile(
    r"^\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+"
    r"((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})(.*)$"
)


def time_seconds(value):
    parts = value.replace(",", ".").split(":")
    seconds = float(parts[-1]) + int(parts[-2]) * 60
    if len(parts) == 3:
        seconds += int(parts[0]) * 3600
    return seconds


def ass_time(value):
    match = ASS_TIME.fullmatch(value.strip())
    if not match:
        return "00:00:00.000"
    hour, minute, second, centisecond = map(int, match.groups())
    return f"{hour:02d}:{minute:02d}:{second:02d}.{centisecond * 10:03d}"


def parse_ass(source):
    cues = []
    for line in source.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        fields = line.split(":", 1)[1].lstrip().split(",", 9)
        if len(fields) < 10:
            continue
        text = ASS_TAG.sub("", fields[9]).replace(r"\N", "\n").replace(r"\n", "\n").strip()
        if text:
            cue = {"start": ass_time(fields[1]), "end": ass_time(fields[2]), "text": text}
            speaker = fields[4].strip()
            if speaker and speaker not in ("0", "Default", "default"):
                cue["speaker"] = speaker
            cues.append(cue)
    return cues


def normalize_time(value):
    value = value.replace(",", ".")
    return value if value.count(":") == 2 else "00:" + value


def parse_timed_text(source):
    lines = source.replace("\r\n", "\n").split("\n")
    cues = []
    index = 0
    while index < len(lines):
        match = TIMING.match(lines[index])
        if not match:
            index += 1
            continue
        start, end = normalize_time(match.group(1)), normalize_time(match.group(2))
        index += 1
        text_lines = []
        while index < len(lines) and lines[index].strip():
            text_lines.append(ASS_TAG.sub("", HTML_TAG.sub("", lines[index])).strip())
            index += 1
        text = "\n".join(line for line in text_lines if line).strip()
        if text:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def parse_subtitles(source):
    if "[Script Info]" in source or re.search(r"^Dialogue:", source, re.MULTILINE):
        return parse_ass(source)
    return parse_timed_text(source)


def decode_subtitle(data):
    candidates = []
    for encoding in ("utf-8-sig", "utf-16", "cp932"):
        try:
            text = data.decode(encoding)
            candidates.append((text.count("\ufffd"), text))
        except (UnicodeDecodeError, UnicodeError):
            continue
    if candidates:
        return min(candidates, key=lambda item: item[0])[1]
    return data.decode("utf-8", "replace")


def normalize_subtitle_array(value):
    if isinstance(value, list):
        items = value
    elif isinstance(value, dict):
        items = None
        for key in ("subtitles", "translations", "items", "results", "result", "cues", "data"):
            if isinstance(value.get(key), list):
                items = value[key]
                break
        if items is None and value and all(str(key).isdigit() for key in value):
            items = [
                {**(item if isinstance(item, dict) else {"text": item}), "id": int(key)}
                for key, item in value.items()
                if isinstance(item, (str, dict))
            ]
        if items is None and "id" in value and "text" in value:
            items = [value]
        if items is None:
            raise ValueError("Gemini response JSON did not contain a subtitle array")
    else:
        raise ValueError("Gemini response JSON was not an array or object")

    if not all(isinstance(item, dict) and "id" in item and "text" in item for item in items):
        raise ValueError("Gemini response contained subtitle entries without id/text")
    return items


def extract_json(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    # Structured output normally reaches the first branch. The remaining branches recover common Gemini
    # deviations without silently accepting prose or structurally incomplete subtitle entries.
    try:
        return normalize_subtitle_array(json.loads(cleaned))
    except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
        pass
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start >= 0 and end >= start:
        try:
            return normalize_subtitle_array(json.loads(cleaned[start : end + 1]))
        except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
            pass
    object_start, object_end = cleaned.find("{"), cleaned.rfind("}")
    if object_start >= 0 and object_end >= object_start:
        try:
            return normalize_subtitle_array(json.loads(cleaned[object_start : object_end + 1]))
        except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
            pass
    try:
        json_lines = [json.loads(line.rstrip(",")) for line in cleaned.splitlines() if line.strip()]
        return normalize_subtitle_array(json_lines)
    except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
        raise ValueError("Gemini response did not contain a valid subtitle JSON array")


def extract_json_object(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Gemini response did not contain a JSON object")
    return json.loads(cleaned[start : end + 1])


class GeminiHttpError(RuntimeError):
    def __init__(self, status, model, detail, retry_wait=None):
        super().__init__(f"Gemini model {model} HTTP {status}: {detail[:2000]}")
        self.status = status
        self.model = model
        self.detail = detail
        self.retry_wait = retry_wait


def record_event(event, **fields):
    draft_path = os.environ.get("LILAC_TRANSLATION_DRAFT_PATH", "").strip()
    if not draft_path:
        return
    path = Path(draft_path).with_suffix(".events.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps({"time": time.time(), "event": event, **fields}, ensure_ascii=False) + "\n")


def configured_models(primary):
    configured = os.environ.get(
        "GEMINI_FALLBACK_MODELS",
        "gemini-3.8-flash,gemini-3.7-flash,gemini-2.5-flash",
    )
    result = []
    for model in [primary, *configured.split(",")]:
        model = model.strip()
        if model and model not in result:
            result.append(model)
    return result


_key_cursor = 0


def configured_api_keys(primary=""):
    return list(dict.fromkeys(key.strip() for key in
        [primary, *re.split(r"[,;\n]", os.environ.get("GEMINI_API_KEYS", ""))]
        if key.strip()))


def redact_keys(message):
    for key in configured_api_keys(os.environ.get("GEMINI_API_KEY", "")):
        message = message.replace(key, "[REDACTED]")
    return message


def request_with_keys(payload, api_key, model, on_chunk=None):
    global _key_cursor
    keys = configured_api_keys(api_key)
    if not keys:
        raise RuntimeError("GEMINI_API_KEY / GEMINI_API_KEYS is empty")
    start = _key_cursor % len(keys)
    for offset in range(len(keys)):
        index = (start + offset) % len(keys)
        _key_cursor = index + 1
        try:
            return request_gemini_model(payload, keys[index], model, on_chunk=on_chunk)
        except GeminiHttpError as error:
            error.detail = redact_keys(error.detail)
            invalid_key = error.status == 400 and (
                "API_KEY_INVALID" in error.detail or "api key not valid" in error.detail.lower()
            )
            if (error.status not in (401, 403, 429) and not invalid_key) or offset == len(keys) - 1:
                raise GeminiHttpError(error.status, error.model, error.detail, error.retry_wait) from None
            record_event("key_fallback", model=model, status=error.status, key_number=index + 1, key_count=len(keys))
            print(f"LILAC_PROGRESS\t2\t3\tGemini 키 {index + 1}/{len(keys)} HTTP {error.status} · 다음 키로 다시 요청하고 있어요…",
                  file=sys.stderr, flush=True)


def request_gemini_model(payload, api_key, model, on_chunk=None):
    generation_config = dict(payload["generationConfig"])
    if model == "gemini-2.5-flash":
        # Thinking and the complete episode's JSON share the model's 65,536-token limit.
        generation_config["thinkingConfig"] = {"thinkingBudget": 24576}
    elif model == "gemini-3-flash-preview":
        generation_config["thinkingConfig"] = {"thinkingLevel": "medium"}
    payload = {**payload, "generationConfig": generation_config}
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model, safe="-._")
        + ":streamGenerateContent?alt=sse"
    )
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    max_attempts = 2
    for attempt in range(max_attempts):
        retry_wait = None
        if on_chunk:
            on_chunk(0)
        record_event("request_started", model=model, attempt=attempt + 1)
        try:
            pieces = []
            finish_reason = ""
            draft_path = os.environ.get("LILAC_TRANSLATION_DRAFT_PATH", "").strip()
            stream_path = None
            if draft_path:
                safe_model = re.sub(r"[^a-zA-Z0-9_.-]", "_", model)
                stream_path = Path(draft_path).with_suffix(f".{safe_model}.response.txt")
                stream_path.parent.mkdir(parents=True, exist_ok=True)
                stream_path.write_text("", encoding="utf-8")
            # Full-episode generation has no wall-clock deadline. SSE supplies progress as it arrives.
            with urllib.request.urlopen(request, timeout=None) as response:
                event_lines = []
                received_chars = 0

                def receive_event():
                    nonlocal finish_reason, received_chars
                    if not event_lines:
                        return
                    raw = "\n".join(event_lines)
                    event_lines.clear()
                    if raw == "[DONE]":
                        return
                    result = json.loads(raw)
                    if result.get("usageMetadata"):
                        record_event("usage", model=model, usage=result["usageMetadata"])
                    if result.get("error"):
                        error = result["error"]
                        raise GeminiHttpError(error.get("code", 502), model, error.get("message", "Stream error"))
                    if result.get("promptFeedback", {}).get("blockReason"):
                        raise GeminiHttpError(400, model, str(result["promptFeedback"]))
                    candidates = result.get("candidates") or []
                    if not candidates:
                        return
                    candidate = candidates[0]
                    finish_reason = candidate.get("finishReason") or finish_reason
                    for part in candidate.get("content", {}).get("parts", []):
                        if part.get("thought"):
                            continue
                        fragment = part.get("text", "")
                        if fragment:
                            pieces.append(fragment)
                            if stream_path:
                                with stream_path.open("a", encoding="utf-8") as output:
                                    output.write(fragment)
                            received_chars += len(fragment)
                            if on_chunk:
                                on_chunk(received_chars)

                for raw_line in response:
                    line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
                    if line.startswith("data:"):
                        event_lines.append(line[5:].lstrip())
                    elif not line:
                        receive_event()
                receive_event()
            text = "".join(pieces).strip()
            if finish_reason == "MAX_TOKENS":
                complete_rows = extract_complete_prefix(text)
                if complete_rows:
                    record_event("response_partial", model=model, completed_cues=len(complete_rows))
                    return json.dumps(complete_rows, ensure_ascii=False)
            if finish_reason != "STOP":
                raise GeminiHttpError(
                    502,
                    model,
                    f"Gemini response ended with finishReason={finish_reason}",
                )
            if not text:
                raise GeminiHttpError(502, model, "Gemini returned an empty response")
            record_event("response_complete", model=model, characters=len(text))
            return text
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            record_event("http_error", model=model, status=error.code)
            if error.code not in (429, 500, 502, 503, 504):
                raise GeminiHttpError(error.code, model, detail) from error
            if error.code == 429:
                # Per-model daily limits can be bypassed by the configured fallback model, not by hammering this one.
                if "PerDay" in detail or "per day" in detail.lower():
                    raise GeminiHttpError(error.code, model, detail) from error
                retry_after = error.headers.get("Retry-After")
                match = re.search(r"retry\s+in\s+([0-9.]+)s", detail, re.IGNORECASE)
                if retry_after:
                    try:
                        retry_wait = float(retry_after)
                    except ValueError:
                        pass
                if retry_wait is None and match:
                    retry_wait = float(match.group(1))
            if attempt == max_attempts - 1:
                raise GeminiHttpError(error.code, model, detail, retry_wait) from error
        except (TimeoutError, urllib.error.URLError) as error:
            reason = getattr(error, "reason", error)
            is_timeout = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
            status = 408 if is_timeout else 503
            detail = (
                "The network read timed out."
                if is_timeout else f"Network error while reading Gemini response: {reason}"
            )
            # Move to the next configured model immediately. Retrying a long timed-out generation on the same
            # model wastes several minutes and gives no additional resilience.
            raise GeminiHttpError(status, model, detail) from error
        except Exception as error:
            if isinstance(error, GeminiHttpError):
                raise
            if attempt == max_attempts - 1:
                raise GeminiHttpError(502, model, f"Invalid or interrupted stream: {type(error).__name__}") from error
        if attempt < max_attempts - 1:
            exponential_wait = min(5 * (2 ** attempt), 60)
            time.sleep(min(max(exponential_wait, (retry_wait or 0) + 1), 180))
    raise RuntimeError(f"Gemini model {model} request failed")


def extract_complete_prefix(text):
    """Recover fully received JSON objects when the provider cuts off the array."""
    text = text.lstrip()
    if not text.startswith("["):
        return []
    decoder = json.JSONDecoder()
    rows = []
    position = 1
    while position < len(text):
        while position < len(text) and text[position] in " \r\n\t,":
            position += 1
        try:
            row, position = decoder.raw_decode(text, position)
        except ValueError:
            break
        if not isinstance(row, dict) or not all(key in row for key in ("id", "text", "source_ids")):
            break
        rows.append(row)
    return rows


def request_gemini_json(prompt, api_key, model, max_output_tokens, temperature, source_references=False):
    properties = {
        "id": {"type": "integer"},
        "text": {"type": "string"},
    }
    required = ["id", "text"]
    if source_references:
        properties = {
            "id": {"type": "integer"},
            "video_english": {"type": "string"},
            "source_ids": {"type": "array", "items": {"type": "integer", "minimum": 0}},
            "text": {"type": "string"},
        }
        required = list(properties)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
            "responseJsonSchema": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        },
    }
    failures = []
    for candidate in configured_models(model):
        started = time.monotonic()
        received = 0
        stopped = threading.Event()

        def report_progress():
            while not stopped.wait(15):
                elapsed = int(time.monotonic() - started)
                phase = f"응답 {received:,}자 수신" if received else "첫 응답 대기"
                record_event("progress", model=candidate, elapsed_seconds=elapsed, received_characters=received)
                print(
                    f"LILAC_PROGRESS\t2\t3\tGemini {candidate}: {phase} · {elapsed}초 경과",
                    file=sys.stderr, flush=True,
                )

        def on_chunk(size):
            nonlocal received
            received = size

        print(f"LILAC_PROGRESS\t2\t3\tGemini {candidate} 응답을 기다리고 있어요…", file=sys.stderr, flush=True)
        heartbeat = threading.Thread(target=report_progress, daemon=True)
        heartbeat.start()
        try:
            response_text = request_with_keys(payload, api_key, candidate, on_chunk=on_chunk)
            try:
                parsed = extract_json(response_text)
            except (ValueError, json.JSONDecodeError) as error:
                preview = re.sub(r"\s+", " ", response_text)[:240]
                failures.append(
                    GeminiHttpError(502, candidate, f"Invalid subtitle JSON: {error}. Preview: {preview}")
                )
                continue
            return json.dumps(parsed, ensure_ascii=False)
        except GeminiHttpError as error:
            failures.append(error)
            record_event("model_failed", model=candidate, status=error.status,
                         detail=error.detail.replace(api_key, "[REDACTED]")[:1500] if api_key else error.detail[:1500])
            # Capacity, transient server errors and per-model quotas are exactly what fallbacks are for.
            if error.status not in (408, 429, 500, 502, 503, 504):
                raise
        finally:
            stopped.set()
            heartbeat.join(timeout=1)
    summary = "; ".join(f"{error.model}=HTTP {error.status}" for error in failures)
    detail = failures[-1].detail[:1200] if failures else "no model attempted"
    if failures and all(error.status == 429 for error in failures):
        raise RuntimeError(f"Gemini HTTP 429: All configured models exhausted their quota ({summary}). {detail}")
    if failures and all(error.status == 502 and "Invalid subtitle JSON" in error.detail for error in failures):
        raise RuntimeError(f"Gemini models returned invalid subtitle JSON ({summary}). {detail}")
    raise RuntimeError(f"All Gemini models failed ({summary}). Last response: {detail}")


def save_translation_draft(path, rows):
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, target)


def validate_translations(rows, video_count, source_count):
    by_id = {}
    for row in rows:
        cue_id = row.get("id")
        text = row.get("text")
        source_ids = row.get("source_ids")
        if type(cue_id) is not int or not 0 <= cue_id < video_count or cue_id in by_id:
            raise ValueError(f"Invalid or duplicate video subtitle id: {cue_id}")
        if not isinstance(text, str) or not isinstance(source_ids, list):
            raise ValueError(f"Invalid translation fields for video subtitle {cue_id}")
        if any(type(i) is not int or not 0 <= i < source_count for i in source_ids):
            raise ValueError(f"Invalid Japanese source ids for video subtitle {cue_id}")
        text = text.strip()
        if bool(text) != bool(source_ids):
            raise ValueError(f"Subtitle {cue_id} must have both Japanese sources and text, or neither")
        by_id[cue_id] = {"id": cue_id, "text": text, "source_ids": source_ids}
        if "video_english" in row:
            by_id[cue_id]["video_english"] = row["video_english"]
    return by_id


def build_translation_prompt(items, english_items, anime_title, episode_number, japanese_source):
    instructions = Path(__file__).with_name("subtitle_translation_prompt.txt").read_text(encoding="utf-8")
    context = {"anime_title": anime_title, "episode": episode_number, "japanese_release": japanese_source}
    return (
        instructions + "\nEPISODE:\n" + json.dumps(context, ensure_ascii=False)
        + "\nJAPANESE_SOURCE:\n" + json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        + "\nVIDEO_CUES:\n" + json.dumps(english_items, ensure_ascii=False, separators=(",", ":"))
    )


def same_video_reference(reference, expected):
    if not isinstance(reference, str):
        return False
    speaker_prefix = r"^\[[A-Z][A-Z0-9 .'-]{0,40}\]\s+"
    if re.match(speaker_prefix, reference) and re.match(speaker_prefix, expected):
        return reference.split() == expected.split()
    # Matching-only normalization: never edit Japanese originals or translated dialogue.
    def variants(value):
        plain = " ".join(value.split())
        without_speaker = re.sub(speaker_prefix, "", plain)
        return {plain, without_speaker} if without_speaker else {plain}
    return bool(variants(reference) & variants(expected))


def usable_episode_rows(rows, english_items, source_count):
    valid = []
    for row in rows:
        try:
            validate_translations([row], len(english_items), source_count)
            reference = row.get("video_english")
            if reference is not None and (
                not same_video_reference(reference, english_items[row["id"]]["english"])
            ):
                continue
        except (ValueError, TypeError, AttributeError):
            continue
        valid.append(row)
    return valid


def request_translation(items, english_items, api_key, model, anime_title, episode_number, japanese_source):
    prompt = build_translation_prompt(items, english_items, anime_title, episode_number, japanese_source)
    draft_path = os.environ.get("LILAC_TRANSLATION_DRAFT_PATH", "").strip()
    matching_saved_prompt = False
    if draft_path:
        prompt_path = Path(draft_path).with_suffix(".prompt.txt")
        matching_saved_prompt = prompt_path.is_file() and prompt_path.read_text(encoding="utf-8") == prompt
        prompt_path.parent.mkdir(parents=True, exist_ok=True)
        prompt_path.write_text(prompt, encoding="utf-8")
    saved = None
    if draft_path and Path(draft_path).is_file():
        try:
            saved = json.loads(Path(draft_path).read_text(encoding="utf-8"))
            saved = usable_episode_rows(saved, english_items, len(items))
            validate_translations(saved, len(english_items), len(items))
        except (ValueError, TypeError, AttributeError):
            saved = None
    if saved is None:
        saved = extract_json(request_gemini_json(
            prompt, api_key, model, 65536, 0.2, source_references=True
        ))
        saved = usable_episode_rows(saved, english_items, len(items))
        save_translation_draft(draft_path, saved)
    by_id = validate_translations(saved, len(english_items), len(items))
    # Reuse valid rows previously rejected by strict English-label comparison, but only for identical inputs.
    if matching_saved_prompt:
        draft = Path(draft_path)
        responses = sorted(draft.parent.glob(draft.stem + ".*.response.txt"), key=lambda p: p.stat().st_mtime, reverse=True)
        for response in responses:
            try:
                recovered = usable_episode_rows(extract_json(response.read_text(encoding="utf-8")), english_items, len(items))
                for row in recovered:
                    by_id.setdefault(row["id"], row)
            except (ValueError, TypeError, AttributeError):
                continue
        save_translation_draft(draft_path, [by_id[i] for i in sorted(by_id)])
    missing = [item["id"] for item in english_items if item["id"] not in by_id]
    stalled = 0
    for round_number in range(1, 7):
        if not missing:
            break
        print(f"LILAC_PROGRESS\t2\t3\t전체 {len(english_items)}개 중 {len(by_id)}개 저장 · 남은 {len(missing)}개 보완 중 ({round_number}차)…",
              file=sys.stderr, flush=True)
        repair_prompt = (
            prompt + "\n완료된 결과:\n" + json.dumps([by_id[i] for i in sorted(by_id)], ensure_ascii=False)
            + "\n이번에 작성할 VIDEO_CUES:\n" + json.dumps([item for item in english_items if item["id"] in missing], ensure_ascii=False)
            + "\n위 대상의 객체만 작성한다. 완료된 결과와 명칭·말투를 일치시킨다. "
              "대응하는 일본어 발화가 여러 영상 구간에 걸치면 각 구간의 발화만 나누어 번역한다. "
              "대응 원문이 있으면 source_ids와 text를 함께 작성하고, 찾지 못한 경우에만 둘 다 빈 값으로 반환한다."
        )
        repaired = extract_json(request_gemini_json(
            repair_prompt, api_key, model, 65536, 0.2, source_references=True
        ))
        additions = validate_translations(usable_episode_rows(repaired, english_items, len(items)), len(english_items), len(items))
        by_id.update({i: row for i, row in additions.items() if i in missing})
        save_translation_draft(draft_path, [by_id[i] for i in sorted(by_id)])
        remaining = [item["id"] for item in english_items if item["id"] not in by_id]
        stalled = stalled + 1 if len(remaining) == len(missing) else 0
        record_event("repair_progress", round=round_number, saved=len(by_id), remaining=len(remaining))
        missing = remaining
        if stalled >= 2:
            break
    if missing:
        raise ValueError(f"자막 {len(by_id)}/{len(english_items)}개 저장 완료. 남은 {len(missing)}개의 응답이 불완전합니다. 다시 선택하면 남은 부분만 재개합니다. ids: {missing[:8]}")
    rows = [by_id[item["id"]] for item in english_items]
    if not any(row["text"] for row in rows):
        raise ValueError("Gemini could not match any video dialogue to Japanese source")
    return rows


def translated_video_cues(english_cues, rows):
    return [
        {"start": english_cues[row["id"]]["start"], "end": english_cues[row["id"]]["end"],
         "text": row["text"]}
        for row in rows if row["text"]
    ]


def wrap_korean(text, limit=32):
    text = re.sub(r"[ \t]+", " ", text).strip()
    existing = [line.strip() for line in text.splitlines() if line.strip()]
    words = " ".join(existing).split()
    if not words:
        return text
    lines, current = [], ""
    for word in words:
        candidate = word if not current else current + " " + word
        if current and len(candidate) > limit:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) <= 2:
        return "\n".join(lines)
    midpoint = max(1, len(words) // 2)
    return " ".join(words[:midpoint]) + "\n" + " ".join(words[midpoint:])


def render_vtt(cues):
    output = ["WEBVTT", ""]
    for index, cue in enumerate(cues, 1):
        output.extend(
            [str(index), f"{cue['start']} --> {cue['end']}", wrap_korean(cue["text"]), ""]
        )
    return "\n".join(output)


def main():
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip()
    anime_title = os.environ.get("LILAC_ANIME_TITLE", "").strip()
    episode_number = os.environ.get("LILAC_EPISODE_NUMBER", "").strip()
    if not configured_api_keys(api_key):
        raise RuntimeError("GEMINI_API_KEY / GEMINI_API_KEYS is empty")
    japanese_path = None
    if "--japanese" in sys.argv:
        index = sys.argv.index("--japanese")
        if index + 1 < len(sys.argv):
            japanese_path = sys.argv[index + 1]
    english_cues = parse_subtitles(decode_subtitle(sys.stdin.buffer.read()))
    if not english_cues:
        raise RuntimeError("No video-timed English reference subtitle was found")

    # Send the complete episode in one request. This gives Gemini the full story
    # context and avoids inconsistent names/speech levels across artificial chunks.
    japanese_cues = []
    if japanese_path:
        with open(japanese_path, "rb") as file:
            japanese_cues = parse_subtitles(decode_subtitle(file.read()))
    if not japanese_cues:
        raise RuntimeError("No Japanese source subtitle was found; English fallback is disabled")

    items = []
    for index, cue in enumerate(japanese_cues):
        item = {"id": index, "start": cue["start"], "end": cue["end"], "japanese": cue["text"]}
        if cue.get("speaker"):
            item["speaker"] = cue["speaker"]
        items.append(item)
    english_items = [
        {"id": index, "start_seconds": round(time_seconds(cue["start"]), 3),
         "end_seconds": round(time_seconds(cue["end"]), 3), "english": cue["text"]}
        for index, cue in enumerate(english_cues)
    ]
    print("LILAC_PROGRESS\t2\t3\t영상의 대사 구간에 맞춰 일본어 원문을 번역하고 있어요…", file=sys.stderr, flush=True)
    rows = request_translation(
        items, english_items, api_key, model, anime_title, episode_number,
        os.environ.get("LILAC_JAPANESE_SOURCE", "").strip(),
    )
    print("LILAC_PROGRESS\t3\t3\t한국어 자막 파일을 만들고 있어요…", file=sys.stderr, flush=True)
    sys.stdout.write(render_vtt(translated_video_cues(english_cues, rows)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        record_event("failed", message=redact_keys(str(error))[:2000])
        print(f"Gemini subtitle translation failed: {redact_keys(str(error))}", file=sys.stderr)
        sys.exit(1)
