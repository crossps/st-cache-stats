# Cache Stats

SillyTavern does not persist Anthropic, OpenAI-style, or Gemini prompt-cache usage on
chat messages. Cache Stats captures that usage during generation, stores it on
the assistant message, and adds a database icon to the message-actions row.

The icon's colour shows the result at a glance: **green** (glowing) when the
reply wrote to the cache, which is the usual Claude case of reading the cached
prefix and writing the new turn; **yellow** (glowing) when it only read; plain
for a reported miss; dim when there's no data. Tap the icon to see cache hit rate, cache reads, cache
writes, uncached input, and output for that reply.

Older messages stay blank until you generate or swipe again because their usage
data is no longer available.

## Install

In SillyTavern, open **Extensions → Install extension** and paste:

```
https://github.com/crossps/st-cache-stats
```

Enable **Cache Stats**, then reload SillyTavern. Your next generation or swipe
will record statistics. The extension works on desktop and Android installs.

Cache Stats only observes and records usage. It does not change cache duration,
provider settings, endpoints, or request behavior.

## What it captures

- Anthropic SSE `message_start` and `message_delta` usage, including
  `cache_read_input_tokens`, `cache_creation_input_tokens`, and separate 5-minute
  and 1-hour writes when reported
- OpenAI-style `prompt_tokens_details.cached_tokens` when supplied by the backend
  (`prompt_tokens` already includes cached tokens, so they are not double-counted)
- Gemini (Google AI Studio and Vertex AI) `usageMetadata.cachedContentTokenCount`
  from SillyTavern's streamed Gemini responses. Gemini's implicit caching has no
  write step, so Gemini replies show reads only; a reply with no cached tokens is
  a miss. Output includes thinking tokens
- Non-streaming usage objects returned as JSON

Quiet and impersonate generations are skipped, and their usage can never land
on a visible reply. Usage that arrives after SillyTavern finishes the generation
is still attached to that reply. Statistics are stored in
`message.extra.cache_usage` and the corresponding swipe extra, so they travel
with the chat file.
