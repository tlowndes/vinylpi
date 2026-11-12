"""Recognise a record from a photo of its cover with Claude vision."""
import base64
import json

MODEL = "claude-opus-5-5"
PROMPT = (
    "This is a phone photo of a vinyl record sleeve. Identify the release: the artist and album title. "
    "Use the artwork as well as any printed text; many classic covers have no text at all. "
    "If you can't tell, leave artist and title empty and set confidence to low. "
    "In search, give the best short query to find it on MusicBrainz (artist and title)."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "artist": {"type": "string"},
        "title": {"type": "string"},
        "year": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "search": {"type": "string"},
    },
    "required": ["artist", "title", "year", "confidence", "search"],
    "additionalProperties": False,
}


class CoverError(Exception):
    pass


def identify(jpeg_bytes, api_key):
    if not api_key:
        raise CoverError("Add your Anthropic API key in Settings to use cover scan.")
    try:
        import anthropic
    except ImportError as exc:
        raise CoverError("Cover scan isn't installed yet. Run an update from Settings.") from exc

    client = anthropic.Anthropic(api_key=api_key, timeout=60, max_retries=2)
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",  # if a safety check declines, the API retries on another model
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.standard_b64encode(jpeg_bytes).decode()}},
                {"type": "text", "text": PROMPT},
            ]}],
        )
    except anthropic.AuthenticationError as exc:
        raise CoverError("Anthropic didn't accept the API key. Check it in Settings.") from exc
    except anthropic.PermissionDeniedError as exc:
        raise CoverError("That API key can't use this model. Check your Anthropic account.") from exc
    except anthropic.RateLimitError as exc:
        raise CoverError("Too many scans at once, or your Anthropic credit has run out. Try again shortly.") from exc
    except anthropic.APIStatusError as exc:
        raise CoverError(f"Anthropic returned an error ({exc.status_code}). Try again.") from exc
    except anthropic.APIConnectionError as exc:
        raise CoverError("Couldn't reach Anthropic. Is the Pi online?") from exc

    if resp.stop_reason == "refusal":
        raise CoverError("Claude couldn't help with that photo. Try search instead.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise CoverError("Couldn't read Claude's answer. Try again.") from exc
    return {k: str(data.get(k, "")).strip() for k in SCHEMA["properties"]}
