# Cache Stats

SillyTavern does not persist Anthropic (or OpenAI-style) prompt-cache usage on
chat messages. This extension tees the generate stream, reads cache hit / write
from the reply, stores it on that message, and puts a database icon on the
message-actions row.

Tap the icon to see hit rate, cache read, cache write, uncached input, and
output for **that** reply.

Older messages stay blank until you generate or swipe again — there is nothing
to recover after the fact.

## Install

In SillyTavern: **Extensions → Install extension**, paste:

```
https://github.com/crossps/st-cache-stats
```

Enable **Cache Stats**, then refresh. The next generate or swipe records stats.

Works on PC and phone installs the same way. In **Extensions → Cache Stats**, choose the prompt-cache policy used by the Claude Creative Writing Proxy's normal SillyTavern route:

- **Off** — avoids cache-write charges for highly dynamic cards and lorebooks
- **5 minutes** — cheaper writes for active sessions
- **1 hour** — best for stable prompts reused after longer pauses

The extension normally detects the active custom proxy URL from the next generation. You can also enter the proxy URL manually. It synchronizes the selected policy before each generation; the separate JanitorAI cache choice is not changed.

## What it captures

- Anthropic SSE `message_start` / `message_delta` usage (`cache_read_input_tokens`, `cache_creation_input_tokens`, 5m / 1h writes)
- OpenAI-style `prompt_tokens_details.cached_tokens` when that is what the backend returns

Quiet / impersonate generations are skipped. Stats live on `message.extra.cache_usage` (and the matching swipe extra), so they travel with the chat file.
