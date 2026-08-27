# Cache Stats

SillyTavern does not persist Anthropic (or OpenAI-style) prompt-cache usage on
chat messages. Cache Stats captures that usage during generation, stores it on
the assistant message, and adds a database icon to the message-actions row.

Tap the icon to see cache hit rate, cache reads, cache writes, uncached input,
and output for that reply.

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
- Non-streaming usage objects returned as JSON

Quiet and impersonate generations are skipped. Statistics are stored in
`message.extra.cache_usage` and the corresponding swipe extra, so they travel
with the chat file.
