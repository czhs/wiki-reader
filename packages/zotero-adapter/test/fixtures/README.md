# Zotero local API fixtures

Recorded from a live Zotero 7.0.32 local API (`http://127.0.0.1:23119/api/users/0/...`)
so that mapping and duplicate-prevention tests run against the **real wire format** rather
than an invented one.

- `items-top.json` — `GET /items/top?limit=8`
- `collections.json` — `GET /collections?limit=10`
- `tags.json` — `GET /tags?limit=15`

These contain bibliographic metadata only: no file bytes, no attachment contents, no
credentials. The library user ID has been replaced with `000000`; the record *shape* is
otherwise unmodified.

Re-record with:

```bash
B=http://127.0.0.1:23119/api/users/0
curl -s "$B/items/top?limit=8"   -o items-top.json
curl -s "$B/collections?limit=10" -o collections.json
curl -s "$B/tags?limit=15"        -o tags.json
```

Then re-run the scrub step before committing.
